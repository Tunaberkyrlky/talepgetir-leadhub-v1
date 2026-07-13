/**
 * market:analyze (WP11) — persist Comtrade market evidence for approved HS codes.
 *
 * Sequentially ranks major world importers and then measures the seller country's
 * bilateral exports to the top markets. This is a no-LLM evidence job: bounded,
 * rate-limit-aware results land in research_markets for geo:analyze evidence cards.
 */
import type { HandlerContext } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { getBilateralTrade, getWorldImportRanking } from '../../trade/comtrade.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:market-analyze');

function envNum(key: string, fallback: number): number {
    const v = process.env[key];
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

// UN Comtrade annual coverage lags roughly 1-2 years; operators can override once live coverage is confirmed.
const COMTRADE_YEAR = envNum('RESEARCH_COMTRADE_YEAR', new Date().getUTCFullYear() - 2);
const COMTRADE_PRIOR_YEAR = envNum('RESEARCH_COMTRADE_PRIOR_YEAR', COMTRADE_YEAR - 1);

// Bounds total Comtrade volume per run: ~35 world + up to 15 bilateral calls per HS code;
// unbounded approved-code counts would make runs very long and risk the free daily budget.
const MAX_HS_CODES_PER_RUN = 5;

/**
 * Fast advisory staleness pre-check against a concurrent PATCH /research/hs/:id. A run loads
 * the approved codes once, but Comtrade calls take a while, so a customer can edit a code's
 * `code` (or reject it) mid-run. This is a cheap early-out ONLY — the authoritative guard is
 * research_persist_market_slice's atomic (code, updated_at) CAS, which cannot be raced. On a
 * read error we FAIL CLOSED (return false → skip persisting): a transient blip must never let
 * a possibly-stale write through, and a skipped code just gets re-evidenced on the next run.
 */
async function hsRowStillCurrent(
    tenantId: string,
    projectId: string,
    hsRow: { id: string; code: string },
): Promise<boolean> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_hs_codes')
        .select('code, status')
        .eq('id', hsRow.id)
        .eq('tenant_id', tenantId)
        .eq('project_id', projectId)
        .maybeSingle();
    if (error) {
        log.warn({ hsCodeId: hsRow.id, err: error.message }, 'market:analyze staleness pre-check failed — skipping persist (fail-closed)');
        return false;
    }
    return !!data && data.code === hsRow.code && data.status === 'approved';
}

/**
 * Atomic evidence writer: replaces this (hs_code_id, kind) slice only if the HS row STILL
 * carries the exact (code, updated_at, approved) snapshot the worker loaded before its slow
 * Comtrade calls. Serializes on a FOR UPDATE lock against research_update_hs_code, so a
 * concurrent code edit cannot slip between a check and this write. Returns the inserted count,
 * or -1 when the CAS rejected the write (the code changed/was rejected mid-run — leave evidence).
 */
async function persistMarketSlice(
    tenantId: string,
    projectId: string,
    hsRow: { id: string; code: string; updated_at: string },
    kind: 'world_import' | 'bilateral_export',
    rows: Record<string, unknown>[],
): Promise<number> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_persist_market_slice', {
        p_tenant: tenantId,
        p_project: projectId,
        p_hs_code_id: hsRow.id,
        p_expected_code: hsRow.code,
        p_expected_updated_at: hsRow.updated_at,
        p_kind: kind,
        p_rows: rows,
    });
    if (error) throw error;
    return typeof data === 'number' ? data : Number(data);
}

