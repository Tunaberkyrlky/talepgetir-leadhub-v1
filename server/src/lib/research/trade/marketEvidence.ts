/**
 * Shared WP11 market-evidence lookup for one geography country.
 *
 * Keeps the geo:analyze prompt and the raw geography markets API on the exact same
 * approved-HS-code Comtrade rows. This context is optional: database or Comtrade
 * reference failures fail soft to an empty list rather than blocking geography work.
 */
import { createLogger } from '../../logger.js';
import { researchSupabaseAdmin } from '../supabase.js';
import { resolveCountryName } from './comtrade.js';

const log = createLogger('research:trade:market-evidence');

export interface MarketEvidenceRow {
    id: string;
    hs_code: string | null;
    hs_code_id: string | null;
    country: string;
    import_value: number | null;
    growth_pct: number | null;
    rank: number | null;
    kind: 'world_import' | 'bilateral_export';
    reporter_country: string | null;
    source: string;
    raw: unknown;
    created_at: string;
    updated_at: string;
}

const likeExact = (value: string): string => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export async function loadMarketEvidenceForGeoCountry(params: {
    tenantId: string;
    projectId: string;
    geoCountry: string;
}): Promise<MarketEvidenceRow[]> {
    const { tenantId, projectId, geoCountry } = params;
    try {
        const { data: approvedRows, error: hsErr } = await researchSupabaseAdmin
            .from('research_hs_codes')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('project_id', projectId)
            .eq('status', 'approved');
        if (hsErr) throw hsErr;
        if (!approvedRows || approvedRows.length === 0) return [];
        const approvedIds = approvedRows.map((row) => row.id);

        const { data: project, error: projectErr } = await researchSupabaseAdmin
            .from('research_projects')
            .select('profile')
            .eq('id', projectId)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (projectErr) throw projectErr;
        if (!project) throw new Error(`research project ${projectId} not found for tenant ${tenantId}`);

        const profile = (project.profile ?? {}) as Record<string, unknown>;
        const companyCountry = (typeof profile.company_country === 'string' && profile.company_country.trim()) || 'TR';

        const [reporterName, partnerName] = await Promise.all([
            resolveCountryName(geoCountry, 'reporter'),
            resolveCountryName(geoCountry, 'partner'),
        ]);

        const columns = 'id, hs_code, hs_code_id, country, import_value, growth_pct, rank, kind, reporter_country, source, raw, created_at, updated_at';
        let worldRows: MarketEvidenceRow[] = [];
        let bilateralRows: MarketEvidenceRow[] = [];

        if (reporterName) {
            const { data, error } = await researchSupabaseAdmin
                .from('research_markets')
                .select(columns)
                .eq('tenant_id', tenantId)
                .eq('project_id', projectId)
                .in('hs_code_id', approvedIds)
                .eq('kind', 'world_import')
                .eq('source', 'comtrade')
                .ilike('country', likeExact(reporterName));
            if (error) throw error;
            worldRows = (data ?? []) as MarketEvidenceRow[];
        }

        if (partnerName) {
            const { data, error } = await researchSupabaseAdmin
                .from('research_markets')
                .select(columns)
                .eq('tenant_id', tenantId)
                .eq('project_id', projectId)
                .in('hs_code_id', approvedIds)
                .eq('kind', 'bilateral_export')
                .eq('source', 'comtrade')
                .ilike('country', likeExact(partnerName))
                .eq('reporter_country', companyCountry);
            if (error) throw error;
            bilateralRows = (data ?? []) as MarketEvidenceRow[];
        }

        return [...worldRows, ...bilateralRows];
    } catch (err) {
        log.warn({ err, tenantId, projectId, geoCountry }, 'market evidence lookup failed — returning no optional evidence');
        return [];
    }
}
