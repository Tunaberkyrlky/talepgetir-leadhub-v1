/**
 * harvest:run (Y1 list-harvest) — the CAPPED instrumented pilot.
 *
 * For ONE approved ICP × ONE geography, under HARD caps with a full cost ledger:
 *   discovery (grounded search → candidates) → canonicalize + dedup vs the ledger + drop
 *   suppressed → fetch each fresh candidate's site (cache-first) → validate against the ICP
 *   (evidence-bound) → write company + verdict → bill each MATCH via research_bill_match.
 *
 * The point is to measure REAL COGS per MATCH lead before scaling. Every external call is
 * costed (research_search_log + the job result cost breakdown). Hitting any cap is a graceful
 * stop with a partial summary — the job still succeeds.
 *
 * Quota holds (064): the run reserves an estimate of its billable leads up-front (admission
 * control — refuses to start and burn COGS if the tenant has no available credit), caps billing
 * at the reservation so the balance can never go negative, settles the realized count on success,
 * and releases the remainder. A hard failure releases the whole reservation; a crashed worker's
 * stranded hold is freed by the worker's stale-hold reaper. Domainless Maps candidates can be
 * validated from grounded listing metadata; metadata-empty candidates remain parked as 'review'.
 *
 * Sub-ICP geo cell (WP2, optional): payload.geo_id targets an APPROVED research_geographies cell
 * of this ICP. Its spec feeds discovery (local-language terms + named directories) and validation
 * (localized signal cues), and companies written by the run carry the geo ref. Discovery-only —
 * billing stays keyed to (icp, ruleset_version), and a run without geo_id behaves exactly as before.
 */
import type { HandlerContext, JobHandler } from '../types.js';
import { createHash } from 'node:crypto';
import { researchSupabaseAdmin } from '../../supabase.js';
import { createLogger } from '../../../logger.js';
import { resolveCaps, CapTracker, type EngineCaps } from '../../engine/caps.js';
import { canonicalKey, normalizeDomain } from '../../engine/canonical.js';
import type { Candidate, GeoQuerySpec } from '../../engine/discovery.js';
import { webSearchSource, type CandidateSource, type PriorCellStats } from '../../engine/sources.js';
import { readCellChunk, updateChunkCoverageSafe, type ChunkRow } from '../../channels/coverage.js';
import { fetchPage, cachedPageContent } from '../../engine/fetch.js';
import { prepareMapsEvidence, validateCompany, validateCompanyFromMaps } from '../../engine/validate.js';
import { costOfLlm, costOfFetch, costFromUsageSummary, PRICING_VERSION } from '../../engine/pricing.js';
import { withLlmMeter, type MeteredError } from '../../llm/meter.js';
import {
    upsertCompany,
    persistVerdict,
    billMatch,
    existingCompanies,
    companiesWithCurrentVerdict,
    shouldRevalidateEvidence,
    suppressedCanonicalKeys,
    unbilledMatchVerdicts,
    creditBalance,
    tenantResearchSettings,
    reserveHold,
    settleHold,
    releaseHold,
    InsufficientCreditsError,
    ReservationExhaustedError,
    SuppressedError,
    type HoldRow,
    type ExistingCompany,
    type PersistedVerdict,
} from '../../engine/ledger.js';

const log = createLogger('research:handler:harvest');

// Up-front reservation per run (admission control). Capped to the run's maxCandidates (can't bill
// more matches than candidates processed) AND to what's actually available. Sized per tenant TIER
// (073 settings: explicit reserve_estimate > tier default > env default) — a Scale tenant's run
// may reserve more headroom than a Trial's, keeping concurrency fairness proportional to plan.
const RESERVE_ESTIMATE_DEFAULT = Number(process.env.RESEARCH_RESERVE_ESTIMATE) || 25;
const TIER_RESERVE: Record<string, number> = { trial: 10, starter: 25, growth: 50, scale: 100, custom: 25 };

// Cross-ICP re-scoring (A.3): the dedup gate is now "(company, icp, ruleset) has a verdict?", not
// "company exists?". An existing firm surfaced by discovery that has NO current verdict for THIS ICP
// is re-scored from its CACHED site text (no re-fetch) instead of being skipped — closing the gap
// where dedup hid a billable match under a new/edited ICP. Off ('0') → legacy skip-all-existing.
const RESCORE_EXISTING = (process.env.RESEARCH_RESCORE_EXISTING ?? '1') !== '0';

interface IcpRow {
    id: string;
    name: string;
    segment: string | null;
    signals: string[];
    negative_signals: string[];
    elimination_rules: string[];
    status: string;
    ruleset_version: number;
}

interface CanonCandidate extends Candidate {
    canonicalKey: string;
}

