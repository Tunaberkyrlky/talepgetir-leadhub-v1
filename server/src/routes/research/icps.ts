/**
 * Research ICPs (B5 — ICP Master).
 * Generate ICP drafts via the strategy model (async, through the worker), then list /
 * score (/10) / edit / approve them. The structured columns are the editable final;
 * ai_draft (set by the worker) freezes the original model output for eval.
 * Pattern mirrors routes/research/projects.ts.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { enqueueJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPES } from '../../lib/research/jobTypes.js';

const log = createLogger('route:research:icps');
const router = Router();

const ICP_STATUSES = ['draft', 'approved', 'rejected'] as const;
// Statuses a generic PATCH may set. 'approved' is intentionally excluded — approval is a
// gated transition (requires human_score) and goes ONLY through POST /:id/approve (062 #6).
const PATCH_STATUSES = ['draft', 'rejected'] as const;
const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');

const strArray = z.array(z.string().min(1).max(500)).max(100);

const generateSchema = z.object({
    project_id: uuidField('Invalid project ID'),
    count: z.number().int().min(1).max(8).optional(),
});

const updateIcpSchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        code: z.string().min(1).max(64).optional(),
        segment: z.string().max(2000).optional(),
        signals: strArray.optional(),
        negative_signals: strArray.optional(),
        neutral_signals: strArray.optional(),
        elimination_rules: strArray.optional(),
        lookalike_companies: strArray.optional(),
        human_score: z.number().int().min(0).max(10).nullable().optional(),
        note: z.string().max(4000).nullable().optional(),
        status: z.enum(PATCH_STATUSES).optional(),
    })
    .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

const approveSchema = z.object({
    human_score: z.number().int().min(0).max(10),
    note: z.string().max(4000).nullable().optional(),
    // Optimistic concurrency (063 #11): the version the client just saved+saw. The approval
    // only lands if the ICP is still at this ruleset — so a concurrent edit (which bumps the
    // version via the trigger) can't be approved unseen. Omit to skip the check (legacy).
    ruleset_version: z.number().int().min(1).optional(),
});

const idParamSchema = z.object({ id: uuidField('Invalid ICP ID') });

// ── POST /api/research/icps/generate — enqueue ICP generation ────────────────
router.post('/generate', requireWriter, validateBody(generateSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { project_id, count } = req.body as z.infer<typeof generateSchema>;

        const { data: project, error: projErr } = await researchSupabaseAdmin
            .from('research_projects')
            .select('id')
            .eq('id', project_id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (projErr) {
            log.error({ err: projErr }, 'project lookup failed');
            throw new AppError('Failed to start ICP generation', 500);
        }
        if (!project) {
            res.status(404).json({ error: 'Research project not found' });
            return;
        }

        const job = await enqueueJob({
            tenantId,
            type: RESEARCH_JOB_TYPES.ICP_GENERATE,
            payload: count ? { count } : {},
            projectId: project_id,
            createdBy: req.user?.id ?? null,
        });
        // 202: accepted, runs in the worker; client polls /api/research/jobs/:id.
        res.status(202).json(job);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'icp generate error');
        next(new AppError('Failed to start ICP generation', 500));
    }
});

// ── GET /api/research/icps?project_id=&status= ──────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { project_id, status } = req.query;

        let query = researchSupabaseAdmin
            .from('research_icps')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false });

        if (project_id && typeof project_id === 'string') {
            if (!uuidField().safeParse(project_id).success) {
                res.status(400).json({ error: 'Invalid project_id' });
                return;
            }
            query = query.eq('project_id', project_id);
        }
        if (status && typeof status === 'string') {
            if (!ICP_STATUSES.includes(status as (typeof ICP_STATUSES)[number])) {
                res.status(400).json({ error: 'Invalid ICP status' });
                return;
            }
            query = query.eq('status', status);
        }

        const { data, error } = await query;
        if (error) {
            log.error({ err: error }, 'list icps failed');
            throw new AppError('Failed to fetch ICPs', 500);
        }
        res.json({ data: data || [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'list icps error');
        next(new AppError('Failed to fetch ICPs', 500));
    }
});

// ── GET /api/research/icps/:id ──────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid ICP ID' });
            return;
        }
        const tenantId = req.tenantId!;

        const { data, error } = await researchSupabaseAdmin
            .from('research_icps')
            .select('*')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (error) {
            log.error({ err: error }, 'get icp failed');
            throw new AppError('Failed to fetch ICP', 500);
        }
        if (!data) {
            res.status(404).json({ error: 'ICP not found' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'get icp error');
        next(new AppError('Failed to fetch ICP', 500));
    }
});

// ── PATCH /api/research/icps/:id — edit the final + score ───────────────────
router.patch('/:id', requireWriter, validateBody(updateIcpSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid ICP ID' });
            return;
        }
        const tenantId = req.tenantId!;
        const patch = { ...(req.body as z.infer<typeof updateIcpSchema>) } as Record<string, unknown>;

        // ruleset_version bump (and the approved→draft revert on a ruleset edit) is done
        // ATOMICALLY by the research_icps_ruleset_guard trigger (062 #6) — no read-modify-write
        // here, so two concurrent edits can't both compute the same N+1. The route just writes
        // the patch; the trigger compares OLD vs NEW and adjusts version/status as needed.
        const { data, error } = await researchSupabaseAdmin
            .from('research_icps')
            .update(patch)
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .select()
            .maybeSingle();
        if (error) {
            log.error({ err: error }, 'update icp failed');
            throw new AppError('Failed to update ICP', 500);
        }
        if (!data) {
            res.status(404).json({ error: 'ICP not found' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'update icp error');
        next(new AppError('Failed to update ICP', 500));
    }
});

// ── POST /api/research/icps/:id/approve — human /10 gate (B5) ────────────────
router.post('/:id/approve', requireWriter, validateBody(approveSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid ICP ID' });
            return;
        }
        const tenantId = req.tenantId!;
        const { human_score, note, ruleset_version } = req.body as z.infer<typeof approveSchema>;

        const patch: Record<string, unknown> = { status: 'approved', human_score };
        if (note !== undefined) patch.note = note;

        let query = researchSupabaseAdmin
            .from('research_icps')
            .update(patch)
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId);
        // CAS: only approve if the ruleset is still the one the client saved+reviewed. A
        // concurrent edit bumps ruleset_version (trigger), so this match fails → 409, never
        // an unseen approval.
        if (ruleset_version !== undefined) query = query.eq('ruleset_version', ruleset_version);

        const { data, error } = await query.select().maybeSingle();
        if (error) {
            log.error({ err: error }, 'approve icp failed');
            throw new AppError('Failed to approve ICP', 500);
        }
        if (!data) {
            // No row matched: either the ICP doesn't exist, or its ruleset moved under us.
            if (ruleset_version !== undefined) {
                const { data: exists } = await researchSupabaseAdmin
                    .from('research_icps')
                    .select('id, ruleset_version')
                    .eq('id', parsed.data.id)
                    .eq('tenant_id', tenantId)
                    .maybeSingle();
                if (exists) {
                    res.status(409).json({
                        error: 'ICP changed since you loaded it; review the latest edits and approve again',
                        current_ruleset_version: (exists as { ruleset_version: number }).ruleset_version,
                    });
                    return;
                }
            }
            res.status(404).json({ error: 'ICP not found' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'approve icp error');
        next(new AppError('Failed to approve ICP', 500));
    }
});

export default router;
