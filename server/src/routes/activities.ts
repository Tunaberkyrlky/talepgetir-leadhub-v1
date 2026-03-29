import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin, createUserClient } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { validateBody, createActivitySchema, updateActivitySchema, closingReportSchema } from '../lib/validation.js';
import { invalidateOverviewCache, invalidatePipelineStatsCache } from './statistics.js';
import { isInternalRole } from '../lib/roles.js';

const log = createLogger('route:activities');

const router = Router();



function dbClient(req: Request) {
    if (isInternalRole(req.user!.role)) return supabaseAdmin;
    return createUserClient(req.accessToken!);
}

// GET /api/activities — List activities (requires company_id)
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { company_id, contact_id, type } = req.query;
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
        const offset = (page - 1) * limit;

        if (!company_id) {
            res.status(400).json({ error: 'company_id is required' });
            return;
        }

        const db = dbClient(req);
        let query = db
            .from('activities')
            .select('*', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .eq('company_id', company_id as string)
            .order('occurred_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (contact_id) query = query.eq('contact_id', contact_id as string);
        if (type) {
            const VALID_TYPES = ['not', 'meeting', 'follow_up', 'sonlandirma_raporu', 'status_change'];
            if (!VALID_TYPES.includes(type as string)) {
                res.status(400).json({ error: `Invalid activity type: ${type}` });
                return;
            }
            query = query.eq('type', type as string);
        }

        const { data, count, error } = await query;

        if (error) {
            log.error({ err: error }, 'List activities error');
            throw new AppError('Failed to fetch activities', 500);
        }

        // Resolve contact names (no FK constraint on contact_id)
        const contactIds = [...new Set((data || []).map((a: any) => a.contact_id).filter(Boolean))];
        const contactMap: Record<string, string> = {};
        if (contactIds.length > 0) {
            const { data: contacts } = await db
                .from('contacts')
                .select('id, first_name, last_name')
                .in('id', contactIds);
            for (const c of contacts || []) {
                contactMap[c.id] = [c.first_name, c.last_name].filter(Boolean).join(' ');
            }
        }

        const mapped = (data || []).map((a: any) => {
            const contact_name = a.contact_id ? (contactMap[a.contact_id] || null) : null;
            return { ...a, contact_name };
        });

        res.json({
            data: mapped,
            pagination: {
                page,
                limit,
                total: count || 0,
                totalPages: Math.ceil((count || 0) / limit),
                hasNext: page < Math.ceil((count || 0) / limit),
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'List activities error');
        res.status(500).json({ error: 'Failed to fetch activities' });
    }
});

// GET /api/activities/all — List all activities across companies (for Activities page)
router.get('/all', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { type, date_from, date_to, search, visibility, created_by } = req.query;
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const offset = (page - 1) * limit;

        const db = dbClient(req);
        let query = db
            .from('activities')
            .select('*, companies(name)', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .order('occurred_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (type) {
            const VALID_TYPES = ['not', 'meeting', 'follow_up', 'sonlandirma_raporu', 'status_change'];
            if (!VALID_TYPES.includes(type as string)) {
                res.status(400).json({ error: `Invalid activity type: ${type}` });
                return;
            }
            query = query.eq('type', type as string);
        }
        if (date_from) query = query.gte('occurred_at', date_from as string);
        if (date_to) query = query.lte('occurred_at', date_to as string);

        // Search: ILIKE on summary and detail
        if (search && typeof search === 'string' && search.trim()) {
            const term = search.trim();
            query = query.or(`summary.ilike.%${term}%,detail.ilike.%${term}%`);
        }

        // Visibility filter (only internal roles can filter by 'internal')
        if (visibility && typeof visibility === 'string') {
            const allowed = ['internal', 'client'];
            if (allowed.includes(visibility)) {
                if (visibility === 'internal' && !isInternalRole(req.user!.role)) {
                    // Non-internal roles cannot see internal activities — ignore the filter
                } else {
                    query = query.eq('visibility', visibility);
                }
            }
        }

        // Created-by filter
        if (created_by && typeof created_by === 'string') {
            // Basic UUID format check
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (uuidRegex.test(created_by)) {
                query = query.eq('created_by', created_by);
            }
        }

        const { data, count, error } = await query;

        if (error) {
            log.error({ err: error }, 'List all activities error');
            throw new AppError('Failed to fetch activities', 500);
        }

        // Resolve contact names for activities that have contact_id
        const contactIds = [...new Set((data || []).map((a: any) => a.contact_id).filter(Boolean))];
        const contactMap: Record<string, string> = {};
        if (contactIds.length > 0) {
            const { data: contacts } = await db
                .from('contacts')
                .select('id, first_name, last_name')
                .in('id', contactIds);
            for (const c of contacts || []) {
                contactMap[c.id] = [c.first_name, c.last_name].filter(Boolean).join(' ');
            }
        }

        const mapped = (data || []).map((a: any) => {
            const company_name = a.companies?.name || null;
            const contact_name = a.contact_id ? (contactMap[a.contact_id] || null) : null;
            const { companies: _co, ...rest } = a;
            return { ...rest, contact_name, company_name };
        });

        res.json({
            data: mapped,
            pagination: {
                page,
                limit,
                total: count || 0,
                totalPages: Math.ceil((count || 0) / limit),
                hasNext: page < Math.ceil((count || 0) / limit),
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'List all activities error');
        res.status(500).json({ error: 'Failed to fetch activities' });
    }
});

// GET /api/activities/:id — Get single activity
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { id } = req.params;

        const db = dbClient(req);
        const { data, error } = await db
            .from('activities')
            .select('*')
            .eq('id', id)
            .eq('tenant_id', tenantId)
            .single();

        if (error || !data) {
            res.status(404).json({ error: 'Activity not found' });
            return;
        }

        res.json({ data });
    } catch (err) {
        log.error({ err }, 'Get activity error');
        res.status(500).json({ error: 'Failed to fetch activity' });
    }
});

