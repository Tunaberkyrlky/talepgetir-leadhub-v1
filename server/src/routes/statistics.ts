import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireTier } from '../middleware/auth.js';
import { createLogger } from '../lib/logger.js';
import { getPipelineStageSlugs, getTerminalStageSlugs, getTenantStages } from './settings.js';

const log = createLogger('route:statistics');

const router = Router();

// GET /api/statistics/overview — Summary stats for dashboard
router.get('/overview', async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        // Run all counts in parallel
        const [companiesRes, contactsRes, stagesRes] = await Promise.all([
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
        const tenantPipelineStages = await getPipelineStageSlugs(tenantId);
        const activeDeals = Object.entries(stageCounts)
            .filter(([stage]) => tenantPipelineStages.includes(stage))
            .reduce((sum, [, count]) => sum + count, 0);

        res.json({
            totalCompanies,
            totalContacts,
            activeDeals,
            wonDeals: wonCount,
            conversionRate,
            companiesByStage: stageCounts,
        });
    } catch (err) {
        log.error({ err }, 'Statistics overview error');
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// GET /api/statistics/pipeline — Funnel data for pipeline stages (pro tier only)
router.get('/pipeline', requireTier('pro'), async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        const { data, error } = await supabaseAdmin
            .rpc('get_stage_counts', { p_tenant_id: tenantId });

        if (error) {
            log.error({ err: error }, 'Pipeline stage counts RPC error');
            res.status(500).json({ error: 'Failed to fetch pipeline data' });
            return;
        }

        // Dynamic pipeline stages from tenant config
        const pipelineStages = await getPipelineStageSlugs(tenantId);
        const terminalStages = await getTerminalStageSlugs(tenantId);

        const stageCounts: Record<string, number> = {};
        for (const row of data || []) {
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

        res.json({ funnel, terminal });
    } catch (err) {
        log.error({ err }, 'Statistics pipeline error');
        res.status(500).json({ error: 'Failed to fetch pipeline data' });
    }
});

// GET /api/statistics/company-locations — Companies with geocoded coordinates for globe map
router.get('/company-locations', requireTier('pro'), async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        const { data, error } = await supabaseAdmin
            .from('companies')
            .select('id, name, location, latitude, longitude, stage')
            .eq('tenant_id', tenantId)
            .not('latitude', 'is', null)
            .not('longitude', 'is', null);

        if (error) {
            log.error({ err: error }, 'Company locations error');
            res.status(500).json({ error: 'Failed to fetch company locations' });
            return;
        }

        res.json({ data: data || [] });
    } catch (err) {
        log.error({ err }, 'Company locations error');
        res.status(500).json({ error: 'Failed to fetch company locations' });
    }
});

export default router;