export async function marketAnalyzeHandler({ job, heartbeat }: HandlerContext): Promise<Record<string, unknown>> {
    const projectId = job.project_id;
    if (!projectId) throw new Error('market:analyze requires a project_id');
    const tenantId = job.tenant_id;

    await heartbeat({ stage: 'loading' });

    const { data: project, error: projErr } = await researchSupabaseAdmin
        .from('research_projects')
        .select('id, profile')
        .eq('id', projectId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (projErr) throw projErr;
    if (!project) throw new Error(`research project ${projectId} not found for tenant ${tenantId}`);

    const profile = (project.profile ?? {}) as Record<string, unknown>;
    const companyCountry = (typeof profile.company_country === 'string' && profile.company_country.trim()) || 'TR';

    const { data: approvedRows, error: hsErr } = await researchSupabaseAdmin
        .from('research_hs_codes')
        // updated_at is the CAS baseline: persistMarketSlice only writes if the row still
        // carries this exact (code, updated_at) at persist time (guards concurrent edits).
        .select('id, code, description, updated_at')
        .eq('project_id', projectId)
        .eq('tenant_id', tenantId)
        .eq('status', 'approved')
        .order('created_at', { ascending: true });
    if (hsErr) throw hsErr;
    if (!approvedRows || approvedRows.length === 0) {
        throw new Error(`market:analyze: project ${projectId} has no approved HS codes yet`);
    }
    const hsRows = approvedRows.slice(0, MAX_HS_CODES_PER_RUN);

    let hsCodesProcessed = 0;
    let worldImportRows = 0;
    let bilateralRows = 0;
    // Approximate admin-only COGS/budget visibility at our Comtrade-call granularity; this
    // is not billable dollars (COMTRADE_PER_REQUEST_USD ships as 0). requestsMade/hadFailure
    // come straight from comtrade.ts so every real tradePoint() HTTP call — including
    // prior-year ranking calls and bilateral fallback-year retries — is tallied.
    let comtradeRequests = 0;
    let comtradeFailed = 0;

    for (const hsRow of hsRows) {
        try {
            await heartbeat({ stage: 'world_import', hs_code: hsRow.code });
            const ranking = await getWorldImportRanking({
                hsCode: hsRow.code,
                year: COMTRADE_YEAR,
                priorYear: COMTRADE_PRIOR_YEAR,
            });
            comtradeRequests += ranking.requestsMade;
            comtradeFailed += ranking.failed.length;

            // A total outage (every reporter call failed) must NOT wipe prior good evidence —
            // ranked.length === 0 backed by failed.length > 0 means "we couldn't refresh it",
            // not "the true ranking is empty". Only replace when we actually have something (or
            // a genuinely empty result with no failures behind it) to replace it with.
            const worldRefreshFailed = ranking.ranked.length === 0 && ranking.failed.length > 0;
            if (!worldRefreshFailed && !(await hsRowStillCurrent(tenantId, projectId, hsRow))) {
                log.warn(
                    { jobId: job.id, projectId, hsCode: hsRow.code },
                    'market:analyze: HS code changed/removed mid-run — skipping world-import persist to avoid stale evidence'
                );
            } else if (!worldRefreshFailed) {
                // Replace only this HS/kind slice, gated by the atomic (code, updated_at) CAS so a
                // concurrent code edit can't have its purge undone by this write (returns -1 = skipped).
                const worldRows = ranking.ranked.map((entry) => ({
                    hs_code: hsRow.code,
                    country: entry.country,
                    import_value: entry.importValueUsd,
                    growth_pct: entry.growthPct,
                    rank: entry.rank,
                    source: 'comtrade',
                    reporter_country: null,
                    raw: entry,
                }));
                const inserted = await persistMarketSlice(tenantId, projectId, hsRow, 'world_import', worldRows);
                if (inserted < 0) {
                    log.warn(
                        { jobId: job.id, projectId, hsCode: hsRow.code },
                        'market:analyze: HS code changed/removed mid-run (CAS) — world-import persist skipped'
                    );
                } else {
                    worldImportRows += inserted;
                }
            } else {
                log.warn(
                    { jobId: job.id, projectId, hsCode: hsRow.code, failed: ranking.failed },
                    'market:analyze world-import refresh failed for every reporter — keeping prior evidence'
                );
            }

            const bilateralCandidates = ranking.ranked.slice(0, 15);
            await heartbeat({ stage: 'bilateral', hs_code: hsRow.code });

            // Collect new bilateral rows before touching the table: getBilateralTrade returns a
            // null result for both "no such trade" and "the call failed" (hadFailure tells the
            // COGS counters apart, but the row itself is still absent either way). We CAN avoid
            // wiping existing evidence outright — only delete+replace the slice when at least one
            // partner call actually produced a new row (mirrors the world-import guard above; a
            // total per-code failure leaves prior rows).
            const bilateralInserts: Record<string, unknown>[] = [];
            for (const entry of bilateralCandidates) {
                const { result: bilateral, requestsMade, hadFailure } = await getBilateralTrade({
                    reporter: companyCountry,
                    partner: entry.iso2,
                    hsCode: hsRow.code,
                    flow: 'X',
                    year: COMTRADE_YEAR,
                    priorYear: COMTRADE_PRIOR_YEAR,
                });
                comtradeRequests += requestsMade;
                if (hadFailure) comtradeFailed++;
                if (!bilateral) continue;

                // import_value intentionally holds the seller country's EXPORT value to this partner.
                bilateralInserts.push({
                    hs_code: hsRow.code,
                    country: bilateral.partner,
                    import_value: bilateral.primaryValueUsd,
                    growth_pct: bilateral.growthPct,
                    rank: null,
                    source: 'comtrade',
                    reporter_country: companyCountry,
                    raw: bilateral,
                });
            }

            const bilateralHasWork = bilateralInserts.length > 0 || bilateralCandidates.length === 0;
            if (bilateralHasWork && !(await hsRowStillCurrent(tenantId, projectId, hsRow))) {
                log.warn(
                    { jobId: job.id, projectId, hsCode: hsRow.code },
                    'market:analyze: HS code changed/removed mid-run — skipping bilateral persist to avoid stale evidence'
                );
            } else if (bilateralHasWork) {
                // Re-run safety mirrors the world-import slice: only this HS code's bilateral rows,
                // gated by the same atomic (code, updated_at) CAS (returns -1 = skipped as stale).
                const inserted = await persistMarketSlice(tenantId, projectId, hsRow, 'bilateral_export', bilateralInserts);
                if (inserted < 0) {
                    log.warn(
                        { jobId: job.id, projectId, hsCode: hsRow.code },
                        'market:analyze: HS code changed/removed mid-run (CAS) — bilateral persist skipped'
                    );
                } else {
                    bilateralRows += inserted;
                }
            } else {
                log.warn(
                    { jobId: job.id, projectId, hsCode: hsRow.code, candidates: bilateralCandidates.length },
                    'market:analyze bilateral refresh produced zero rows for every candidate — keeping prior evidence'
                );
            }

            hsCodesProcessed++;
        } catch (err) {
            log.warn(
                { jobId: job.id, projectId, hsCode: hsRow.code, err: err instanceof Error ? err.message : String(err) },
                'market:analyze HS code failed — continuing with the next code'
            );
        }
    }

    return {
        project_id: projectId,
        company_country: companyCountry,
        hs_codes_processed: hsCodesProcessed,
        world_import_rows: worldImportRows,
        bilateral_rows: bilateralRows,
        comtrade_requests: comtradeRequests,
        comtrade_failed: comtradeFailed,
        year: COMTRADE_YEAR,
        prior_year: COMTRADE_PRIOR_YEAR,
    };
}
