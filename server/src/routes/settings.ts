import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { logAuditAction } from './admin.js';

const log = createLogger('route:settings');
const router = Router();

// Default pipeline groups — canonical source of truth (also mirrored in client/src/lib/pipelineConfig.ts)
const DEFAULT_PIPELINE_GROUPS = [
    { id: 'first_contact', label: 'firstContact', color: 'blue', stages: ['in_queue', 'first_contact', 'connected'] },
    { id: 'qualification', label: 'qualification', color: 'orange', stages: ['qualified', 'in_meeting'] },
    { id: 'evaluation', label: 'evaluation', color: 'grape', stages: ['follow_up', 'proposal_sent'] },
    { id: 'closing', label: 'closing', color: 'green', stages: ['negotiation'] },
];

// ─── Stage cache (per tenant, 60s TTL) ───
interface CachedStages {
    all: { slug: string; stage_type: string }[];
    ts: number;
}
const stageCache = new Map<string, CachedStages>();
const CACHE_TTL = 60_000;

/** Fetch tenant's valid stage slugs (cached) */
export async function getTenantStages(tenantId: string): Promise<{ slug: string; stage_type: string }[]> {
    const cached = stageCache.get(tenantId);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.all;

    const { data, error } = await supabaseAdmin
        .from('pipeline_stages')
        .select('slug, stage_type')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .order('sort_order');

    if (error) {
        log.error({ err: error }, 'Failed to fetch tenant stages');
        return [];
    }

    const result = data || [];
    stageCache.set(tenantId, { all: result, ts: Date.now() });
    return result;
}

export async function getValidStageSlugs(tenantId: string): Promise<string[]> {
    return (await getTenantStages(tenantId)).map((s) => s.slug);
}

export async function getPipelineStageSlugs(tenantId: string): Promise<string[]> {
    return (await getTenantStages(tenantId))
        .filter((s) => s.stage_type === 'pipeline')
        .map((s) => s.slug);
}

export async function getTerminalStageSlugs(tenantId: string): Promise<string[]> {
    return (await getTenantStages(tenantId))
        .filter((s) => s.stage_type === 'terminal')
        .map((s) => s.slug);
}

function invalidateStageCache(tenantId: string) {
    stageCache.delete(tenantId);
}

function isAdmin(role: string): boolean {
    return ['superadmin', 'ops_agent', 'client_admin'].includes(role);
}

function slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Default pipeline stages seeded for new tenants
const DEFAULT_STAGES = [
    { slug: 'cold', display_name: 'Cold', color: 'gray', sort_order: 0, stage_type: 'initial' },
    { slug: 'in_queue', display_name: 'In Queue', color: 'blue', sort_order: 1, stage_type: 'pipeline' },
    { slug: 'first_contact', display_name: 'First Contact', color: 'cyan', sort_order: 2, stage_type: 'pipeline' },
    { slug: 'connected', display_name: 'Connected', color: 'indigo', sort_order: 3, stage_type: 'pipeline' },
    { slug: 'qualified', display_name: 'Qualified', color: 'teal', sort_order: 4, stage_type: 'pipeline' },
    { slug: 'in_meeting', display_name: 'In Meeting', color: 'yellow', sort_order: 5, stage_type: 'pipeline' },
    { slug: 'follow_up', display_name: 'Follow Up', color: 'orange', sort_order: 6, stage_type: 'pipeline' },
    { slug: 'proposal_sent', display_name: 'Proposal Sent', color: 'violet', sort_order: 7, stage_type: 'pipeline' },
    { slug: 'negotiation', display_name: 'Negotiation', color: 'grape', sort_order: 8, stage_type: 'pipeline' },
    { slug: 'won', display_name: 'Won', color: 'green', sort_order: 9, stage_type: 'terminal' },
    { slug: 'lost', display_name: 'Lost', color: 'red', sort_order: 10, stage_type: 'terminal' },
    { slug: 'on_hold', display_name: 'On Hold', color: 'gray', sort_order: 11, stage_type: 'terminal' },
];

export async function ensureDefaultStages(tenantId: string): Promise<void> {
    const { error } = await supabaseAdmin
        .from('pipeline_stages')
        .insert(DEFAULT_STAGES.map((s) => ({ ...s, tenant_id: tenantId })));
    if (error) log.error({ err: error }, 'Failed to seed default stages');
    invalidateStageCache(tenantId);
}

// ─── Stages CRUD ───

