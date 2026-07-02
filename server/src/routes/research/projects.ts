/**
 * Research Projects — minimal CRUD (skeleton).
 * One project per research engagement; holds the company profile + lifecycle.
 * Pattern: routes/feedback.ts (validation + researchSupabaseAdmin + manual tenant scope).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';

const log = createLogger('route:research:projects');
const router = Router();

const PROJECT_STATUSES = [
    'setup', 'icp', 'calibration', 'scaling', 'enrichment', 'handoff', 'paused', 'archived',
] as const;

// The profile is freeform JSON, but it is (a) persisted and (b) serialized straight into
// an LLM prompt, so it must be bounded — otherwise a client could store ~10MB of nested
// data and drive unbounded prompt cost (062 #10). Cap TOTAL keys (recursively, not just
// top-level) + total serialized BYTES (utf-8, not utf-16 code units).
const MAX_PROFILE_KEYS = 200;
const MAX_PROFILE_BYTES = 20_000;

function countKeysDeep(v: unknown, acc = { n: 0 }): number {
    if (v && typeof v === 'object') {
        if (Array.isArray(v)) {
            for (const item of v) countKeysDeep(item, acc);
        } else {
            for (const [, val] of Object.entries(v)) {
                acc.n++;
                countKeysDeep(val, acc);
            }
        }
    }
    return acc.n;
}

const jsonRecord = z
    .record(z.string(), z.unknown())
    .refine((o) => countKeysDeep(o) <= MAX_PROFILE_KEYS, {
        message: `profile has too many keys (max ${MAX_PROFILE_KEYS} total)`,
    })
    .refine((o) => Buffer.byteLength(JSON.stringify(o), 'utf8') <= MAX_PROFILE_BYTES, {
        message: `profile is too large (max ${MAX_PROFILE_BYTES} bytes serialized)`,
    });

const createProjectSchema = z.object({
    name: z.string().min(1).max(200),
    profile: jsonRecord.optional(),
});

const updateProjectSchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        status: z.enum(PROJECT_STATUSES).optional(),
        profile: jsonRecord.optional(),
        scale_target: z.number().int().min(0).max(1_000_000).nullable().optional(),
    })
    .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

const idParamSchema = z.object({ id: uuidField('Invalid project ID') });

// Writes require an admin role (research is self-serve for client_admin); reads
// are open to any authenticated tenant member.
const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');

// ── POST /api/research/projects ─────────────────────────────────────────────
router.post('/', requireWriter, validateBody(createProjectSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { name, profile } = req.body as z.infer<typeof createProjectSchema>;

        const { data, error } = await researchSupabaseAdmin
            .from('research_projects')
            .insert({
                tenant_id: tenantId,
                name,
                profile: profile ?? {},
                created_by: req.user?.id ?? null,
            })
            .select()
            .single();

        if (error) {
            log.error({ err: error }, 'create project failed');
            throw new AppError('Failed to create research project', 500);
        }
        res.status(201).json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'create project error');
        next(new AppError('Failed to create research project', 500));
    }
});

// ── GET /api/research/projects ──────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { status } = req.query;
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
        const offset = (page - 1) * limit;

        let query = researchSupabaseAdmin
            .from('research_projects')
            .select('*', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (status && typeof status === 'string') {
            if (!PROJECT_STATUSES.includes(status as (typeof PROJECT_STATUSES)[number])) {
                res.status(400).json({ error: 'Invalid project status' });
                return;
            }
            query = query.eq('status', status);
        }

        const { data, error, count } = await query;
        if (error) {
            log.error({ err: error }, 'list projects failed');
            throw new AppError('Failed to fetch research projects', 500);
        }

        res.json({
            data: data || [],
            pagination: {
                total: count || 0,
                page,
                limit,
                hasNext: offset + limit < (count || 0),
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'list projects error');
        next(new AppError('Failed to fetch research projects', 500));
    }
});

// ── GET /api/research/projects/:id ──────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid project ID' });
            return;
        }
        const tenantId = req.tenantId!;

        const { data, error } = await researchSupabaseAdmin
            .from('research_projects')
            .select('*')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();

        if (error) {
            log.error({ err: error }, 'get project failed');
            throw new AppError('Failed to fetch research project', 500);
        }
        if (!data) {
            res.status(404).json({ error: 'Research project not found' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'get project error');
        next(new AppError('Failed to fetch research project', 500));
    }
});

// ── PATCH /api/research/projects/:id ────────────────────────────────────────
router.patch('/:id', requireWriter, validateBody(updateProjectSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid project ID' });
            return;
        }
        const tenantId = req.tenantId!;

        const { data, error } = await researchSupabaseAdmin
            .from('research_projects')
            .update(req.body)
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .select()
            .maybeSingle();

        if (error) {
            log.error({ err: error }, 'update project failed');
            throw new AppError('Failed to update research project', 500);
        }
        if (!data) {
            res.status(404).json({ error: 'Research project not found' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'update project error');
        next(new AppError('Failed to update research project', 500));
    }
});

// ── DELETE /api/research/projects/:id ───────────────────────────────────────
router.delete('/:id', requireRole('superadmin', 'client_admin'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid project ID' });
            return;
        }
        const tenantId = req.tenantId!;

        const { error } = await researchSupabaseAdmin
            .from('research_projects')
            .delete()
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId);

        if (error) {
            log.error({ err: error }, 'delete project failed');
            throw new AppError('Failed to delete research project', 500);
        }
        res.status(204).send();
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'delete project error');
        next(new AppError('Failed to delete research project', 500));
    }
});

export default router;
