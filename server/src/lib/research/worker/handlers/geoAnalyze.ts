/**
 * geo:analyze (WP2) — instantiate an ICP for one country (the sub-ICP cell).
 *
 * Loads the geography cell + its ICP + the project profile, optionally runs a $0
 * deterministic SearXNG evidence sweep (associations/directories/fairs/chamber for
 * the country), and asks the strategy model for the geo spec: local-language terms,
 * localized signals, channels, certifications, buyer titles, market notes and an E
 * estimate. Persists via the fenced RPC from migration 086 — which also demotes the
 * cell back to 'draft', so a regenerated spec must be re-approved (same human-gate
 * philosophy as the ICP itself). NO billing coupling: this affects discovery only.
 */
import type { HandlerContext } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { runLlmJson } from '../../llm/index.js';
import { withLlmMeter, type MeteredError } from '../../llm/meter.js';
import { costFromUsageSummary } from '../../engine/pricing.js';
import { searxngBaseUrl, searxngSearch } from '../../engine/searxng.js';
import { geoAnalysisSchema } from '../../geo/schema.js';
import { buildGeoAnalyzePrompt, type GeoAnalyzeIcp, type GeoEvidenceQuery } from '../../geo/prompt.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:geo-analyze');

/** Top web hits kept per evidence query (title + url only — the model needs cues, not pages). */
const EVIDENCE_TOP_N = 8;

/**
 * A short sector-ish phrase for the evidence queries, derived from the ICP itself
 * (deliberately local — no import from discovery.ts). The ICP name is usually the
 * tightest label ("German industrial-valve importers"); fall back to the segment
 * sentence, cut at the first punctuation and capped so it stays a usable query.
 */
