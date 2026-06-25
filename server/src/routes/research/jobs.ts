/**
 * Research Jobs — enqueue + status (skeleton).
 * Thin HTTP layer over lib/research/queue.ts. The worker does the actual work.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { enqueueJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPE_VALUES, isKnownJobType } from '../../lib/research/jobTypes.js';

const log = createLogger('route:research:jobs');
const router = Router();

const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;

const enqueueSchema = z.object({
    type: z.string().min(1).max(64),
    payload: z.record(z.string(), z.unknown()).optional(),
    project_id: uuidField('Invalid project ID').nullable().optional(),
    priority: z.number().int().min(-100).max(100).optional(),
});

const idParamSchema = z.object({ id: uuidField('Invalid job ID') });

const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');

// ── POST /api/research/jobs — enqueue a job ─────────────────────────────────
router.post('/', requireWriter, validateBody(enqueueSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { type, payload, project_id, priority } = req.body as z.infer<typeof enqueueSchema>;

        if (!isKnownJobType(type)) {
            res.status(400).json({ error: `Unknown job type. Allowed: ${RESEARCH_JOB_TYPE_VALUES.join(', ')}` });
            return;
        }

        // If a project is referenced, it must belong to this tenant.
        if (project_id) {
            const { data: project, error: projErr } = await researchSupabaseAdmin
                .from('research_projects')
                .select('id')
                .eq('id', project_id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (projErr) {
                log.error({ err: projErr }, 'project lookup failed');
                throw new AppError('Failed to enqueue job', 500);
            }
            if (!project) {
                res.status(404).json({ error: 'Research project not found' });
                return;
            }
        }

        const job = await enqueueJob({
            tenantId,
            type,
            payload: payload ?? {},
            projectId: project_id ?? null,
            priority,
            createdBy: req.user?.id ?? null,
        });

        res.status(201).json(job);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'enqueue job error');
        next(new AppError('Failed to enqueue job', 500));
    }
});

// ── GET /api/research/jobs — list jobs for the tenant ───────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { status, type, project_id } = req.query;
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
        const offset = (page - 1) * limit;

        let query = researchSupabaseAdmin
            .from('research_jobs')
            .select('*', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (status && typeof status === 'string') {
            if (!JOB_STATUSES.includes(status as (typeof JOB_STATUSES)[number])) {
                res.status(400).json({ error: 'Invalid job status' });
                return;
            }
            query = query.eq('status', status);
        }
        if (type && typeof type === 'string') query = query.eq('type', type);
        if (project_id && typeof project_id === 'string') {
            // Validate before it hits a UUID column, so a bad value is a 400, not a 500.
            if (!uuidField().safeParse(project_id).success) {
                res.status(400).json({ error: 'Invalid project_id' });
                return;
            }
            query = query.eq('project_id', project_id);
        }

        const { data, error, count } = await query;
        if (error) {
            log.error({ err: error }, 'list jobs failed');
            throw new AppError('Failed to fetch jobs', 500);
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
        log.error({ err }, 'list jobs error');
        next(new AppError('Failed to fetch jobs', 500));
    }
});

// ── GET /api/research/jobs/:id — job status ─────────────────────────────────
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid job ID' });
            return;
        }
        const tenantId = req.tenantId!;

        const { data, error } = await researchSupabaseAdmin
            .from('research_jobs')
            .select('*')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();

        if (error) {
            log.error({ err: error }, 'get job failed');
            throw new AppError('Failed to fetch job', 500);
        }
        if (!data) {
            res.status(404).json({ error: 'Job not found' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'get job error');
        next(new AppError('Failed to fetch job', 500));
    }
});

// ── POST /api/research/jobs/:id/cancel — cancel a job not yet running ────────
router.post('/:id/cancel', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid job ID' });
            return;
        }
        const tenantId = req.tenantId!;

        // Only queued jobs can be canceled cleanly; running jobs are left to the
        // worker (cooperative cancellation comes later).
        const { data, error } = await researchSupabaseAdmin
            .from('research_jobs')
            .update({ status: 'canceled', finished_at: new Date().toISOString() })
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .eq('status', 'queued')
            .select()
            .maybeSingle();

        if (error) {
            log.error({ err: error }, 'cancel job failed');
            throw new AppError('Failed to cancel job', 500);
        }
        if (!data) {
            res.status(409).json({ error: 'Job not found or not in a cancelable (queued) state' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'cancel job error');
        next(new AppError('Failed to cancel job', 500));
    }
});

export default router;
