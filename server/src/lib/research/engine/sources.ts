/**
 * Candidate sources (engine, Y1+). A source is the ONE part of the harvest that differs by
 * discovery mechanism; everything downstream (canonicalize → dedup → fetch → validate → persist →
 * bill → reconcile → settle) is source-agnostic and lives in runHarvest (worker/handlers/harvestRun).
 *
 *   • webSearchSource — the synchronous SearXNG/Gemini query loop (design default). Deterministic,
 *     $0 search; the LLM only validates. Emits candidates keyed by registrable domain.
 *   • mapsSource      — an ASYNC maps scrape (Gosom for the West, 2GIS for CIS in M2), routed by
 *     geography. Submits a scrape, polls for minutes (heartbeating), and maps business rows to the
 *     SAME Candidate shape. Businesses with a website validate+bill like a web hit; ones without a
 *     site are parked domainless as 'review' for the enrichment phase.
 *
 * Both feed rawCandidates + a queriesRun count back to runHarvest; each does its OWN source cost
 * accounting (tracker.addSearchCost + logSearch) since only the source knows its queries/cost.
 */
import { buildQuerySpecs, runDiscovery, type Candidate, type GeoQuerySpec } from './discovery.js';
import { normalizeDomain } from './canonical.js';
import { isJunkDomain } from './domainFilter.js';
import { logSearch } from './ledger.js';
import { pickMapsBackend } from './scrapers/index.js';
import { fetchPage } from './fetch.js';
import { costOfFetch, costOfLlm } from './pricing.js';
import { runLlmJson } from '../llm/index.js';
import { memberExtractionSchema } from '../channels/schema.js';
import { buildMemberExtractionPrompt } from '../channels/prompt.js';
import type { CapTracker, EngineCaps } from './caps.js';
import { createLogger } from '../../logger.js';
import { researchSupabaseAdmin } from '../supabase.js';

const log = createLogger('research:engine:sources');
const Y3_SATURATION_MIN_QUERIES = Number(process.env.RESEARCH_Y3_SATURATION_MIN_QUERIES ?? 32);
const Y3_SATURATION_NEW_DOMAIN_THRESHOLD = Number(process.env.RESEARCH_Y3_SATURATION_NEW_DOMAIN_THRESHOLD ?? 2);

/** Prior CUMULATIVE cell stats (WP3): what earlier runs of this ICP × geo cell already
 *  covered, read from research_chunks. Seeds the Y3 stop-condition so the 32-query minimum
 *  and per-angle coverage are evaluated per CELL across runs, not per RUN. */
export interface PriorCellStats {
    /** Cumulative Y3 queries run for the cell (chunk.queries_total). */
    queriesTotal: number;
    /** Cumulative per-angle query counts, keyed by PLAIN angle number ('1'..'11'). */
    angleCounts: Record<string, number>;
}

function countAngles(perQuery: Array<{ angle: number }>): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const q of perQuery) counts[String(q.angle)] = (counts[String(q.angle)] ?? 0) + 1;
    return counts;
}

function y3FullyCovered(
    perQuery: Array<{ angle: number; newDomains: number; resultCount?: number }>,
    uniqueDomainsSeen: number,
    prior?: PriorCellStats
): boolean {
    // Zero in-run signal NEVER saturates — even with a satisfying prior seed. runDiscovery
    // swallows engine failures into empty result lists, so a degraded SearXNG would otherwise
    // let 2 empty queries permanently mark the CELL saturated (review P2). The last-2 window
    // must also contain at least one query that actually returned results.
    if (uniqueDomainsSeen === 0) return false;
    // Cumulative seeding (WP3): angle coverage + the query minimum span every run of the
    // cell; the "no new domains in the last 2 queries" tail stays run-local (it measures
    // whether the CURRENT probing is still producing — history can't answer that), so a
    // fresh run always probes at least 2 queries before it may declare saturation.
    if (perQuery.length < 2) return false;
    if (!perQuery.slice(-2).some((q) => (q.resultCount ?? 1) > 0)) return false;
    const counts = countAngles(perQuery);
    if (prior) {
        for (const [angle, n] of Object.entries(prior.angleCounts)) {
            counts[angle] = (counts[angle] ?? 0) + n;
        }
    }
    const totalQueries = perQuery.length + (prior?.queriesTotal ?? 0);
    const required: Record<string, number> = { '3': 3, '10': 3 };
    const everyAngleCovered = Array.from({ length: 11 }, (_, i) => String(i + 1)).every((angle) => {
        return (counts[angle] ?? 0) >= (required[angle] ?? 2);
    });
    if (!everyAngleCovered || totalQueries < Y3_SATURATION_MIN_QUERIES) return false;
    const lastTwoNewDomains = perQuery.slice(-2).reduce((sum, q) => sum + q.newDomains, 0);
    return lastTwoNewDomains <= Y3_SATURATION_NEW_DOMAIN_THRESHOLD;
}