export async function runHarvest({ job, heartbeat }: HandlerContext, source: CandidateSource): Promise<Record<string, unknown>> {
    const tenantId = job.tenant_id;
    const projectId = job.project_id;
    const icpId = typeof job.payload?.icp_id === 'string' ? job.payload.icp_id : null;
    const geoId = typeof job.payload?.geo_id === 'string' ? job.payload.geo_id : null;
    let geography = typeof job.payload?.geography === 'string' ? job.payload.geography.trim() : '';
    if (!icpId) throw new Error('harvest:run requires payload.icp_id');
    // A geo-cell run may omit free-text geography (it defaults to the cell's country below).
    if (!geography && !geoId) throw new Error('harvest:run requires payload.geography');

    // Load the ICP and HARD-require it be approved at its current ruleset — billing later
    // refuses anything else, so harvesting an unapproved ICP would burn COGS for nothing.
    const { data: icp, error: icpErr } = await researchSupabaseAdmin
        .from('research_icps')
        .select('id, name, segment, signals, negative_signals, elimination_rules, status, ruleset_version')
        .eq('id', icpId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (icpErr) throw icpErr;
    if (!icp) throw new Error(`harvest:run: ICP ${icpId} not found for tenant ${tenantId}`);
    const icpRow = icp as IcpRow;
    if (icpRow.status !== 'approved') {
        throw new Error(`harvest:run: ICP ${icpId} is '${icpRow.status}', not 'approved' (approve it first)`);
    }

    // ── Sub-ICP geo cell (WP2, optional) ─────────────────────────────────────
    // A run may target an APPROVED geography cell of this ICP instead of free-text geography.
    // The route gated this at enqueue time, but the payload is minutes old by now — re-check
    // tenant/ICP/approval here (a re-analysis demotes the cell back to draft). The cell's spec
    // feeds DISCOVERY + validation context only: a missing/malformed spec degrades to the
    // free-text behavior with a warning — it never fails the run.
    let geoSpec: GeoQuerySpec | undefined;
    let localizedSignals: string[] = [];
    let localizedNegativeSignals: string[] = [];
    let cellEstimate: number | null = null;
    if (geoId) {
        const { data: geo, error: geoErr } = await researchSupabaseAdmin
            .from('research_geographies')
            .select('id, icp_id, country, status, spec, estimate')
            .eq('id', geoId)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (geoErr) throw geoErr;
        if (!geo) throw new Error(`harvest:run: geography cell ${geoId} not found for tenant ${tenantId}`);
        if (geo.icp_id !== icpId) {
            throw new Error(`harvest:run: geography cell ${geoId} belongs to a different ICP (expected ${icpId})`);
        }
        if (geo.status !== 'approved') {
            throw new Error(`harvest:run: geography cell ${geoId} is '${geo.status}', not 'approved' (approve it first)`);
        }
        // The cell's country IS the geography of a geo-run (review P3): honoring a mismatching
        // free-text value alongside geo_id would drive queries at one country with another's
        // local terms — always take the cell's.
        const cellCountry = typeof geo.country === 'string' ? geo.country.trim() : '';
        if (cellCountry) geography = cellCountry;
        cellEstimate = typeof geo.estimate === 'number' ? geo.estimate : null;

        // Narrow STRUCTURAL pick of the spec — the engine consumes only these fields, and the
        // full zod contract belongs to the geo module. Anything malformed is simply dropped.
        const spec = geo.spec as Record<string, unknown> | null;
        if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
            const strings = (v: unknown): string[] =>
                Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [];
            geoSpec = {
                local_terms: strings(spec.local_terms),
                directories: Array.isArray(spec.directories)
                    ? spec.directories.filter(
                          (d): d is { name: string; url?: string } =>
                              !!d && typeof d === 'object' && typeof (d as { name?: unknown }).name === 'string'
                      )
                    : [],
            };
            localizedSignals = strings(spec.localized_signals);
            localizedNegativeSignals = strings(spec.localized_negative_signals);
        } else {
            log.warn({ jobId: job.id, geoId }, 'geo cell has no usable spec — proceeding with free-text discovery behavior');
        }
    }
    if (!geography) throw new Error(`harvest:run: geography cell ${geoId} has no country and payload.geography is empty`);

    // ── Cumulative cell coverage (WP3): prior chunk stats seed the Y3 stop-condition ─────
    // Geo-cell runs only — a free-text run has no cell identity to accumulate under. The
    // chunk's composite angle keys ('3:directory_site_filter') collapse to plain angle
    // numbers for the saturation math. Read failures degrade to run-local behavior.
    let priorChunk: ChunkRow | null = null;
    let priorStats: PriorCellStats | undefined;
    if (geoId) {
        try {
            priorChunk = await readCellChunk(tenantId, icpId, geoId);
        } catch (err) {
            log.warn({ err, jobId: job.id, geoId }, 'cell chunk read failed — Y3 saturation runs without cumulative seed');
        }
        if (priorChunk) {
            const angleCounts: Record<string, number> = {};
            for (const [key, n] of Object.entries(priorChunk.angle_stats ?? {})) {
                const angle = key.split(':')[0];
                if (!angle || typeof n !== 'number') continue;
                angleCounts[angle] = (angleCounts[angle] ?? 0) + n;
            }
            priorStats = { queriesTotal: priorChunk.queries_total ?? 0, angleCounts };
        }
    }

    // The running attempt's fence identity — verdict persistence, billing and hold closing are all
    // lease-fenced (067): a claimed job always carries these, so their absence is a runner bug.
    const worker = job.locked_by;
    const lease = job.lease;
    if (!worker || !lease) {
        throw new Error(`harvest:run: job ${job.id} has no running lease (locked_by/lease missing) — refusing unfenced writes`);
    }

    const caps: EngineCaps = resolveCaps(job.payload?.caps as Partial<EngineCaps> | undefined);
    const tracker = new CapTracker(caps);
    const sourcePath = source.sourcePath ?? 'Y1';

    // ── Admission control: reserve quota up-front ────────────────────────────
    // Refuse to start (and burn COGS) if the tenant has no available credit. The reservation is the
    // HARD billing cap for this run: research_bill_match consumes one unit of this hold per fresh
    // charge and REFUSES once it is exhausted (so the balance can never go negative — the bill floor
    // is the last-resort backstop). Estimate is capped to maxCandidates (can't bill more than we
    // process) and, in the RPC, to what is actually available. The reserve is OUTSIDE the try below:
    // on refusal there is no hold to free.
    const settings = await tenantResearchSettings(tenantId);
    const tierEstimate =
        settings?.reserveEstimate ??
        (settings ? TIER_RESERVE[settings.researchTier] ?? RESERVE_ESTIMATE_DEFAULT : RESERVE_ESTIMATE_DEFAULT);
    const reserveEstimate = Math.max(1, Math.min(caps.maxCandidates, tierEstimate));
    let hold: HoldRow;
    try {
        hold = await reserveHold({ tenantId, jobId: job.id, estimate: reserveEstimate, minRequired: 1 });
    } catch (e) {
        if (e instanceof InsufficientCreditsError) {
            throw new Error(`harvest:run: insufficient research credits — reserve refused (top up before running). ${e.message}`);
        }
        throw e;
    }

    try {
        // Meter every LLM call this run makes (discovery's two calls per query + each validation +
        // any runLlmJson retry) so the pilot keeps the RAW per-provider token tally — COGS can then
        // be recomputed against real invoices with corrected rates, no re-run. The dollar CapTracker
        // still enforces the live spend cap; the meter is the audit trail for calibration.
        const { result: built, usage } = await withLlmMeter(async () => {
        const balanceBefore = await creditBalance(tenantId);

        // ── Discovery (source-specific: web search OR maps scrape) ─────────────────
        // The ONLY source-dependent step. The source counts its own queries + adds its own search
        // cost to the tracker and logs its per-tenant COGS; everything below is source-agnostic.
        const { candidates: rawCandidates, queriesRun, meta: sourceMeta } = await source.gather({
            icp: icpRow, geography, geoSpec, priorStats, caps, tracker, heartbeat,
            tenantId, projectId, jobId: job.id, worker, lease,
        });

        // ── Canonicalize + within-run dedup ──────────────────────────────────────
        const canon: CanonCandidate[] = [];
        const seen = new Set<string>();
        for (const c of rawCandidates) {
            let key: string;
            try {
                key = canonicalKey({ domain: c.domain, name: c.name, country: c.country, city: c.city });
            } catch {
                continue; // no usable identity → drop
            }
            if (seen.has(key)) continue;
            seen.add(key);
            canon.push({ ...c, canonicalKey: key });
        }

        // ── Classify vs the permanent ledger: new / re-score / dedup ─────────────
        // Dedup is now "(company, icp, ruleset) already has a verdict?", NOT "company exists?":
        //   • new firm (not in registry)                        → full fetch + validate (primary path)
        //   • existing firm, NO current verdict for this ICP     → cheap re-score from cached text
        //   • existing firm, HAS a current verdict               → truly skipped (deduped)
        // Suppressed keys are dropped first (KVKK > dedup). Re-score is gated behind RESCORE_EXISTING.
        const allKeys = canon.map((c) => c.canonicalKey);
        const [existingMap, suppressed] = await Promise.all([
            existingCompanies(tenantId, allKeys),
            suppressedCanonicalKeys(tenantId, allKeys),
        ]);
        const existingIds = [...existingMap.values()].map((c) => c.id);
        // When re-scoring is OFF, legacy open-web discovery skips all existing firms. Sources that
        // explicitly fetch existing seeded companies (trade imports) still need the verdict lookup.
        const shouldLookupCurrentVerdict = RESCORE_EXISTING || source.fetchExisting === true;
        const currentVerdicts = shouldLookupCurrentVerdict
            ? await companiesWithCurrentVerdict({ tenantId, icpId, rulesetVersion: icpRow.ruleset_version, companyIds: existingIds })
            : new Map(existingIds.map((id) => [id, { evidenceSource: null, evidenceHash: null }]));

        const mapsHash = (c: Candidate): string | null => {
            const evidence = prepareMapsEvidence({ description: c.mapsDescription, category: c.mapsCategory });
            return evidence ? createHash('sha256').update(evidence.text).digest('hex') : null;
        };
        const needsVerdict = (c: CanonCandidate, existing: ExistingCompany | undefined): boolean => {
            if (!existing) return true;
            const current = currentVerdicts.get(existing.id);
            return shouldRevalidateEvidence(current, {
                hasWebsite: Boolean(c.domain), source: source.name, mapsEvidenceHash: mapsHash(c),
            });
        };

        const fresh = canon.filter((c) => {
            if (suppressed.has(c.canonicalKey)) return false;
            const existing = existingMap.get(c.canonicalKey);
            if (!existing) return true;
            const current = currentVerdicts.get(existing.id);
            const websiteSupersedesMaps = Boolean(c.domain) && current?.evidenceSource === 'maps';
            return needsVerdict(c, existing) && (source.fetchExisting === true || websiteSupersedesMaps);
        });
        const freshKeys = new Set(fresh.map((c) => c.canonicalKey));
        const reScoreTargets: ExistingCompany[] = RESCORE_EXISTING
            && source.fetchExisting !== true
            ? canon
                .filter((c) => !suppressed.has(c.canonicalKey))
                .filter((c) => !freshKeys.has(c.canonicalKey))
                .map((c) => existingMap.get(c.canonicalKey))
                .filter((e): e is ExistingCompany => e !== undefined)
                .filter((e) => {
                    const c = canon.find((candidate) => candidate.canonicalKey === e.canonicalKey);
                    return c ? needsVerdict(c, e) : false;
                })
            : [];
        const skippedCurrentVerdict = [...existingMap.values()].filter(
            (e) => !suppressed.has(e.canonicalKey) && currentVerdicts.has(e.id)
        ).length;

        // Approved offer angles (WP4): read once per run — the SAME validation pass then returns
        // hooks + angle_suggestion for MATCH firms (no extra fetch or LLM call). A failed
        // read degrades to validation without the angle map — never fails the paid run.
        let approvedAngles: Array<{ code: string; value_prop: string }> = [];
        {
            const { data: offerRows, error: offErr } = await researchSupabaseAdmin
                .from('research_offers')
                .select('angle_code, value_prop')
                .eq('tenant_id', tenantId)
                .eq('icp_id', icpId)
                .eq('status', 'approved')
                // Deterministic map (review P3): without an order the >10 truncation would be an
                // arbitrary Postgres subset that changes run to run.
                .order('created_at', { ascending: true })
                .limit(10);
            if (offErr) {
                log.warn({ err: offErr, jobId: job.id }, 'approved offers read failed — validating without the angle map');
            } else {
                approvedAngles = ((offerRows ?? []) as Array<{ angle_code: string; value_prop: string }>)
                    .map((o) => ({ code: o.angle_code, value_prop: o.value_prop }));
            }
        }

        // ICP fields the validator scores against (shared by the fetch path and the re-score path).
        // A geo-cell run also carries the cell's local-language cues into the validation prompt.
        const icpFields = {
            name: icpRow.name, segment: icpRow.segment,
            signals: icpRow.signals ?? [], negative_signals: icpRow.negative_signals ?? [],
            elimination_rules: icpRow.elimination_rules ?? [],
            localized_signals: localizedSignals.length > 0 ? localizedSignals : undefined,
            localized_negative_signals: localizedNegativeSignals.length > 0 ? localizedNegativeSignals : undefined,
            approved_angles: approvedAngles.length > 0 ? approvedAngles : undefined,
        };

        // ── Fetch → validate → persist → bill ────────────────────────────────────
        await heartbeat({ stage: 'validating', fresh: fresh.length, rescore: reScoreTargets.length });
        let matches = 0, partial = 0, eliminated = 0, review = 0;
        let fetchErrors = 0, suppressedAtWrite = 0, domainless = 0, processed = 0;
        let mapsMetadataValidations = 0, mapsDomainlessValidations = 0;
        let mapsUnreachableFallbacks = 0, mapsMetadataRefreshed = 0;
        // Cross-ICP re-score tally (subset of the verdicts above): rescored = re-scored existing firms,
        // rescoreMatches = matches among them, rescoreSkippedNoContent = existing firms with no cached
        // text to score (left for the enrichment phase).
        let rescored = 0, rescoreMatches = 0, rescoreSkippedNoContent = 0;
        // Jina (provider-billable) vs direct SSRF-guarded fallback (our own egress) network fetches.
        let jinaFetches = 0, directFetches = 0;
        // Set when research_bill_match refuses because the reservation is exhausted — the DB enforces
        // the cap, and we stop spending COGS on matches we cannot bill (so the balance can't go
        // negative). Not a local counter: billing is enforced server-side under the per-tenant lock.
        let reservationExhausted = false;

        // Bill one MATCH verdict against this run's reservation+lease. Returns true if the run must
        // STOP (reservation exhausted — the DB enforced the cap); throws on a real billing failure
        // (never swallow: a persisted match left unbilled is lost revenue). Idempotent + lease-fenced
        // + once-ever per canonical_key, so re-scoring a firm already billed under another ICP dedups
        // (no double charge, no hold consumed) rather than refusing.
        const billOne = async (verdictId: string): Promise<boolean> => {
            try {
                await billMatch({
                    verdictId, jobId: job.id, holdId: hold.id,
                    worker, lease,
                    amountUsd: 0, pricingVersion: PRICING_VERSION,
                });
                return false;
            } catch (e) {
                if (e instanceof ReservationExhaustedError) return true;
                throw e;
            }
        };

        // Persist a verdict through the fenced RPC and return the ROW OF RECORD — which is the
        // computed verdict except when the RPC preserved an existing BILLED match (immutable, 067);
        // tallies and billing decisions below use the returned row, never the local computation.
        const persistOne = async (
            companyId: string, verdict: Parameters<typeof persistVerdict>[0]['verdict'], model: string,
            evidenceSource: 'website' | 'maps', evidenceSnapshot: string
        ): Promise<PersistedVerdict> => {
            const persisted = await persistVerdict({
                tenantId, companyId, icpId, rulesetVersion: icpRow.ruleset_version,
                verdict, model, jobId: job.id, worker, lease,
                evidenceSource, evidenceSnapshot,
                evidenceHash: createHash('sha256').update(evidenceSnapshot).digest('hex'),
            });
            if (persisted.verdict !== verdict.verdict) {
                log.info(
                    { companyId, computed: verdict.verdict, persisted: persisted.verdict },
                    'persistVerdict preserved a billed match (immutable) — using the row of record'
                );
            }
            return persisted;
        };

        // Maps may resurface a company that already has a current verdict. Preserve the new public
        // listing metadata without changing its rollup status, per-ICP verdict, or billing state.
        // The common upsert intentionally advances last_checked_at: it records the latest public-source
        // observation, not only the last LLM verdict evaluation.
        if (source.name === 'maps') {
            for (const c of canon) {
                const existing = existingMap.get(c.canonicalKey);
                if (suppressed.has(c.canonicalKey) || !existing || !currentVerdicts.has(existing.id)) continue;
                if (c.mapsDescription == null && c.mapsCategory == null && c.phone == null && c.address == null) continue;
                try {
                    await upsertCompany({
                        tenantId, canonicalKey: c.canonicalKey, name: c.name,
                        phone: c.phone, address: c.address,
                        mapsDescription: c.mapsDescription, mapsCategory: c.mapsCategory,
                        status: null, jobId: job.id, worker, lease,
                    });
                    mapsMetadataRefreshed++;
                } catch (e) {
                    if (e instanceof SuppressedError) {
                        // Move the newly-suppressed key into the shared set: later passes skip it and
                        // the summary counts it once via suppressed.size (not again in suppressedAtWrite).
                        suppressed.add(c.canonicalKey);
                        continue;
                    }
                    throw e;
                }
            }
        }

        for (const c of fresh) {
            if (suppressed.has(c.canonicalKey)) continue;
            if (!tracker.canTakeCandidate()) break;
            tracker.countCandidate();
            const regDomain = normalizeDomain(c.domain);
            const mapsEvidence = source.name === 'maps'
                ? prepareMapsEvidence({ description: c.mapsDescription, category: c.mapsCategory })
                : null;
            let validation: Awaited<ReturnType<typeof validateCompany>>;
            let evidenceSource: 'website' | 'maps';
            let evidenceSnapshot: string;

            if (!regDomain) {
                domainless++;
                if (mapsEvidence) {
                    mapsMetadataValidations++;
                    mapsDomainlessValidations++;
                    validation = await validateCompanyFromMaps(
                        icpFields,
                        { name: c.name, domain: null, country: c.country },
                        mapsEvidence
                    );
                    evidenceSource = 'maps';
                    evidenceSnapshot = mapsEvidence.text;
                } else {
                    // No website and no meaningful listing evidence → deterministic review, no LLM cost.
                    try {
                        await upsertCompany({
                            tenantId, canonicalKey: c.canonicalKey, projectId,
                            domain: null, name: c.name, website: c.domain ?? null, country: c.country, city: c.city,
                            phone: c.phone, address: c.address,
                            mapsDescription: c.mapsDescription, mapsCategory: c.mapsCategory,
                            status: 'review', siteSummary: 'domainless candidate (no website resolved)',
                            icpId, geoId, sourcePath, channelId: source.channelId ?? null, jobId: job.id, worker, lease,
                        });
                        review++;
                    } catch (e) {
                        if (e instanceof SuppressedError) { suppressedAtWrite++; continue; }
                        throw e;
                    }
                    continue;
                }
            } else {
                if (!tracker.canFetch()) break;
                const page = await fetchPage(regDomain);
                // Count + cost ONLY a real network attempt — a cache hit is free and doesn't burn the cap.
                if (page.networkCall) {
                    tracker.countFetch(); // bounds total fetch work (Jina + direct fallback) against the cap
                    // Only Jina is provider-billable; the SSRF-guarded direct fallback ('fetch') and a
                    // failed attempt ('error') use our own egress (not Jina-billed). Charge + count Jina
                    // separately so COGS is correct if Jina's per-fetch rate (currently $0) goes non-zero.
                    if (page.method === 'jina') {
                        jinaFetches++;
                        tracker.addFetchCost(costOfFetch(page.cacheHit));
                    } else {
                        directFetches++;
                    }
                }

                if (page.content) {
                    // A readable first-party website remains authoritative; Maps metadata is stored but
                    // never mixed into this verdict or used as a second pass after an inconclusive result.
                    validation = await validateCompany(
                        icpFields,
                        { name: c.name, domain: regDomain, country: c.country },
                        page.content
                    );
                    evidenceSource = 'website';
                    evidenceSnapshot = page.content;
                } else if (mapsEvidence) {
                    fetchErrors++;
                    mapsMetadataValidations++;
                    mapsUnreachableFallbacks++;
                    validation = await validateCompanyFromMaps(
                        icpFields,
                        { name: c.name, domain: regDomain, country: c.country },
                        mapsEvidence
                    );
                    evidenceSource = 'maps';
                    evidenceSnapshot = mapsEvidence.text;
                } else {
                    // Empty site and no meaningful Maps evidence → deterministic review without LLM spend.
                    fetchErrors++;
                    try {
                        await upsertCompany({
                            tenantId, canonicalKey: c.canonicalKey, projectId,
                            domain: regDomain, name: c.name, website: c.domain ?? regDomain, country: c.country, city: c.city,
                            phone: c.phone, address: c.address,
                            mapsDescription: c.mapsDescription, mapsCategory: c.mapsCategory,
                            status: 'review', siteSummary: `site unreachable (status ${page.status})`, icpId, geoId, sourcePath,
                            channelId: source.channelId ?? null, jobId: job.id, worker, lease,
                        });
                        review++;
                    } catch (e) {
                        if (e instanceof SuppressedError) { suppressedAtWrite++; continue; }
                        throw e;
                    }
                    if (tracker.reasonToStop()) break;
                    continue;
                }
            }

            const { value: verdict, result } = validation;
            tracker.addLlmCost(costOfLlm(result));

            let companyId: string;
            try {
                const company = await upsertCompany({
                    tenantId, canonicalKey: c.canonicalKey, projectId,
                    domain: regDomain, name: c.name, website: c.domain ?? regDomain, country: c.country, city: c.city,
                    phone: c.phone, address: c.address,
                    mapsDescription: c.mapsDescription, mapsCategory: c.mapsCategory,
                    status: verdict.verdict, score: verdict.score,
                    siteSummary: verdict.summary || null, evidence: verdict.evidence,
                    eliminationReason: verdict.elimination_reason || null, icpId, geoId, sourcePath,
                    channelId: source.channelId ?? null, jobId: job.id, worker, lease,
                });
                companyId = company.id;
            } catch (e) {
                if (e instanceof SuppressedError) { suppressedAtWrite++; continue; }
                throw e;
            }

            // Fenced verdict write (067). A firm suppressed mid-run (after the discovery-time
            // pre-filter) is refused UNDER the lock — count + skip, exactly like the upsert path.
            let persisted: PersistedVerdict;
            try {
                persisted = await persistOne(companyId, verdict, result.model, evidenceSource, evidenceSnapshot);
            } catch (e) {
                if (e instanceof SuppressedError) { suppressedAtWrite++; continue; }
                throw e;
            }

            // Rollup repair (Workflow review P2): the rollup above was written with the COMPUTED
            // verdict BEFORE the row of record was known (the insert must precede the verdict FK).
            // If the persist RPC preserved a BILLED match instead (immutability guard — a sibling
            // run billed this firm inside our snapshot window), re-align the rollup to the row of
            // record so a paid lead can never look 'eliminated' in the customer-facing list.
            // Score compared too (a preserved row differs in score even when both are 'match') —
            // but only when the persisted score is non-NULL: the upsert RPC preserves-on-NULL
            // (COALESCE), so a NULL score cannot be written through anyway (codex; unreachable in
            // practice — the validator always scores). A mid-repair suppression is swallowed (the
            // firm is suppressed → hidden anyway; the verdict of record already persisted).
            if (persisted.verdict !== verdict.verdict || (persisted.score !== null && persisted.score !== verdict.score)) {
                try {
                    await upsertCompany({
                        tenantId, canonicalKey: c.canonicalKey, projectId,
                        domain: regDomain, name: c.name,
                        status: persisted.verdict, score: persisted.score,
                        evidence: persisted.evidence,
                        eliminationReason: persisted.eliminationReason,
                        icpId, geoId, sourcePath, channelId: source.channelId ?? null, jobId: job.id, worker, lease,
                    });
                } catch (e) {
                    if (!(e instanceof SuppressedError)) throw e;
                }
            }

            if (persisted.verdict === 'match') {
                matches++;
                // billOne consumes one unit of the reservation on a fresh charge (lease-fenced),
                // dedups a once-ever-billed key, and stops the run if the reservation is exhausted.
                if (await billOne(persisted.id)) { reservationExhausted = true; break; }
            } else if (persisted.verdict === 'partial') partial++;
            else if (persisted.verdict === 'eliminated') eliminated++;
            else review++;

            processed++;
            if (processed % 3 === 0) await heartbeat({ stage: 'validating', processed, matches });
            if (tracker.reasonToStop()) break;
        }

        // ── Re-score existing firms (cross-ICP) from CACHED FULL PAGE TEXT — NO network fetch ─────
        // Secondary pass after new discovery: an existing firm surfaced this run that lacks a current
        // verdict for THIS ICP is re-scored against its cached FULL page text. Costs one validate call,
        // zero fetch — and only EVER produces NEW revenue: billing dedups once-ever per canonical_key,
        // so a firm already billed under another ICP records the new verdict but is not charged again.
        // research_companies is left untouched (its status/score stay the current rollup; the verdict
        // is the per-ICP truth, surfaced by the verdict-aware companies read).
        //
        // Evidence source is DELIBERATELY the full page cache ONLY — NOT the one-line site_summary:
        // the summary is a prior validator's OUTPUT (paraphrase, possibly scored against a different
        // ICP), never validated source text. Scoring against it would (a) let a hallucinated summary
        // ground a BILLABLE match on ~one sentence, and (b) produce a false non-match that, once
        // written, permanently dedups the firm for this ICP+ruleset (companiesWithCurrentVerdict keys
        // on verdict EXISTENCE) — silently losing a real cross-ICP lead. No fresh full-page cache →
        // skip (leave for a future run/enrichment), exactly like the no-content path (codex P1 / review).
        if (RESCORE_EXISTING && !reservationExhausted) {
            await heartbeat({ stage: 'rescoring', targets: reScoreTargets.length });
            for (const ex of reScoreTargets) {
                if (suppressed.has(ex.canonicalKey)) continue;
                // Re-score is zero-fetch, so it must NOT stop on the fetch cap. canTakeCandidate gates
                // the candidate + spend caps (the only limits that apply to a validate-only pass); the
                // primary pass may have exhausted maxFetches, which is irrelevant here (codex P1).
                if (!tracker.canTakeCandidate()) break;
                // Full cached page text only (no re-fetch, no thin-summary fallback). Absent (no domain,
                // or cache expired/evicted) → skip WITHOUT a validate call or consuming the candidate cap.
                const content = ex.domain ? await cachedPageContent(ex.domain) : null;
                if (!content) { rescoreSkippedNoContent++; continue; }

                tracker.countCandidate(); // an LLM verdict is produced → counts toward the candidate cap
                const { value: verdict, result } = await validateCompany(
                    icpFields,
                    { name: ex.name, domain: ex.domain, country: ex.country },
                    content
                );
                tracker.addLlmCost(costOfLlm(result));

                // Write the per-ICP verdict for the EXISTING company (fenced RPC — the company
                // rollup row is NOT touched). The unique (tenant, company, icp, ruleset) index makes
                // this the re-score of record; reconciliation below is the safety net if a bill is
                // interrupted. A firm suppressed since the discovery-time pre-filter is refused
                // under the lock (suppression > dedup, no TOCTOU) — count + skip.
                let persisted: PersistedVerdict;
                try {
                    persisted = await persistOne(ex.id, verdict, result.model, 'website', content);
                } catch (e) {
                    if (e instanceof SuppressedError) { suppressedAtWrite++; continue; }
                    throw e;
                }
                rescored++;

                if (persisted.verdict === 'match') {
                    matches++; rescoreMatches++;
                    if (await billOne(persisted.id)) { reservationExhausted = true; break; }
                } else if (persisted.verdict === 'partial') partial++;
                else if (persisted.verdict === 'eliminated') eliminated++;
                else review++;

                processed++;
                if (processed % 3 === 0) await heartbeat({ stage: 'rescoring', processed, matches });
                // Stop on spend/candidate only (NOT fetch): re-score does no network fetch, so a
                // fetch_cap left by the primary pass must not end this pass. Spend/candidate are
                // re-checked by canTakeCandidate at the top of the next iteration.
                if (tracker.cost().totalUsd >= caps.maxSpendUsd) break;
            }
        }

        // ── Reconciliation: settle any current-ruleset MATCH for this ICP that has no billable_event
        // (e.g. a prior run crashed between verdict-write and bill, or a re-score match whose bill was
        // interrupted). Idempotent — a match already billed is a no-op. Now that re-scoring writes +
        // bills verdicts for existing firms in the main loop, this is the SAFETY NET for an interrupted
        // bill rather than the primary path. Each recon bill also consumes the reservation, so the
        // run's total billing stays ≤ the hold (the remainder waits for a later top-up run — the
        // verdicts persist, so reconciliation re-finds them). Skipped if the reservation was exhausted.
        let reconciled = 0;
        if (!reservationExhausted) {
            const unbilled = await unbilledMatchVerdicts({ tenantId, icpId, rulesetVersion: icpRow.ruleset_version });
            for (const vId of unbilled) {
                // Direct call (not billOne): count ONLY a real settlement (truthy BillOutcome), so a
                // floored/ineligible null is not miscounted as reconciled. Exhaustion still stops.
                try {
                    const b = await billMatch({
                        verdictId: vId, jobId: job.id, holdId: hold.id,
                        worker, lease,
                        amountUsd: 0, pricingVersion: PRICING_VERSION,
                    });
                    if (b) reconciled++;
                } catch (e) {
                    if (e instanceof ReservationExhaustedError) { reservationExhausted = true; break; }
                    throw e;
                }
            }
        }

        // Close the hold (success path): research_bill_match has already consumed `settled` for every
        // fresh charge, so this just frees the unused remainder. settled is the exact, per-run,
        // concurrency-safe count of leads billed by THIS run. Fenced (067): only THIS attempt's
        // running lease may close its job-attributed hold.
        const settledHold = await settleHold(hold.id, { jobId: job.id, worker, lease });
        const balanceAfter = await creditBalance(tenantId);
        const newlyBilled = settledHold.settled;
        const summary = {
            source: source.name,
            source_path: sourcePath,
            source_meta: sourceMeta ?? null,
            icp_id: icpId,
            geography,
            // Sub-ICP cell provenance (WP2): 'cell' when the run targeted an approved geo cell
            // (geo_id set), 'free-text' for the legacy geography-string path.
            geo_id: geoId,
            geography_source: geoId ? 'cell' : 'free-text',
            queries_run: queriesRun,
            raw_candidates: rawCandidates.length,
            unique_candidates: canon.length,
            // Existing firms surfaced this run: split into truly-skipped (already have a current
            // verdict) and re-scored (didn't). rescore_matches ⊆ matches; rescore_skipped_no_content =
            // existing firms with no cached text to score (left for enrichment).
            existing_surfaced: existingMap.size,
            skipped_current_verdict: skippedCurrentVerdict,
            suppressed_skipped: suppressed.size + suppressedAtWrite,
            fresh: fresh.length,
            rescore_targets: reScoreTargets.length,
            rescored,
            rescore_matches: rescoreMatches,
            rescore_skipped_no_content: rescoreSkippedNoContent,
            domainless,
            maps_metadata_validations: mapsMetadataValidations,
            maps_domainless_validations: mapsDomainlessValidations,
            maps_unreachable_fallbacks: mapsUnreachableFallbacks,
            maps_metadata_refreshed: mapsMetadataRefreshed,
            matches, partial, eliminated, review,
            // newly_billed = actual quota decrements this run (exact); reconciled = matches settled by
            // the safety-net pass (crash-gap / previously-unbilled).
            newly_billed: newlyBilled,
            reconciled,
            fetch_errors: fetchErrors,
            // Fetch counts retained so COGS can be recomputed if Jina's per-fetch rate (currently $0)
            // goes non-zero. network_fetches = ALL network attempts (Jina + direct fallback + errors,
            // bounds the cap); jina_fetches = the provider-billable subset; direct_fetches = SSRF-
            // guarded fallback on our own egress.
            network_fetches: tracker.fetches,
            jina_fetches: jinaFetches,
            direct_fetches: directFetches,
            credits_before: balanceBefore,
            credits_after: balanceAfter,
            hold: {
                id: hold.id,
                reserved: settledHold.reserved,
                settled: settledHold.settled,
                released: settledHold.released,
            },
            caps,
            cost_usd: tracker.cost(),
            // reservation_exhausted takes precedence: the run stopped because it billed its full
            // reservation, not because a spend/candidate/fetch cap was hit.
            stopped_by: reservationExhausted ? 'reservation_exhausted' : tracker.reasonToStop(),
            pricing_version: PRICING_VERSION,
        };

        // ── Persist cumulative cell coverage (WP3, geo-cell runs only) ─────────────
        // Advisory analytics through the fenced RPC (091): Y3 runs accumulate angle/query
        // stats + rule-B saturation; a Y1/Y2 source updates N only. found_count is the
        // authoritative registry count for the cell (companies stamped with this icp+geo).
        // fully_covered = rule A (channel harvest, persisted by the channel jobs) AND rule B.
        // Never fails the run — the leads are already persisted, billed and settled above.
        if (geoId) {
            const { count: cellCompanyCount, error: cntErr } = await researchSupabaseAdmin
                .from('research_companies')
                .select('id', { count: 'exact', head: true })
                .eq('tenant_id', tenantId)
                .eq('icp_id', icpId)
                .eq('geo_id', geoId);
            if (cntErr) log.warn({ err: cntErr, jobId: job.id, geoId }, 'cell company count failed — coverage keeps prior N');
            const meta = (sourceMeta ?? {}) as Record<string, unknown>;
            const isY3 = sourcePath === 'Y3';
            const saturationB = isY3 ? meta.fully_covered === true : undefined;
            await updateChunkCoverageSafe({
                tenantId, jobId: job.id, worker, lease,
                projectId, icpId, geoId,
                angleDelta: isY3 && meta.angle_query_counts && typeof meta.angle_query_counts === 'object'
                    ? (meta.angle_query_counts as Record<string, number>)
                    : undefined,
                queriesDelta: isY3 ? queriesRun : 0,
                lastTwoNewDomains: isY3 && typeof meta.last_two_new_domains === 'number' ? meta.last_two_new_domains : undefined,
                foundCount: cntErr ? undefined : cellCompanyCount ?? undefined,
                estimate: cellEstimate ?? undefined,
                saturationB,
            });
        }
        return summary;
        });

        // Fold in the raw usage tally + a dollar recheck recomputed from it. cost_recheck covers
        // LLM+grounding only (Jina fetch is not metered) and is a RETRY-FAITHFUL ESTIMATE at the
        // configured flat rates: the meter records every provider call (incl. runLlmJson retries the
        // dollar tracker costs only once; SDK retries are off), but it ignores DeepSeek cache hits
        // (a conservative overcount). The authoritative invoice COGS is recomputed from usage_raw
        // (which keeps the cached-token split) at the real per-provider rates. cost_recheck is
        // typically ≥ cost_usd.searchUsd+llmUsd — small differences are retries plus rounding.
        const summary = {
            ...built,
            usage_raw: usage,
            cost_recheck: costFromUsageSummary(usage),
        };
        log.info({ jobId: job.id, ...summary }, `${source.name} harvest complete`);
        return summary;
    } catch (err) {
        // The run failed AFTER possibly spending on LLM calls — withLlmMeter attaches the partial
        // usage tally to the error, so log the COGS already spent (don't lose failed-run spend data;
        // avoids biasing calibration toward clean runs).
        const partialUsage = (err && typeof err === 'object') ? (err as MeteredError).llmUsage : undefined;
        if (partialUsage && partialUsage.totalCalls > 0) {
            log.warn({ jobId: job.id, usage_raw: partialUsage }, 'harvest:run failed after spending — partial COGS');
        }
        // The run failed before settling — free the whole reservation so the credits aren't stranded
        // (best-effort; never mask the original error). Fenced (067): if THIS attempt lost its lease
        // (zombie), the release is refused — correct, because the reservation now belongs to the
        // job's successor (reserve is idempotent per job) or, if the job is terminal, the stale-hold
        // reaper frees it. The reaper is also the backstop if this release fails for any reason.
        try {
            await releaseHold(hold.id, { jobId: job.id, worker, lease });
        } catch (relErr) {
            log.error({ err: relErr, holdId: hold.id, jobId: job.id }, 'releaseHold after failure failed (fenced zombie or outage — reaper will recover)');
        }
        throw err;
    }
}

/** harvest:run — web-search discovery (SearXNG/Gemini) → the shared harvest pipeline. */
export const harvestRunHandler: JobHandler = (ctx) => runHarvest(ctx, webSearchSource);