// GET /api/settings/stages — All pipeline stages for current tenant
router.get('/stages', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        let { data, error } = await supabaseAdmin
            .from('pipeline_stages')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('is_active', true)
            .order('sort_order');

        if (error) {
            log.error({ err: error }, 'Failed to fetch stages');
            throw new AppError('Failed to fetch stages', 500);
        }

        if (!data || data.length === 0) {
            await ensureDefaultStages(tenantId);
            const result = await supabaseAdmin
                .from('pipeline_stages')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('is_active', true)
                .order('sort_order');
            data = result.data || [];
        }

        res.json({ data });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Get stages error');
        res.status(500).json({ error: 'Failed to fetch stages' });
    }
});

// POST /api/settings/stages — Create a new stage
router.post('/stages', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        if (!isAdmin(req.user!.role)) {
            res.status(403).json({ error: 'Insufficient permissions' });
            return;
        }

        const { display_name, color, sort_order, stage_type } = req.body;
        let { slug } = req.body;

        if (!display_name || typeof display_name !== 'string' || display_name.trim().length === 0) {
            res.status(400).json({ error: 'display_name is required' });
            return;
        }

        if (!slug) slug = slugify(display_name);

        const validTypes = ['initial', 'pipeline', 'terminal'];
        const type = validTypes.includes(stage_type) ? stage_type : 'pipeline';

        // Don't allow creating more than one initial stage
        if (type === 'initial') {
            const existing = await getTenantStages(tenantId);
            if (existing.some((s) => s.stage_type === 'initial')) {
                res.status(400).json({ error: 'Only one initial stage is allowed' });
                return;
            }
        }

        const { data, error } = await supabaseAdmin
            .from('pipeline_stages')
            .insert({
                tenant_id: tenantId,
                slug,
                display_name: display_name.trim(),
                color: color || 'gray',
                sort_order: sort_order ?? 99,
                stage_type: type,
            })
            .select()
            .single();

        if (error) {
            if (error.code === '23505') {
                res.status(409).json({ error: `Stage "${slug}" already exists` });
                return;
            }
            log.error({ err: error }, 'Create stage error');
            throw new AppError('Failed to create stage', 500);
        }

        invalidateStageCache(tenantId);
        res.status(201).json({ data });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Create stage error');
        res.status(500).json({ error: 'Failed to create stage' });
    }
});

// PUT /api/settings/stages/:slug — Update a stage
router.put('/stages/:slug', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        if (!isAdmin(req.user!.role)) {
            res.status(403).json({ error: 'Insufficient permissions' });
            return;
        }

        const { slug } = req.params;
        const { display_name, color, sort_order } = req.body;

        const updateData: Record<string, unknown> = {};
        if (display_name !== undefined) updateData.display_name = display_name.trim();
        if (color !== undefined) updateData.color = color;
        if (sort_order !== undefined) updateData.sort_order = sort_order;

        if (Object.keys(updateData).length === 0) {
            res.status(400).json({ error: 'No fields to update' });
            return;
        }

        const { data, error } = await supabaseAdmin
            .from('pipeline_stages')
            .update(updateData)
            .eq('tenant_id', tenantId)
            .eq('slug', slug)
            .select()
            .single();

        if (error || !data) {
            res.status(404).json({ error: 'Stage not found' });
            return;
        }

        invalidateStageCache(tenantId);
        res.json({ data });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Update stage error');
        res.status(500).json({ error: 'Failed to update stage' });
    }
});

