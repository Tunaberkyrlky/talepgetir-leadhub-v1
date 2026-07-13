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
        .select('id, code, description')
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
            if (!worldRefreshFailed) {
                // No lease/fence columns exist here: replace only this HS/kind slice so a re-run
                // cannot touch another code's ranking or this code's bilateral evidence.
                const { error: deleteWorldErr } = await researchSupabaseAdmin
                    .from('research_markets')
                    .delete()
                    .eq('tenant_id', tenantId)
                    .eq('project_id', projectId)
                    .eq('hs_code_id', hsRow.id)
                    .eq('kind', 'world_import');
                if (deleteWorldErr) throw deleteWorldErr;

                if (ranking.ranked.length > 0) {
                    const { error: insertWorldErr } = await researchSupabaseAdmin
                        .from('research_markets')
                        .insert(ranking.ranked.map((entry) => ({
                            tenant_id: tenantId,
                            project_id: projectId,
                            hs_code_id: hsRow.id,
                            hs_code: hsRow.code,
                            country: entry.country,
                            import_value: entry.importValueUsd,
                            growth_pct: entry.growthPct,
                            rank: entry.rank,
                            source: 'comtrade',
                            kind: 'world_import',
                            reporter_country: null,
                            raw: entry,
                        })));
                    if (insertWorldErr) throw insertWorldErr;
                    worldImportRows += ranking.ranked.length;
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
                    tenant_id: tenantId,
                    project_id: projectId,
                    hs_code_id: hsRow.id,
                    hs_code: hsRow.code,
                    country: bilateral.partner,
                    import_value: bilateral.primaryValueUsd,
                    growth_pct: bilateral.growthPct,
                    rank: null,
                    source: 'comtrade',
                    kind: 'bilateral_export',
                    reporter_country: companyCountry,
                    raw: bilateral,
                });
            }

            if (bilateralInserts.length > 0 || bilateralCandidates.length === 0) {
                // Re-run safety mirrors the world-import slice: only this HS code's bilateral rows.
                const { error: deleteBilateralErr } = await researchSupabaseAdmin
                    .from('research_markets')
                    .delete()
                    .eq('tenant_id', tenantId)
                    .eq('project_id', projectId)
                    .eq('hs_code_id', hsRow.id)
                    .eq('kind', 'bilateral_export');
                if (deleteBilateralErr) throw deleteBilateralErr;

                if (bilateralInserts.length > 0) {
                    const { error: insertBilateralErr } = await researchSupabaseAdmin
                        .from('research_markets')
                        .insert(bilateralInserts);
                    if (insertBilateralErr) throw insertBilateralErr;
                    bilateralRows += bilateralInserts.length;
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
