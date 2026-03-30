import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireTier } from '../middleware/auth.js';
import { createLogger } from '../lib/logger.js';
import { getPipelineStageSlugs, getTerminalStageSlugs, getTenantStages } from './settings.js';

const log = createLogger('route:statistics');

const router = Router();

// ─── In-memory cache for overview (per tenant, 30s TTL) ───
interface CachedOverview {
    data: Record<string, unknown>;
    ts: number;
}
const overviewCache = new Map<string, CachedOverview>();
const OVERVIEW_TTL = 30_000; // 30 seconds
const MAX_STATS_CACHE_SIZE = 500;

/** Invalidate overview cache for a tenant (call after stage changes, imports, etc.) */
export function invalidateOverviewCache(tenantId: string) {
    for (const key of overviewCache.keys()) {
        if (key.startsWith(tenantId)) overviewCache.delete(key);
    }
}

function parseDateFilters(req: Request, res: Response): { dateFrom?: string; dateTo?: string } | null {
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo = req.query.dateTo as string | undefined;

    if (dateFrom && isNaN(Date.parse(dateFrom))) {
        res.status(400).json({ error: 'Please enter a valid start date' });
        return null;
    }
    if (dateTo && isNaN(Date.parse(dateTo))) {
        res.status(400).json({ error: 'Please enter a valid end date' });
        return null;
    }
    if (dateFrom && dateTo && new Date(dateFrom) > new Date(dateTo)) {
        res.status(400).json({ error: 'Start date must be before end date' });
        return null;
    }

    return { dateFrom, dateTo };
}

function buildCacheKey(tenantId: string, dateFrom?: string, dateTo?: string): string {
    return `${tenantId}:${dateFrom || ''}:${dateTo || ''}`;
}

// GET /api/statistics/overview — Summary stats for dashboard
router.get('/overview', async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        const dateFilters = parseDateFilters(req, res);
        if (!dateFilters) return; // 400 already sent
        const { dateFrom, dateTo } = dateFilters;
        const cacheKey = buildCacheKey(tenantId, dateFrom, dateTo);

        // Check cache first
        const cached = overviewCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < OVERVIEW_TTL) {
            res.json(cached.data);
            return;
        }

        // Build companies query with optional date filters
        let companiesQuery = supabaseAdmin
            .from('companies')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId);
        if (dateFrom) companiesQuery = companiesQuery.gte('created_at', dateFrom);
        if (dateTo) companiesQuery = companiesQuery.lte('created_at', dateTo);

        // Run all counts in parallel (including pipeline stages to avoid extra round-trip)
        const [companiesRes, stagesRes, tenantPipelineStages] = await Promise.all([
            companiesQuery,
            supabaseAdmin.rpc('get_stage_counts', {
                p_tenant_id: tenantId,
                p_date_from: dateFrom || null,
                p_date_to: dateTo || null,
            }),
            getPipelineStageSlugs(tenantId),
        ]);

        if (stagesRes.error) {
            log.error({ err: stagesRes.error }, 'Stage counts RPC error');
        }

        const totalCompanies = companiesRes.count || 0;

        let totalContacts: number;
        if (dateFrom || dateTo) {
            // Sum contact_count from date-filtered companies
            let contactQuery = supabaseAdmin
                .from('companies')
                .select('contact_count')
                .eq('tenant_id', tenantId);
            if (dateFrom) contactQuery = contactQuery.gte('created_at', dateFrom);
            if (dateTo) contactQuery = contactQuery.lte('created_at', dateTo);
            const { data: contactData } = await contactQuery;
            totalContacts = (contactData || []).reduce((sum, c) => sum + (c.contact_count || 0), 0);
        } else {
            // Existing efficient head count on contacts table
            const { count } = await supabaseAdmin
                .from('contacts')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', tenantId);
            totalContacts = count ?? 0;
        }


        // Build stage counts from RPC result
        const stageCounts: Record<string, number> = {};
        for (const row of stagesRes.data || []) {
            stageCounts[row.stage] = Number(row.count);
        }

        const wonCount = stageCounts['won'] || 0;
        const lostCount = stageCounts['lost'] || 0;
        const totalDecided = wonCount + lostCount;
        const conversionRate = totalDecided > 0 ? Math.round((wonCount / totalDecided) * 100) : 0;

        // Active deals = only pipeline-type stages
        const activeDeals = Object.entries(stageCounts)
            .filter(([stage]) => tenantPipelineStages.includes(stage))
            .reduce((sum, [, count]) => sum + count, 0);

        const result = {
            totalCompanies,
            totalContacts,
            activeDeals,
            wonDeals: wonCount,
            conversionRate,
            companiesByStage: stageCounts,
        };

        // Cache result
        if (overviewCache.size >= MAX_STATS_CACHE_SIZE) overviewCache.clear();
        overviewCache.set(cacheKey, { data: result, ts: Date.now() });

        res.json(result);
    } catch (err) {
        log.error({ err }, 'Statistics overview error');
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// ─── Pipeline cache (per tenant, 30s TTL) ───
const pipelineStatsCache = new Map<string, CachedOverview>();

export function invalidatePipelineStatsCache(tenantId: string) {
    for (const key of pipelineStatsCache.keys()) {
        if (key.startsWith(tenantId)) pipelineStatsCache.delete(key);
    }
}

// GET /api/statistics/pipeline — Funnel data for pipeline stages (pro tier only)
router.get('/pipeline', requireTier('pro'), async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        const dateFilters = parseDateFilters(req, res);
        if (!dateFilters) return; // 400 already sent
        const { dateFrom, dateTo } = dateFilters;
        const cacheKey = buildCacheKey(tenantId, dateFrom, dateTo);

        const cached = pipelineStatsCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < OVERVIEW_TTL) {
            res.json(cached.data);
            return;
        }

        // Fetch stage counts + stage config in parallel
        const [stagesRes, pipelineStages, terminalStages] = await Promise.all([
            supabaseAdmin.rpc('get_stage_counts', {
                p_tenant_id: tenantId,
                p_date_from: dateFrom || null,
                p_date_to: dateTo || null,
            }),
            getPipelineStageSlugs(tenantId),
            getTerminalStageSlugs(tenantId),
        ]);

        if (stagesRes.error) {
            log.error({ err: stagesRes.error }, 'Pipeline stage counts RPC error');
            res.status(500).json({ error: 'Failed to fetch pipeline data' });
            return;
        }

        const stageCounts: Record<string, number> = {};
        for (const row of stagesRes.data || []) {
            stageCounts[row.stage] = Number(row.count);
        }

        const funnel = pipelineStages.map((stage) => ({
            stage,
            count: stageCounts[stage] || 0,
        }));

        const terminal = terminalStages.map((stage) => ({
            stage,
            count: stageCounts[stage] || 0,
        }));

        const result = { funnel, terminal };
        if (pipelineStatsCache.size >= MAX_STATS_CACHE_SIZE) pipelineStatsCache.clear();
        pipelineStatsCache.set(cacheKey, { data: result, ts: Date.now() });

        res.json(result);
    } catch (err) {
        log.error({ err }, 'Statistics pipeline error');
        res.status(500).json({ error: 'Failed to fetch pipeline data' });
    }
});

