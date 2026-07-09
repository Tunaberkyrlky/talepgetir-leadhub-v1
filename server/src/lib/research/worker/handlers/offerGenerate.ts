/**
 * offer:generate (WP4) — draft 3-5 outreach angles for one APPROVED ICP.
 *
 * Strategy role (Opus), metered like icp:generate. Inputs: the project profile (incl. any
 * structured differentiators), the ICP, optional geo cell market notes (WP2) and up to 5 REAL
 * match-evidence samples from the registry (grounding for proof points). Drafts land in
 * research_offers as status='draft' with a frozen ai_draft copy — the customer edits + /10
 * approves (ICP/geo human-gate philosophy). Existing angle codes are never overwritten:
 * regeneration proposes NEW codes (the prompt gets the taken list; the unique index is the
 * race backstop). NO billing coupling — offers are advisory strategy artifacts.
 */
import type { HandlerContext } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { runLlmJson } from '../../llm/index.js';
import { withLlmMeter, type MeteredError } from '../../llm/meter.js';
import { costFromUsageSummary } from '../../engine/pricing.js';
import { offerGenerationSchema } from '../../offers/schema.js';
import { buildOfferPrompt } from '../../offers/prompt.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:offer-generate');

export async function offerGenerateHandler({ job, heartbeat }: HandlerContext): Promise<Record<string, unknown>> {
    const icpId = typeof job.payload?.icp_id === 'string' ? job.payload.icp_id : null;
    const geoId = typeof job.payload?.geo_id === 'string' ? job.payload.geo_id : null;
    if (!icpId) throw new Error('offer:generate requires payload.icp_id');
    const tenantId = job.tenant_id;

    await heartbeat({ stage: 'loading' });

    // Angles are written for an APPROVED ICP — its segment/signals are the strategy input,
    // and angle_suggestion only ever fires on approved-ICP harvests anyway.
    const { data: icp, error: icpErr } = await researchSupabaseAdmin
        .from('research_icps')
        .select('id, project_id, name, segment, signals, status, ruleset_version')
        .eq('id', icpId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (icpErr) throw icpErr;
    if (!icp) throw new Error(`offer:generate: ICP ${icpId} not found for tenant ${tenantId}`);
    if (icp.status !== 'approved') {
        throw new Error(`offer:generate: ICP ${icpId} is '${icp.status}', not 'approved' (approve it first)`);
    }

    const { data: project, error: projErr } = await researchSupabaseAdmin
        .from('research_projects')
        .select('id, profile')
        .eq('id', icp.project_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (projErr) throw projErr;
    if (!project) throw new Error(`offer:generate: project ${icp.project_id} not found for tenant ${tenantId}`);

    // Optional geo scope: only the cell's market notes feed the prompt (angles stay ICP-level;
    // a geo-flavored angle simply reads the local market structure).
    let marketNotes: string | null = null;
    if (geoId) {
        const { data: geo, error: geoErr } = await researchSupabaseAdmin
            .from('research_geographies')
            .select('id, icp_id, spec')
            .eq('id', geoId)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (geoErr) throw geoErr;
        if (!geo) throw new Error(`offer:generate: geography ${geoId} not found for tenant ${tenantId}`);
        if (geo.icp_id !== icpId) throw new Error(`offer:generate: geography ${geoId} belongs to a different ICP`);
        const spec = geo.spec as Record<string, unknown> | null;
        marketNotes = spec && typeof spec.market_notes === 'string' ? spec.market_notes : null;
    }

    // Real grounding: up to 5 CURRENT-ruleset match verdicts' evidence lines for this ICP,
    // from UNSUPPRESSED companies only (codex P1): stale-ruleset or KVKK-suppressed firms'
    // evidence must never resurface in customer-facing offer cards. Suppression is checked
    // against both the company flag and the registry (suppression > dedup).
    let evidenceSamples: string[] = [];
    {
        const { data: evRows, error: evErr } = await researchSupabaseAdmin
            .from('research_company_verdicts')
            .select('evidence, company_id')
            .eq('tenant_id', tenantId)
            .eq('icp_id', icpId)
            .eq('ruleset_version', (icp as { ruleset_version: number }).ruleset_version)
            .eq('verdict', 'match')
            .order('created_at', { ascending: false })
            .limit(15);
        if (evErr) {
            log.warn({ err: evErr, jobId: job.id }, 'evidence sample read failed — generating without samples');
        } else {
            const rows = (evRows ?? []) as Array<{ evidence: string | null; company_id: string }>;
            const companyIds = [...new Set(rows.map((r) => r.company_id))];
            const allowed = new Set<string>();
            if (companyIds.length > 0) {
                const { data: comps, error: cErr } = await researchSupabaseAdmin
                    .from('research_companies')
                    .select('id, canonical_key, suppressed')
                    .eq('tenant_id', tenantId)
                    .in('id', companyIds);
                if (cErr) {
                    log.warn({ err: cErr, jobId: job.id }, 'evidence company read failed — generating without samples');
                } else {
                    const unsuppressed = ((comps ?? []) as Array<{ id: string; canonical_key: string; suppressed: boolean }>)
                        .filter((c) => !c.suppressed);
                    const keys = unsuppressed.map((c) => c.canonical_key);
                    let registryOk = true;
                    let suppressedKeys = new Set<string>();
                    if (keys.length > 0) {
                        const { data: sup, error: supErr } = await researchSupabaseAdmin
                            .from('research_suppression')
                            .select('identity_key')
                            .eq('tenant_id', tenantId)
                            .eq('entity_type', 'company')
                            .in('identity_key', keys);
                        if (supErr) {
                            // FAIL CLOSED (codex P1): an unreadable registry must not let
                            // possibly-suppressed evidence through — drop ALL samples instead.
                            log.warn({ err: supErr, jobId: job.id }, 'suppression registry read failed — generating without samples');
                            registryOk = false;
                        } else {
                            suppressedKeys = new Set(((sup ?? []) as Array<{ identity_key: string }>).map((r) => r.identity_key));
                        }
                    }
                    if (registryOk) {
                        for (const c of unsuppressed) if (!suppressedKeys.has(c.canonical_key)) allowed.add(c.id);
                    }
                }
            }
            evidenceSamples = rows
                .filter((r) => allowed.has(r.company_id))
                .map((r) => r.evidence)
                .filter((e): e is string => !!e && e.trim().length > 0)
                .slice(0, 5);
        }
    }

    const { data: existingRows, error: exErr } = await researchSupabaseAdmin
        .from('research_offers')
        .select('angle_code, status')
        .eq('tenant_id', tenantId)
        .eq('icp_id', icpId);
    if (exErr) throw exErr;
    const existingCodes = ((existingRows ?? []) as Array<{ angle_code: string }>).map((r) => r.angle_code.toLowerCase());
    const existingSet = new Set(existingCodes);
    // Ceiling defense-in-depth (review P2): the route gates too, but an internally-enqueued job
    // must not bypass the bound — refuse BEFORE the strategy-model spend.
    const activeCount = ((existingRows ?? []) as Array<{ status: string }>).filter((r) => r.status !== 'rejected').length;
    const MAX_OFFERS_PER_ICP = 20;
    if (activeCount >= MAX_OFFERS_PER_ICP) {
        throw new Error(`offer:generate: ICP ${icpId} already has ${activeCount} offer angles (max ${MAX_OFFERS_PER_ICP}) — edit or reject existing cards`);
    }

    const { system, messages } = buildOfferPrompt({
        profile: (project.profile ?? {}) as Record<string, unknown>,
        icp: { name: icp.name as string, segment: icp.segment as string | null, signals: (icp.signals ?? []) as string[] },
        marketNotes,
        evidenceSamples,
        existingCodes,
    });

    await heartbeat({ stage: 'generating', evidence_samples: evidenceSamples.length });

    let usage: Awaited<ReturnType<typeof withLlmMeter>>['usage'] | undefined;
    try {
        const { result: outcome, usage: metered } = await withLlmMeter(async () => {
            const { value } = await runLlmJson('strategy', offerGenerationSchema, {
                system,
                messages,
                effort: 'high',
                maxTokens: 8000,
            });

            // Drafts land directly (advisory artifact, channels convention) — never overwriting
            // an existing code: the per-ICP unique index backstops the in-run dedup on a race.
            let inserted = 0;
            let skippedExisting = 0;
            let skippedCeiling = 0;
            for (const draft of value.offers) {
                if (existingSet.has(draft.angle_code.toLowerCase())) { skippedExisting++; continue; }
                // Hard clamp (codex P2): a run started at 16-19 active cards must not overshoot
                // the ceiling — surplus drafts are dropped, not inserted.
                if (activeCount + inserted >= MAX_OFFERS_PER_ICP) { skippedCeiling++; continue; }
                const { error: insErr } = await researchSupabaseAdmin.from('research_offers').insert({
                    tenant_id: tenantId,
                    project_id: icp.project_id,
                    icp_id: icpId,
                    geo_id: geoId,
                    angle_code: draft.angle_code,
                    pain_hypothesis: draft.pain_hypothesis,
                    value_prop: draft.value_prop,
                    proof_points: draft.proof_points,
                    objections: draft.objections,
                    language: draft.language ?? null,
                    status: 'draft',
                    ai_draft: draft,
                    generated_by_job_id: job.id,
                });
                if (insErr) {
                    if (insErr.code === '23505') { skippedExisting++; continue; }
                    throw insErr;
                }
                existingSet.add(draft.angle_code.toLowerCase());
                inserted++;
            }

            return {
                icp_id: icpId,
                geo_id: geoId,
                drafted: value.offers.length,
                inserted,
                skipped_existing: skippedExisting,
                skipped_ceiling: skippedCeiling,
                evidence_samples: evidenceSamples.length,
                market_notes: marketNotes ? true : false,
            };
        });
        usage = metered;

        log.info({ jobId: job.id, ...outcome }, 'offer:generate complete');
        return { ...outcome, usage_raw: usage, cost_usd: costFromUsageSummary(usage) };
    } catch (err) {
        const partial = (err && typeof err === 'object') ? (err as MeteredError).llmUsage : undefined;
        if (partial && partial.totalCalls > 0) {
            log.warn({ jobId: job.id, usage_raw: partial }, 'offer:generate failed after spending — partial COGS');
        }
        throw err;
    }
}
