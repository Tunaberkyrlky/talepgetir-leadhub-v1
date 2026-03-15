import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireTier } from '../middleware/auth.js';
import { createLogger } from '../lib/logger.js';

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
                .from('companies')
                .select('stage')
                .eq('tenant_id', tenantId),
        ]);

        const totalCompanies = companiesRes.count || 0;
        const totalContacts = contactsRes.count || 0;

        // Compute stage counts
        const stageCounts: Record<string, number> = {};
        for (const row of stagesRes.data || []) {
            stageCounts[row.stage] = (stageCounts[row.stage] || 0) + 1;
        }

        const wonCount = stageCounts['won'] || 0;
        const lostCount = stageCounts['lost'] || 0;
        const totalDecided = wonCount + lostCount;
        const conversionRate = totalDecided > 0 ? Math.round((wonCount / totalDecided) * 100) : 0;

        // Active deals = everything except won, lost, on_hold
        const terminalStages = ['won', 'lost', 'on_hold'];
        const activeDeals = Object.entries(stageCounts)
            .filter(([stage]) => !terminalStages.includes(stage))
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
            .from('companies')
            .select('stage')
            .eq('tenant_id', tenantId);

        if (error) {
            res.status(500).json({ error: 'Failed to fetch pipeline data' });
            return;
        }

        // Pipeline stages in order (exclude terminal)
        const pipelineStages = [
            'cold', 'in_queue', 'first_contact', 'connected', 'qualified',
            'in_meeting', 'follow_up', 'proposal_sent', 'negotiation',
        ];

        const stageCounts: Record<string, number> = {};
        for (const row of data || []) {
            stageCounts[row.stage] = (stageCounts[row.stage] || 0) + 1;
        }

        const funnel = pipelineStages.map((stage) => ({
            stage,
            count: stageCounts[stage] || 0,
        }));

        // Include terminal for completeness
        const terminal = [
            { stage: 'won', count: stageCounts['won'] || 0 },
            { stage: 'lost', count: stageCounts['lost'] || 0 },
            { stage: 'on_hold', count: stageCounts['on_hold'] || 0 },
        ];

        res.json({ funnel, terminal });
    } catch (err) {
        log.error({ err }, 'Statistics pipeline error');
        res.status(500).json({ error: 'Failed to fetch pipeline data' });
    }
});

export default router;
