import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('route:settings');
const router = Router();

// Default pipeline groups — canonical source of truth (also mirrored in client/src/lib/pipelineConfig.ts)
const DEFAULT_PIPELINE_GROUPS = [
    { id: 'first_contact', label: 'firstContact', color: 'blue', stages: ['in_queue', 'first_contact', 'connected'] },
    { id: 'qualification', label: 'qualification', color: 'orange', stages: ['qualified', 'in_meeting'] },
    { id: 'evaluation', label: 'evaluation', color: 'grape', stages: ['follow_up', 'proposal_sent'] },
    { id: 'closing', label: 'closing', color: 'green', stages: ['negotiation'] },
];

const VALID_STAGES = [
    'in_queue', 'first_contact', 'connected', 'qualified',
    'in_meeting', 'follow_up', 'proposal_sent', 'negotiation',
];

// GET /api/settings/pipeline — Get pipeline stage groups for current tenant
router.get('/pipeline', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        const { data: tenant, error } = await supabaseAdmin
            .from('tenants')
            .select('settings')
            .eq('id', tenantId)
            .single();

        if (error) {
            log.error({ err: error }, 'Failed to fetch tenant settings');
            throw new AppError('Failed to fetch settings', 500);
        }

        const pipelineGroups = tenant?.settings?.pipeline_stages || DEFAULT_PIPELINE_GROUPS;

        res.json({ data: pipelineGroups });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Get pipeline settings error');
        res.status(500).json({ error: 'Failed to fetch pipeline settings' });
    }
});

// PUT /api/settings/pipeline — Update pipeline stage groups for current tenant
router.put('/pipeline', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const userRole = req.user!.role;

        // Only admins can update settings
        if (!['superadmin', 'ops_agent', 'client_admin'].includes(userRole)) {
            res.status(403).json({ error: 'Insufficient permissions to update pipeline settings' });
            return;
        }

        const { groups } = req.body;

        if (!Array.isArray(groups) || groups.length === 0) {
            res.status(400).json({ error: 'Pipeline groups must be a non-empty array' });
            return;
        }

        // Validate each group
        for (const group of groups) {
            if (!group.id || !group.label || !group.color) {
                res.status(400).json({ error: 'Each group must have id, label, and color' });
                return;
            }
            if (!Array.isArray(group.stages) || group.stages.length === 0) {
                res.status(400).json({ error: `Group "${group.id}" must have at least one stage` });
                return;
            }
            for (const stage of group.stages) {
                if (!VALID_STAGES.includes(stage)) {
                    res.status(400).json({ error: `Invalid stage "${stage}" in group "${group.id}"` });
                    return;
                }
            }
        }

        // Check no duplicate stages across groups
        const allStages = groups.flatMap((g: any) => g.stages);
        const uniqueStages = new Set(allStages);
        if (uniqueStages.size !== allStages.length) {
            res.status(400).json({ error: 'A stage cannot belong to multiple groups' });
            return;
        }

        // Fetch current settings and merge
        const { data: tenant, error: fetchError } = await supabaseAdmin
            .from('tenants')
            .select('settings')
            .eq('id', tenantId)
            .single();

        if (fetchError) {
            throw new AppError('Failed to fetch tenant', 500);
        }

        const currentSettings = tenant?.settings || {};
        const updatedSettings = { ...currentSettings, pipeline_stages: groups };

        const { error: updateError } = await supabaseAdmin
            .from('tenants')
            .update({ settings: updatedSettings, updated_at: new Date().toISOString() })
            .eq('id', tenantId);

        if (updateError) {
            log.error({ err: updateError }, 'Failed to update pipeline settings');
            throw new AppError('Failed to update settings', 500);
        }

        res.json({ data: groups });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Update pipeline settings error');
        res.status(500).json({ error: 'Failed to update pipeline settings' });
    }
});

export default router;