/** Context a source needs to discover candidates + attribute its own COGS. */
export interface GatherContext {
    /** ICP fields the query/keyword builders read (structurally the harvest's IcpRow). */
    icp: {
        id: string;
        name: string;
        segment?: string | null;
        signals: string[];
        negative_signals?: string[] | null;
        ruleset_version: number;
    };
    geography: string;
    /** Approved sub-ICP geo cell spec (WP2), narrow view — absent on free-text-geography runs. */
    geoSpec?: GeoQuerySpec;
    /** Cumulative cell stats (WP3) — present only on geo-cell runs; seeds the Y3 stop-condition. */
    priorStats?: PriorCellStats;
    caps: EngineCaps;
    /** The run's cap+cost rail — the source counts its own queries + adds its own search cost. */
    tracker: CapTracker;
    /** Progress + lock-refresh callback (safe to call repeatedly). */
    heartbeat: (progress?: Record<string, unknown>) => Promise<void>;
    /** Ledger scope for logSearch (per-tenant COGS). */
    tenantId: string;
    projectId: string | null;
    jobId: string;
}

export interface GatherResult {
    candidates: Candidate[];
    /** Discovery calls made (for the job summary's queries_run). */
    queriesRun: number;
    /** Optional source-specific coverage/debug metadata persisted into the job result. */
    meta?: Record<string, unknown>;
}

/** A discovery backend. `gather` never throws — runDiscovery/scrape swallow their own errors, so a
 *  dead source yields zero candidates and the harvest stops gracefully. */
export interface CandidateSource {
    readonly name: string;
    /** Ledger provenance for companies first written by this source. */
    readonly sourcePath?: 'Y1' | 'Y2' | 'Y3';
    /** Explicit sources (Y2) may fetch an existing seed that lacks a current ICP verdict. */
    readonly fetchExisting?: boolean;
    /** Y1 channel provenance (WP3): companies written by this run carry this channel ref. */
    readonly channelId?: string;
    gather(ctx: GatherContext): Promise<GatherResult>;
}

// ── Web search (SearXNG / Gemini) — the current default discovery loop ────────────────────────
export const webSearchSource: CandidateSource = {
    name: 'web',
    sourcePath: 'Y3',
    async gather(ctx: GatherContext): Promise<GatherResult> {
        await ctx.heartbeat({ stage: 'discovery' });
        const specs = buildQuerySpecs(ctx.icp, ctx.geography, ctx.caps.maxQueries, ctx.geoSpec);
        const rawCandidates: Candidate[] = [];
        const seenDomains = new Set<string>();
        const angleCounts: Record<string, number> = {};
        const perQuery: Array<{ angle: number; angleName: string; query: string; resultCount: number; newDomains: number; cacheHit: boolean }> = [];
        let queriesRun = 0;
        for (const spec of specs) {
            if (!ctx.tracker.canQuery()) break;
            ctx.tracker.countQuery();
            queriesRun++;
            const d = await runDiscovery(spec.query);
            ctx.tracker.addSearchCost(d.costUsd);
            await logSearch({
                engine: d.engine,
                tenantId: ctx.tenantId, projectId: ctx.projectId, jobId: ctx.jobId, query: spec.query,
                resultCount: d.candidates.length, cacheHit: d.cacheHit, costUsd: d.costUsd,
            });
            let newDomains = 0;
            for (const candidate of d.candidates) {
                const domain = normalizeDomain(candidate.domain);
                if (domain && !seenDomains.has(domain)) {
                    seenDomains.add(domain);
                    newDomains++;
                }
            }
            angleCounts[`${spec.angle}:${spec.angleName}`] = (angleCounts[`${spec.angle}:${spec.angleName}`] ?? 0) + 1;
            perQuery.push({
                angle: spec.angle,
                angleName: spec.angleName,
                query: spec.query,
                resultCount: d.candidates.length,
                newDomains,
                cacheHit: d.cacheHit,
            });
            rawCandidates.push(...d.candidates);
            await ctx.heartbeat({
                stage: 'discovery',
                source_path: 'Y3',
                queries: queriesRun,
                angle: spec.angleName,
                found: rawCandidates.length,
                new_domains: seenDomains.size,
            });
            if (y3FullyCovered(perQuery, seenDomains.size, ctx.priorStats)) break;
            if (ctx.tracker.reasonToStop()) break;
        }
        const lastTwoNewDomains = perQuery.slice(-2).reduce((sum, q) => sum + q.newDomains, 0);
        const anglesCovered = new Set(perQuery.map((q) => q.angle)).size;
        // Cumulative-seeded when the run targets a geo cell (WP3): the flag then means "this
        // CELL is saturated", spanning every prior run — which is what the chunk persists.
        const saturated = y3FullyCovered(perQuery, seenDomains.size, ctx.priorStats);
        return {
            candidates: rawCandidates,
            queriesRun,
            meta: {
                framework: 'Y3_OPEN_WEB_11_ANGLES_V1',
                source_path: 'Y3',
                total_angles: 11,
                angles_covered: anglesCovered,
                saturation_min_queries: Y3_SATURATION_MIN_QUERIES,
                saturation_new_domain_threshold: Y3_SATURATION_NEW_DOMAIN_THRESHOLD,
                saturation_required_angle_counts: { default: 2, directory_site_filter: 3, local_language: 3 },
                angle_query_counts: angleCounts,
                unique_domains_seen: seenDomains.size,
                last_two_new_domains: lastTwoNewDomains,
                fully_covered: saturated,
                cumulative_seeded: !!ctx.priorStats,
                cumulative_queries_total: (ctx.priorStats?.queriesTotal ?? 0) + queriesRun,
                per_query: perQuery,
            },
        };
    },
};