// DELETE /api/settings/stages/:slug — Delete a stage (reassign companies)
router.delete('/stages/:slug', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        if (!isAdmin(req.user!.role)) {
            res.status(403).json({ error: 'Insufficient permissions' });
            return;
        }

        const { slug } = req.params;
        const { reassign_to } = req.body;

        // Fetch the stage to check its type
        const { data: stage } = await supabaseAdmin
            .from('pipeline_stages')
            .select('stage_type')
            .eq('tenant_id', tenantId)
            .eq('slug', slug)
            .single();

        if (!stage) {
            res.status(404).json({ error: 'Stage not found' });
            return;
        }

        // Cannot delete initial or terminal stages
        if (stage.stage_type === 'initial') {
            res.status(400).json({ error: 'Cannot delete the initial stage' });
            return;
        }
        if (stage.stage_type === 'terminal') {
            res.status(400).json({ error: 'Cannot delete terminal stages (won/lost/on_hold)' });
            return;
        }

        // Check if any companies use this stage
        const { count } = await supabaseAdmin
            .from('companies')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .eq('stage', slug);

        if ((count || 0) > 0) {
            if (!reassign_to) {
                res.status(400).json({
                    error: `${count} companies are in this stage. Provide reassign_to to move them.`,
                    company_count: count,
                });
                return;
            }

            // Validate reassign_to is a valid stage
            const validSlugs = await getValidStageSlugs(tenantId);
            if (!validSlugs.includes(reassign_to) || reassign_to === slug) {
                res.status(400).json({ error: `Invalid reassign_to stage: "${reassign_to}"` });
                return;
            }

            // Reassign companies
            const { error: reassignError } = await supabaseAdmin
                .from('companies')
                .update({ stage: reassign_to, updated_at: new Date().toISOString() })
                .eq('tenant_id', tenantId)
                .eq('stage', slug);

            if (reassignError) {
                log.error({ err: reassignError }, 'Reassign companies error');
                throw new AppError('Failed to reassign companies', 500);
            }
        }

        // Delete the stage
        const { error: deleteError } = await supabaseAdmin
            .from('pipeline_stages')
            .delete()
            .eq('tenant_id', tenantId)
            .eq('slug', slug);

        if (deleteError) {
            // FK violation: stage still referenced by companies
            if ((deleteError as any).code === '23503') {
                res.status(409).json({ error: 'Stage has companies — use POST /api/settings/stages/' + slug + '/deactivate' });
                return;
            }
            log.error({ err: deleteError }, 'Delete stage error');
            throw new AppError('Failed to delete stage', 500);
        }

        invalidateStageCache(tenantId);
        res.json({ deleted: slug, reassigned_to: reassign_to || null, companies_moved: count || 0 });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Delete stage error');
        res.status(500).json({ error: 'Failed to delete stage' });
    }
});