// POST /api/activities — Create activity (not, meeting, follow_up)
router.post(
    '/',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(createActivitySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { company_id, contact_id, type, summary, detail, outcome, visibility, occurred_at } = req.body;

            // Non-internal roles cannot create internal-visibility activities
            if (visibility === 'internal' && !isInternalRole(req.user!.role)) {
                res.status(422).json({ error: 'Only internal roles can create activities with internal visibility' });
                return;
            }

            const { data, error } = await supabaseAdmin
                .from('activities')
                .insert({
                    tenant_id: tenantId,
                    company_id,
                    contact_id: contact_id || null,
                    type,
                    summary,
                    detail: detail || null,
                    outcome: outcome || null,
                    visibility,
                    occurred_at: occurred_at || new Date().toISOString(),
                    created_by: req.user!.id,
                })
                .select()
                .single();

            if (error) {
                log.error({ err: error }, 'Create activity error');
                throw new AppError('Failed to create activity', 500);
            }

            res.status(201).json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Create activity error');
            res.status(500).json({ error: 'Failed to create activity' });
        }
    }
);

// POST /api/activities/closing-report — Sonlandırma raporu + otomatik stage güncelleme (atomik)
router.post(
    '/closing-report',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(closingReportSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { company_id, outcome, summary, detail, visibility, occurred_at } = req.body;

            // Single atomic RPC — all 4 steps (fetch + lock, insert activity, update stage,
            // insert audit) run inside one Postgres transaction. No TOCTOU race condition.
            const { data: activity, error } = await supabaseAdmin
                .rpc('close_company', {
                    p_tenant_id: tenantId,
                    p_company_id: company_id,
                    p_outcome: outcome,
                    p_summary: summary,
                    p_detail: detail || null,
                    p_visibility: visibility,
                    p_occurred_at: occurred_at || null,
                    p_created_by: req.user!.id,
                });

            if (error) {
                if (error.message?.includes('Company not found')) {
                    res.status(404).json({ error: 'Company not found' });
                    return;
                }
                log.error({ err: error }, 'Closing report RPC error');
                throw new AppError('Failed to create closing report', 500);
            }

            invalidateOverviewCache(tenantId);
            invalidatePipelineStatsCache(tenantId);

            res.status(201).json({ data: activity });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Closing report error');
            res.status(500).json({ error: 'Failed to create closing report' });
        }
    }
);

// PUT /api/activities/:id — Update activity
router.put(
    '/:id',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(updateActivitySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;
            const { summary, detail, outcome, visibility, occurred_at } = req.body;

            const { data: existing, error: findError } = await supabaseAdmin
                .from('activities')
                .select('id, type')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (findError || !existing) {
                res.status(404).json({ error: 'Activity not found' });
                return;
            }

            const updateData: Record<string, unknown> = {};
            if (summary !== undefined) updateData.summary = summary.trim();
            if (detail !== undefined) updateData.detail = detail;
            if (outcome !== undefined) updateData.outcome = outcome;
            if (visibility !== undefined) updateData.visibility = visibility;
            if (occurred_at !== undefined) updateData.occurred_at = occurred_at;

            const { data, error } = await supabaseAdmin
                .from('activities')
                .update(updateData)
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select()
                .single();

            if (error) {
                throw new AppError('Failed to update activity', 500);
            }

            res.json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Update activity error');
            res.status(500).json({ error: 'Failed to update activity' });
        }
    }
);

// DELETE /api/activities/:id — Delete activity (superadmin only)
router.delete(
    '/:id',
    requireRole('superadmin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            const { error } = await supabaseAdmin
                .from('activities')
                .delete()
                .eq('id', id)
                .eq('tenant_id', tenantId);

            if (error) {
                throw new AppError('Failed to delete activity', 500);
            }

            res.status(204).send();
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Delete activity error');
            res.status(500).json({ error: 'Failed to delete activity' });
        }
    }
);

export default router;