/**
 * Deterministic maps keywords from the ICP + geography (no LLM). Tighter than the web-search
 * phrasings (buildQueries) because a maps query is a place+category lookup, not a document search.
 */
export function buildMapsKeywords(icp: GatherContext['icp'], geography: string, max = 5, geoSpec?: GeoQuerySpec): string[] {
    const seg = (icp.segment || icp.name).replace(/\s+/g, ' ').trim();
    const base = [`${seg} ${geography}`];
    // Sub-ICP cell (WP2): a maps lookup is exactly the language-sensitive case, so the approved
    // spec's top local terms rank RIGHT AFTER the lead keyword — appending them last would let
    // a small internal maxQueries cap slice them off entirely (review P3). The dedup + max
    // slice still bounds keyword count exactly as before.
    for (const term of (geoSpec?.local_terms ?? []).slice(0, 2)) base.push(`${term} ${geography}`.trim());
    base.push(
        `${seg} importer ${geography}`,
        `${seg} wholesaler ${geography}`,
        `${seg} distributor ${geography}`,
    );
    for (const sig of icp.signals.slice(0, 2)) base.push(`${sig} ${geography}`.trim());
    return [...new Set(base.map((q) => q.trim()).filter(Boolean))].slice(0, Math.max(1, max));
}

// ── Maps scrape (Gosom / 2GIS) — async submit→poll→CSV, routed by geography ────────────────────
export const mapsSource: CandidateSource = {
    name: 'maps',
    sourcePath: 'Y1',
    async gather(ctx: GatherContext): Promise<GatherResult> {
        await ctx.heartbeat({ stage: 'maps_discovery' });
        const scraper = pickMapsBackend(ctx.geography);
        const keywords = buildMapsKeywords(ctx.icp, ctx.geography, ctx.caps.maxQueries, ctx.geoSpec);

        // Count one query unit per keyword. Gosom submits one scrape job per keyword, and 2GIS fans
        // keywords into Catalog searches, so this keeps query caps and summaries aligned with work.
        const countedKeywords: string[] = [];
        for (const keyword of keywords) {
            if (!ctx.tracker.canQuery()) break;
            ctx.tracker.countQuery();
            countedKeywords.push(keyword);
        }
        if (countedKeywords.length === 0) return { candidates: [], queriesRun: 0, meta: { backend: scraper.name } };

        const businesses = await scraper.scrape(countedKeywords, { heartbeat: ctx.heartbeat });
        // Self-hosted scrape → $0 (like SearXNG). Spend lives entirely in downstream validation, so
        // the maxCandidates/maxSpend caps — applied by runHarvest — bound cost, not the scrape.
        ctx.tracker.addSearchCost(0);
        await logSearch({
            engine: scraper.name,
            tenantId: ctx.tenantId, projectId: ctx.projectId, jobId: ctx.jobId,
            query: `[${scraper.name}] ${countedKeywords.join(' | ')}`,
            resultCount: businesses.length, cacheHit: false, costUsd: 0,
        });

        // Map business rows → the engine's Candidate shape. website → registrable domain (validated
        // + billed like a web hit); no website → domainless Candidate (canonicalKey falls back to
        // name|country, and the pipeline parks it as 'review'). country = the harvested geography.
        //
        // JUNK GUARD (mirrors the web path at discovery.ts:173): Maps SMBs routinely list a Facebook
        // page or a directory profile as their "website". Left as-is, that junk domain becomes the
        // candidate's canonical (dedup+bill) key — collapsing DISTINCT firms under one key
        // (e.g. facebook.com) so within-run dedup silently drops all but the first (lead loss), and
        // letting a directory homepage validate+bill as if it were a company. The web path drops
        // these UPSTREAM (before the shared spine), so the maps path must too: a junk domain → treat
        // the business as domainless (parked 'review' for enrichment), never as an identity/bill key.
        const geo = ctx.geography.trim() || null;
        const candidates: Candidate[] = businesses.map((b) => {
            const d = normalizeDomain(b.website);
            const domain = d && isJunkDomain(d) ? null : d;
            return {
                name: b.name,
                domain,
                country: geo,
                city: null,
                phone: b.phone,
                address: b.address,
            };
        });
        if (businesses.length === 0) log.info({ backend: scraper.name, geography: ctx.geography }, 'maps scrape yielded no businesses');
        await ctx.heartbeat({ stage: 'maps_discovery', backend: scraper.name, found: candidates.length });
        return { candidates, queriesRun: countedKeywords.length, meta: { backend: scraper.name, keywords: countedKeywords.length } };
    },
};

