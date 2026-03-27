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

/** Invalidate overview cache for a tenant (call after stage changes, imports, etc.) */
export function invalidateOverviewCache(tenantId: string) {
    overviewCache.delete(tenantId);
}

// GET /api/statistics/overview — Summary stats for dashboard
router.get('/overview', async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        // Check cache first
        const cached = overviewCache.get(tenantId);
        if (cached && Date.now() - cached.ts < OVERVIEW_TTL) {
            res.json(cached.data);
            return;
        }

        // Run all counts in parallel (including pipeline stages to avoid extra round-trip)
        const [companiesRes, contactsRes, stagesRes, tenantPipelineStages] = await Promise.all([
            supabaseAdmin
                .from('companies')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', tenantId),
            supabaseAdmin
                .from('contacts')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', tenantId),
            supabaseAdmin
                .rpc('get_stage_counts', { p_tenant_id: tenantId }),
            getPipelineStageSlugs(tenantId),
        ]);

        if (stagesRes.error) {
            log.error({ err: stagesRes.error }, 'Stage counts RPC error');
        }

        const totalCompanies = companiesRes.count || 0;
        const totalContacts = contactsRes.count || 0;

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
        overviewCache.set(tenantId, { data: result, ts: Date.now() });

        res.json(result);
    } catch (err) {
        log.error({ err }, 'Statistics overview error');
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// ─── Pipeline cache (per tenant, 30s TTL) ───
const pipelineStatsCache = new Map<string, CachedOverview>();

export function invalidatePipelineStatsCache(tenantId: string) {
    pipelineStatsCache.delete(tenantId);
}

// GET /api/statistics/pipeline — Funnel data for pipeline stages (pro tier only)
router.get('/pipeline', requireTier('pro'), async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        const cached = pipelineStatsCache.get(tenantId);
        if (cached && Date.now() - cached.ts < OVERVIEW_TTL) {
            res.json(cached.data);
            return;
        }

        // Fetch stage counts + stage config in parallel
        const [stagesRes, pipelineStages, terminalStages] = await Promise.all([
            supabaseAdmin.rpc('get_stage_counts', { p_tenant_id: tenantId }),
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
        pipelineStatsCache.set(tenantId, { data: result, ts: Date.now() });

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

        const [locationsRes, missingRes] = await Promise.all([
            supabaseAdmin
                .from('companies')
                .select('id, name, location, latitude, longitude, stage')
                .eq('tenant_id', tenantId)
                .not('latitude', 'is', null)
                .not('longitude', 'is', null)
                .order('updated_at', { ascending: false })
                .limit(2000),
            supabaseAdmin
                .from('companies')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', tenantId)
                .in('stage', ['pipeline_negotiation', 'pipeline_meeting', 'pipeline_proposal'])
                .is('latitude', null)
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