// GET /api/statistics/company-locations — Companies with geocoded coordinates for globe map
router.get('/company-locations', requireTier('pro'), async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        const dateFilters = parseDateFilters(req, res);
        if (!dateFilters) return;
        const { dateFrom, dateTo } = dateFilters;


        // Get actual stage slugs for this tenant (initial + pipeline types)
        const allStages = await getTenantStages(tenantId);
        const geocodableStages = allStages
            .filter((s) => s.stage_type === 'initial' || s.stage_type === 'pipeline')
            .map((s) => s.slug);

        let locationsQuery = supabaseAdmin
            .from('companies')
            .select('id, name, location, latitude, longitude, stage')
            .eq('tenant_id', tenantId)
            .not('latitude', 'is', null)
            .not('longitude', 'is', null)
            .order('updated_at', { ascending: false })
            .limit(2000);
        if (dateFrom) locationsQuery = locationsQuery.gte('created_at', dateFrom);
        if (dateTo) locationsQuery = locationsQuery.lte('created_at', dateTo);

        let missingQuery = geocodableStages.length > 0
            ? supabaseAdmin
                .from('companies')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', tenantId)
                .in('stage', geocodableStages)
                .not('location', 'is', null)
                .is('latitude', null)
            : null;
        if (missingQuery && dateFrom) missingQuery = missingQuery.gte('created_at', dateFrom);
        if (missingQuery && dateTo) missingQuery = missingQuery.lte('created_at', dateTo);

        const [locationsRes, missingRes] = await Promise.all([
            locationsQuery,
            missingQuery ?? Promise.resolve({ count: 0, error: null }),
        ]);

        if (locationsRes.error) {
            log.error({ err: locationsRes.error }, 'Company locations error');
            res.status(500).json({ error: 'Failed to fetch company locations' });
            return;
        }

        res.json({ 
            data: locationsRes.data || [], 
            missingCount: missingRes.count || 0 
        });
    } catch (err) {
        log.error({ err }, 'Company locations error');
        res.status(500).json({ error: 'Failed to fetch company locations' });
    }
});

export default router;