interface TradeCandidateRow {
    company_id: string;
    name: string;
    domain: string | null;
    website: string | null;
    country: string | null;
    city: string | null;
    phone: string | null;
    address: string | null;
}

// ── Channel list harvest (WP3, Y1 🥇) — one member-list page → bulk candidates ────────────────
export interface ChannelSourceRow {
    id: string;
    name: string;
    url: string | null;
    member_list_url: string | null;
}

export interface ChannelHarvestOutcome {
    /** 'harvested' when the page was read (even with 0 members); 'unreachable' when it wasn't. */
    status: 'harvested' | 'unreachable';
    error: string | null;
    membersExtracted: number;
    notAList: boolean;
}

/** Page-text budget for member-list extraction. List pages carry their companies far past the
 *  default 12k validation clip (live: a europages category page is ~125k chars, ~30k yielded
 *  only 7 members), so the channel read takes the cache's FULL store budget. ~48k chars ≈ 13k
 *  DeepSeek tokens ≈ $0.006 per page — the whole point of Y1 is many companies per fetch. */
const CHANNEL_PAGE_MAX_CHARS = Number(process.env.RESEARCH_CHANNEL_PAGE_MAX_CHARS ?? 48_000);

/**
 * Y1 list-harvest source: fetch ONE channel's member/exhibitor/tenant list page and extract
 * member companies via the reading role. Downstream (canonical dedup → validate → verdict →
 * bill) is the SAME fenced spine — a member firm bills exactly like a web-discovered one.
 * `onOutcome` reports reachability back to the handler, which owns the channel bookkeeping
 * (harvest_status/harvested_at/companies_found) — the source itself only gathers.
 */
