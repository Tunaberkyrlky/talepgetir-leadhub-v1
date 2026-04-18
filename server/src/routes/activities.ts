import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin, createUserClient } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { validateBody, createActivitySchema, updateActivitySchema, closingReportSchema } from '../lib/validation.js';
import { invalidateOverviewCache, invalidatePipelineStatsCache } from './statistics.js';
import { isInternalRole } from '../lib/roles.js';
import { sanitizeSearch } from '../lib/queryUtils.js';

const log = createLogger('route:activities');

const router = Router();

const VALID_ACTIVITY_TYPES = ['not', 'meeting', 'follow_up', 'sonlandirma_raporu', 'status_change', 'campaign_email'];



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
            res.status(400).json({ error: 'Please select a company first' });
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
            if (!VALID_ACTIVITY_TYPES.includes(type as string)) {
                res.status(400).json({ error: 'The selected activity type is not valid' });
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

        if (date_from && isNaN(Date.parse(date_from as string))) {
            res.status(400).json({ error: 'Please enter a valid start date' });
            return;
        }
        if (date_to && isNaN(Date.parse(date_to as string))) {
            res.status(400).json({ error: 'Please enter a valid end date' });
            return;
        }

        const db = dbClient(req);
        let query = db
            .from('activities')
            .select('*, companies(name, stage)', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .order('occurred_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (type) {
            if (!VALID_ACTIVITY_TYPES.includes(type as string)) {
                res.status(400).json({ error: 'The selected activity type is not valid' });
                return;
            }
            query = query.eq('type', type as string);
        } else {
            // Exclude system-generated types from the activities feed by default
            query = query.not('type', 'in', '(status_change)');
        }
        if (date_from) query = query.gte('occurred_at', date_from as string);
        if (date_to) query = query.lte('occurred_at', date_to as string);

        // Search: ILIKE on summary and detail
        if (search && typeof search === 'string' && search.trim()) {
            const safe = sanitizeSearch(search.trim());
            if (safe.length > 0) {
                query = query.or(`summary.ilike.%${safe}%,detail.ilike.%${safe}%`);
            }
        }

        // Visibility filter (only internal roles can filter by 'internal')
        if (visibility && typeof visibility === 'string') {
            const allowed = ['internal', 'client'];
            if (allowed.includes(visibility)) {
                if (visibility === 'internal' && !isInternalRole(req.user!.role)) {
                    query = query.eq('visibility', 'client');
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
            const company_stage = a.companies?.stage || null;
            const contact_name = a.contact_id ? (contactMap[a.contact_id] || null) : null;
            const { companies: _co, ...rest } = a;
            return { ...rest, contact_name, company_name, company_stage };
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

// GET /api/activities/stats — Aggregated counts by type (via SQL RPC)
router.get('/stats', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { type, date_from, date_to, search, visibility, created_by } = req.query;

        if (date_from && isNaN(Date.parse(date_from as string))) {
            res.status(400).json({ error: 'Please enter a valid start date' });
            return;
        }
        if (date_to && isNaN(Date.parse(date_to as string))) {
            res.status(400).json({ error: 'Please enter a valid end date' });
            return;
        }

        // Validate type
        let validType: string | null = null;
        if (type) {
            if (!VALID_ACTIVITY_TYPES.includes(type as string)) {
                res.status(400).json({ error: 'The selected activity type is not valid' });
                return;
            }
            validType = type as string;
        }

        // Resolve visibility for non-internal users
        let resolvedVisibility: string | null = null;
        if (visibility && typeof visibility === 'string') {
            const allowed = ['internal', 'client'];
            if (allowed.includes(visibility)) {
                if (visibility === 'internal' && !isInternalRole(req.user!.role)) {
                    resolvedVisibility = 'client';
                } else {
                    resolvedVisibility = visibility;
                }
            }
        }

        // Validate and sanitize created_by
        let validCreatedBy: string | null = null;
        if (created_by && typeof created_by === 'string') {
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (uuidRegex.test(created_by)) {
                validCreatedBy = created_by;
            }
        }

        // Sanitize search
        let safeSearch: string | null = null;
        if (search && typeof search === 'string' && search.trim()) {
            const sanitized = sanitizeSearch(search.trim());
            if (sanitized.length > 0) safeSearch = sanitized;
        }

        const { data, error } = await supabaseAdmin.rpc('get_activity_type_counts', {
            p_tenant_id: tenantId,
            p_date_from: (date_from as string) || null,
            p_date_to: (date_to as string) || null,
            p_type: validType,
            p_visibility: resolvedVisibility,
            p_created_by: validCreatedBy,
            p_search: safeSearch,
        });

        if (error) {
            log.error({ err: error }, 'Activity stats error');
            throw new AppError('Failed to fetch activity stats', 500);
        }

        const counts: Record<string, number> = {};
        let total = 0;
        for (const row of data || []) {
            counts[row.type] = Number(row.count);
            total += Number(row.count);
        }

        // Exclude status_change from total — it's a system-generated record
        const statusChangeCount = counts['status_change'] || 0;
        res.json({
            meeting: counts['meeting'] || 0,
            not: counts['not'] || 0,
            follow_up: counts['follow_up'] || 0,
            sonlandirma_raporu: counts['sonlandirma_raporu'] || 0,
            total: total - statusChangeCount,
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Activity stats error');
        res.status(500).json({ error: 'Failed to fetch activity stats' });
    }
});

// GET /api/activities/users — List users who have created activities in this tenant
router.get('/users', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        // Get distinct created_by user IDs from activities (use dbClient for RLS)
        const db = dbClient(req);
        const { data: activities, error } = await db
            .from('activities')
            .select('created_by')
            .eq('tenant_id', tenantId)
            .not('created_by', 'is', null)
            .limit(5000);

        if (error) {
            log.error({ err: error }, 'Activity users error');
            throw new AppError('Failed to fetch activity users', 500);
        }

        const uniqueIds = [...new Set((activities || []).map((a: any) => a.created_by))];

        if (uniqueIds.length === 0) {
            res.json([]);
            return;
        }

        // Resolve emails via targeted user lookups
        const userMap = new Map<string, { email: string; name?: string }>();
        await Promise.all(
            uniqueIds.map(async (uid) => {
                try {
                    const { data: { user }, error } = await supabaseAdmin.auth.admin.getUserById(uid);
                    if (!error && user) {
                        userMap.set(uid, {
                            email: user.email || uid,
                            name: user.user_metadata?.full_name || user.user_metadata?.name,
                        });
                    }
                } catch {
                    // skip unresolvable users
                }
            })
        );

        const users = uniqueIds
            .filter(id => userMap.has(id))
            .map(id => {
                const info = userMap.get(id)!;
                return { id, email: info.email, ...(info.name ? { name: info.name } : {}) };
            });

        res.json(users);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Activity users error');
        res.status(500).json({ error: 'Failed to fetch activity users' });
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
                res.status(422).json({ error: 'You don\'t have permission to create internal-only notes' });
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

            if (visibility === 'internal' && !isInternalRole(req.user!.role)) {
                res.status(422).json({ error: 'You don\'t have permission to change visibility to internal' });
                return;
            }

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

// DELETE /api/activities/:id — Delete activity
router.delete(
    '/:id',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
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