function sectorPhrase(icp: GeoAnalyzeIcp): string {
    const raw = (icp.name || icp.segment || '').trim();
    const head = raw.split(/[—–:;,.(]/)[0]?.trim() ?? '';
    return (head || raw).slice(0, 80).trim();
}

export async function geoAnalyzeHandler({ job, heartbeat }: HandlerContext): Promise<Record<string, unknown>> {
    const geoId = typeof job.payload?.geo_id === 'string' ? job.payload.geo_id : null;
    if (!geoId) throw new Error('geo:analyze requires payload.geo_id');
    const tenantId = job.tenant_id;

    await heartbeat({ stage: 'loading' });

    const { data: geo, error: geoErr } = await researchSupabaseAdmin
        .from('research_geographies')
        .select('id, project_id, icp_id, country, region')
        .eq('id', geoId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (geoErr) throw geoErr;
    if (!geo) throw new Error(`geo:analyze: geography ${geoId} not found for tenant ${tenantId}`);
    if (!geo.icp_id) throw new Error(`geo:analyze: geography ${geoId} has no icp_id — a sub-ICP cell needs an ICP`);

    const { data: icp, error: icpErr } = await researchSupabaseAdmin
        .from('research_icps')
        .select('id, name, code, segment, signals, negative_signals')
        .eq('id', geo.icp_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (icpErr) throw icpErr;
    if (!icp) throw new Error(`geo:analyze: ICP ${geo.icp_id} not found for tenant ${tenantId}`);
    const icpRow = icp as GeoAnalyzeIcp & { id: string };

    const { data: project, error: projErr } = await researchSupabaseAdmin
        .from('research_projects')
        .select('id, profile')
        .eq('id', geo.project_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (projErr) throw projErr;
    if (!project) throw new Error(`geo:analyze: project ${geo.project_id} not found for tenant ${tenantId}`);

    // ── Evidence sweep (optional, $0) ─────────────────────────────────────────
    // Deterministic SearXNG queries for the country's canonical channel surface
    // (associations, directories, fairs, importers, chamber, company lists) so the
    // model prefers REAL channels over invented ones. Best-effort: a dead SearXNG
    // must not fail the job — collect what succeeded, empty evidence is fine.
    // No research_search_log write: setup job, $0 (nothing to reconcile against spend).
    const evidence: GeoEvidenceQuery[] = [];
    if (searxngBaseUrl()) {
        const sector = sectorPhrase(icpRow);
        const country = geo.country;
        const queries = [
            `${sector} association ${country}`,
            `${sector} wholesalers directory ${country}`,
            `${sector} trade fair exhibitors ${country}`,
            `${sector} importers ${country}`,
            `chamber of commerce ${sector} ${country}`,
            `list of ${sector} companies ${country}`,
        ];
        await heartbeat({ stage: 'evidence', queries: queries.length });
        for (const query of queries) {
            try {
                const { results } = await searxngSearch(query, { pages: 1 });
                evidence.push({
                    query,
                    results: results.slice(0, EVIDENCE_TOP_N).map((r) => ({ title: r.title, url: r.url })),
                });
            } catch (err) {
                log.warn(
                    { jobId: job.id, geoId, query, err: err instanceof Error ? err.message : String(err) },
                    'geo:analyze evidence query failed — continuing without it'
                );
            }
        }
    }

    const { system, messages } = buildGeoAnalyzePrompt({
        profile: (project.profile ?? {}) as Record<string, unknown>,
        icp: icpRow,
        country: geo.country,
        region: geo.region,
        evidence,
    });

    await heartbeat({ stage: 'analyzing', evidence_queries: evidence.length });
    // Metered like icp:generate (1b): strategy spend outside the harvest path, recorded raw + as
    // a dollar estimate in the job result for the admin margin panel. The catch covers the WHOLE
    // paid section (LLM call + heartbeat + persistence): any failure after the spend warn-logs
    // the tally (captured or the partial withLlmMeter attached to the throw), so a failed-but-paid
    // attempt never disappears from calibration.
    let usage: Awaited<ReturnType<typeof withLlmMeter>>['usage'] | undefined;
    try {
        const metered = await withLlmMeter(async () =>
            runLlmJson('strategy', geoAnalysisSchema, {
                system,
                messages,
                effort: 'high',
                maxTokens: 12000,
            })
        );
        usage = metered.usage;
        const { value, result } = metered.result;

        await heartbeat({ stage: 'persisting', channels: value.channels.length });

        // Fenced persistence (086, 063 pattern): only the attempt that still holds the job lease
        // may write — a reaped, stale attempt can't clobber a newer one. The RPC stores the WHOLE
        // validated object as spec + ai_draft, projects estimate/confidence/estimate_basis onto
        // the 056 columns, and demotes the cell to 'draft' (re-analysis must be re-approved).
        const { error: persistErr } = await researchSupabaseAdmin.rpc('research_persist_geo_analysis', {
            p_tenant: tenantId,
            p_geo_id: geoId,
            p_job_id: job.id,
            p_worker: job.locked_by,
            p_lease: job.lease,
            p_spec: value,
            p_estimate: value.estimate,
            p_confidence: value.confidence,
            p_rationale: value.estimate_basis || null,
        });
        if (persistErr) throw persistErr;

        log.info(
            {
                jobId: job.id,
                geoId,
                country: geo.country,
                channels: value.channels.length,
                localTerms: value.local_terms.length,
                model: result.model,
            },
            'geo:analyze persisted sub-ICP spec'
        );

        return {
            geo_id: geoId,
            country: geo.country,
            channels: value.channels.length,
            local_terms: value.local_terms.length,
            estimate: value.estimate,
            provider: result.provider,
            model: result.model,
            // COGS trail (admin-only downstream: 068 hides result from client reads; the API
            // sanitizer strips usage_raw/cost_usd for non-internal roles).
            usage_raw: usage,
            cost_usd: costFromUsageSummary(usage),
        };
    } catch (err) {
        const partialUsage = usage ?? ((err && typeof err === 'object') ? (err as MeteredError).llmUsage : undefined);
        if (partialUsage && partialUsage.totalCalls > 0) {
            log.warn({ jobId: job.id, usage_raw: partialUsage }, 'geo:analyze failed after spending — partial COGS');
        }
        throw err;
    }
}