export function channelListSource(channel: ChannelSourceRow, onOutcome: (o: ChannelHarvestOutcome) => void): CandidateSource {
    return {
        name: 'channels',
        sourcePath: 'Y1',
        channelId: channel.id,
        async gather(ctx: GatherContext): Promise<GatherResult> {
            const target = channel.member_list_url || channel.url;
            await ctx.heartbeat({ stage: 'channel_fetch', channel: channel.name });
            if (!target) {
                onOutcome({ status: 'unreachable', error: 'channel has no URL', membersExtracted: 0, notAList: false });
                return { candidates: [], queriesRun: 0, meta: { channel_id: channel.id, error: 'no_url' } };
            }
            ctx.tracker.countQuery();
            const page = await fetchPage(target, { maxChars: CHANNEL_PAGE_MAX_CHARS });
            if (page.networkCall) {
                ctx.tracker.countFetch();
                if (page.method === 'jina') ctx.tracker.addFetchCost(costOfFetch(page.cacheHit));
            }
            if (!page.content) {
                onOutcome({ status: 'unreachable', error: `fetch failed (status ${page.status})`, membersExtracted: 0, notAList: false });
                await logSearch({
                    engine: 'channel-list',
                    tenantId: ctx.tenantId, projectId: ctx.projectId, jobId: ctx.jobId,
                    query: `[channel] ${target}`, resultCount: 0, cacheHit: page.cacheHit, costUsd: 0,
                });
                return { candidates: [], queriesRun: 1, meta: { channel_id: channel.id, target, fetch_method: page.method, error: 'unreachable' } };
            }

            await ctx.heartbeat({ stage: 'channel_extract', channel: channel.name });
            const { system, user } = buildMemberExtractionPrompt({
                channelName: channel.name,
                country: ctx.geography,
                pageText: page.content.slice(0, CHANNEL_PAGE_MAX_CHARS),
            });
            const { value, result } = await runLlmJson('reading', memberExtractionSchema, {
                system,
                messages: [{ role: 'user', content: user }],
                effort: 'low',
                maxTokens: 8000,
            });
            ctx.tracker.addLlmCost(costOfLlm(result));
            await logSearch({
                engine: 'channel-list',
                tenantId: ctx.tenantId, projectId: ctx.projectId, jobId: ctx.jobId,
                query: `[channel] ${target}`, resultCount: value.members.length, cacheHit: page.cacheHit, costUsd: 0,
            });

            // Member rows → the engine's Candidate shape. Same junk-domain guard as the maps path:
            // a Facebook/directory "website" must never become the identity/bill key — park those
            // domainless as 'review' for enrichment instead. GROUNDING (codex P1): the extraction
            // prompt forbids inventing websites, but the invariant is enforced in CODE — a domain
            // that does not literally appear in the fetched page text is treated as hallucinated
            // and dropped to domainless (the member survives as a review candidate; a fabricated
            // domain must never become a fetch/validate/bill key).
            const geo = ctx.geography.trim() || null;
            const pageLower = page.content.toLowerCase();
            let ungroundedWebsites = 0;
            const candidates: Candidate[] = value.members.map((m) => {
                const d = normalizeDomain(m.website ?? null);
                let domain = d && isJunkDomain(d) ? null : d;
                if (domain && !pageLower.includes(domain.toLowerCase())) {
                    ungroundedWebsites++;
                    domain = null;
                }
                return { name: m.name, domain, country: geo, city: m.city ?? null };
            });
            if (ungroundedWebsites > 0) {
                log.warn({ channelId: channel.id, ungroundedWebsites }, 'channel extraction returned websites not present on the page — dropped to domainless');
            }
            onOutcome({
                status: 'harvested',
                error: null,
                membersExtracted: candidates.length,
                notAList: value.not_a_list === true,
            });
            await ctx.heartbeat({ stage: 'channel_extract', channel: channel.name, found: candidates.length });
            return {
                candidates,
                queriesRun: 1,
                meta: {
                    channel_id: channel.id,
                    target,
                    fetch_method: page.method,
                    members_extracted: candidates.length,
                    not_a_list: value.not_a_list === true,
                },
            };
        },
    };
}

/** Y2 batch source: imported buyers without a verdict for this ICP/ruleset. */
export function tradeBatchSource(batchId: string): CandidateSource {
    return {
        name: 'trade',
        sourcePath: 'Y2',
        fetchExisting: true,
        async gather(ctx: GatherContext): Promise<GatherResult> {
            await ctx.heartbeat({ stage: 'trade_discovery', batch_id: batchId });
            ctx.tracker.countQuery();
            const { data, error } = await researchSupabaseAdmin.rpc('research_trade_batch_candidates', {
                p_tenant: ctx.tenantId,
                p_batch: batchId,
                p_icp: ctx.icp.id,
                p_ruleset: ctx.icp.ruleset_version,
                p_limit: Math.min(1000, Math.max(ctx.caps.maxCandidates * 4, ctx.caps.maxCandidates)),
            });
            if (error) throw error;
            const rows = (data ?? []) as TradeCandidateRow[];
            const candidates: Candidate[] = rows.map((row) => ({
                name: row.name,
                domain: row.domain ?? normalizeDomain(row.website),
                country: row.country,
                city: row.city,
                phone: row.phone,
                address: row.address,
            }));
            await logSearch({
                engine: 'trade',
                tenantId: ctx.tenantId,
                projectId: ctx.projectId,
                jobId: ctx.jobId,
                query: `[trade] batch ${batchId}`,
                resultCount: candidates.length,
                cacheHit: false,
                costUsd: 0,
            });
            await ctx.heartbeat({ stage: 'trade_discovery', found: candidates.length });
            return { candidates, queriesRun: 1 };
        },
    };
}