// GET /api/settings/stages/:slug/companies — companies in a stage (for deactivation modal)
router.get('/stages/:slug/companies', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        if (!isAdmin(req.user!.role)) {
            res.status(403).json({ error: 'Insufficient permissions' });
            return;
        }

        const { slug } = req.params;

        // Verify stage belongs to this tenant
        const { data: stage, error: stageError } = await supabaseAdmin
            .from('pipeline_stages')
            .select('id, slug, display_name, stage_type')
            .eq('tenant_id', tenantId)
            .eq('slug', slug)
            .single();

        if (stageError || !stage) {
            res.status(404).json({ error: 'Stage not found' });
            return;
        }

        const { data: companies, error: companiesError } = await supabaseAdmin
            .from('companies')
            .select('id, name')
            .eq('tenant_id', tenantId)
            .eq('stage', slug)
            .order('name');

        if (companiesError) {
            log.error({ err: companiesError }, 'Failed to fetch companies for stage');
            throw new AppError('Failed to fetch companies', 500);
        }

        res.json({ stage, companies: companies || [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Get stage companies error');
        res.status(500).json({ error: 'Failed to fetch companies' });
    }
});

// POST /api/settings/stages/:slug/deactivate — soft-delete a stage, migrate companies
const deactivateSchema = z.object({
    migrations: z.array(z.object({
        companyId: z.string().uuid(),
        targetStage: z.string().min(1),
    })),
});

router.post('/stages/:slug/deactivate', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        if (!isAdmin(req.user!.role)) {
            res.status(403).json({ error: 'Insufficient permissions' });
            return;
        }

        const { slug } = req.params;

        // Parse and validate body
        const parsed = deactivateSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
            return;
        }
        const { migrations } = parsed.data;

        // Verify stage belongs to this tenant
        const { data: stage, error: stageError } = await supabaseAdmin
            .from('pipeline_stages')
            .select('id, slug, stage_type')
            .eq('tenant_id', tenantId)
            .eq('slug', slug)
            .single();

        if (stageError || !stage) {
            res.status(404).json({ error: 'Stage not found' });
            return;
        }

        // Block deactivation of initial stage
        if (stage.stage_type === 'initial') {
            res.status(400).json({ error: 'Cannot deactivate the initial stage' });
            return;
        }

        // Resolve tenant's initial stage slug for fallback
        const tenantStages = await getTenantStages(tenantId);
        const initialStageSlug = tenantStages.find((s) => s.stage_type === 'initial')?.slug;
        if (!initialStageSlug) {
            res.status(500).json({ error: 'Tenant has no initial stage configured' });
            return;
        }

        // Validate all targetStage values
        const activeSlugs = new Set(tenantStages.map((s) => s.slug));
        for (const m of migrations) {
            if (!activeSlugs.has(m.targetStage)) {
                res.status(422).json({ error: `Target stage "${m.targetStage}" is not active or does not exist` });
                return;
            }
            if (m.targetStage === slug) {
                res.status(400).json({ error: `Cannot migrate companies to the stage being deactivated` });
                return;
            }
        }

        // Validate all companyIds belong to this tenant
        if (migrations.length > 0) {
            const companyIds = migrations.map((m) => m.companyId);
            const { data: ownedCompanies, error: ownershipError } = await supabaseAdmin
                .from('companies')
                .select('id')
                .eq('tenant_id', tenantId)
                .in('id', companyIds);

            if (ownershipError) throw new AppError('Failed to validate company ownership', 500);

            const ownedIds = new Set((ownedCompanies || []).map((c) => c.id));
            const foreignId = companyIds.find((id) => !ownedIds.has(id));
            if (foreignId) {
                res.status(400).json({ error: `Company "${foreignId}" does not belong to this tenant` });
                return;
            }
        }

        // Apply explicit migrations
        let companiesMoved = 0;
        for (const m of migrations) {
            const { error: migrateError } = await supabaseAdmin
                .from('companies')
                .update({ stage: m.targetStage, updated_at: new Date().toISOString() })
                .eq('id', m.companyId)
                .eq('tenant_id', tenantId);

            if (migrateError) {
                log.error({ err: migrateError, companyId: m.companyId }, 'Failed to migrate company');
                throw new AppError('Failed to migrate company', 500);
            }
            companiesMoved++;
        }

        // Move remaining companies in this stage to the initial stage
        const { count: remainingCount, error: remainCountError } = await supabaseAdmin
            .from('companies')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .eq('stage', slug);

        if (remainCountError) throw new AppError('Failed to count remaining companies', 500);

        if ((remainingCount || 0) > 0) {
            const { error: fallbackError } = await supabaseAdmin
                .from('companies')
                .update({ stage: initialStageSlug, updated_at: new Date().toISOString() })
                .eq('tenant_id', tenantId)
                .eq('stage', slug);

            if (fallbackError) {
                log.error({ err: fallbackError }, 'Failed to move remaining companies to initial stage');
                throw new AppError('Failed to reassign remaining companies', 500);
            }
            companiesMoved += remainingCount || 0;
        }

        // Deactivate the stage
        const { error: deactivateError } = await supabaseAdmin
            .from('pipeline_stages')
            .update({ is_active: false })
            .eq('tenant_id', tenantId)
            .eq('slug', slug);

        if (deactivateError) {
            log.error({ err: deactivateError }, 'Failed to deactivate stage');
            throw new AppError('Failed to deactivate stage', 500);
        }

        invalidateStageCache(tenantId);

        // Audit log
        await logAuditAction(req.user!.id, 'stage.deactivate', 'pipeline_stage', stage.id, {
            slug,
            companiesMoved,
        });

        res.json({ deactivated: slug, companiesMoved });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Deactivate stage error');
        res.status(500).json({ error: 'Failed to deactivate stage' });
    }
});

// PUT /api/settings/stages/reorder — Bulk reorder stages
router.put('/stages-reorder', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        if (!isAdmin(req.user!.role)) {
            res.status(403).json({ error: 'Insufficient permissions' });
            return;
        }

        const { order } = req.body;
        if (!Array.isArray(order) || order.length === 0) {
            res.status(400).json({ error: 'order must be a non-empty array of slugs' });
            return;
        }

        // Update sort_order for each slug
        const updates = order.map((slug: string, index: number) =>
            supabaseAdmin
                .from('pipeline_stages')
                .update({ sort_order: index })
                .eq('tenant_id', tenantId)
                .eq('slug', slug)
        );

        await Promise.all(updates);

        invalidateStageCache(tenantId);
        res.json({ success: true });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Reorder stages error');
        res.status(500).json({ error: 'Failed to reorder stages' });
    }
});

// ─── Pipeline Groups (existing) ───

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
        if (!isAdmin(userRole)) {
            res.status(403).json({ error: 'Insufficient permissions to update pipeline settings' });
            return;
        }

        const { groups } = req.body;

        if (!Array.isArray(groups) || groups.length === 0) {
            res.status(400).json({ error: 'Pipeline groups must be a non-empty array' });
            return;
        }

        // Dynamic stage validation
        const validStageSlugs = await getPipelineStageSlugs(tenantId);

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
                if (!validStageSlugs.includes(stage)) {
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
