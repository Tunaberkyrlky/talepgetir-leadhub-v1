/**
 * Research HS candidates (WP11 — product classification + market evidence).
 * AI proposes six-digit codes validated against the live UN Comtrade nomenclature;
 * the customer approves/rejects them before market:analyze ranks world importers and
 * seller-country bilateral exports without an LLM. Evidence persists to research_markets
 * and feeds geo:analyze's evidence cards per WP11 §6 of the design document.
 * Pattern mirrors routes/research/icps.ts.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { enqueueJob, ResearchJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPES } from '../../lib/research/jobTypes.js';
import { sanitizeJobForRole } from '../../lib/research/sanitize.js';
import { effectiveCostRole } from '../../lib/research/freshRole.js';

const log = createLogger('route:research:hs');
const router = Router();

const HS_STATUSES = ['candidate', 'approved', 'rejected'] as const;
const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');

const projectSchema = z.object({
    project_id: uuidField('Invalid project ID'),
});

const updateHsSchema = z.object({
    status: z.enum(['approved', 'rejected']),
});

const idParamSchema = z.object({ id: uuidField('Invalid HS code ID') });

/**
 * Best-effort in-flight guard (advisory, check-then-enqueue — same shape as
 * icps.ts's findInflightGeneration). Both WP11 jobs carry project_id as a real
 * research_jobs column, so the guard filters directly rather than inspecting payload.
 */
async function findInflightHsMatch(tenantId: string, projectId: string): Promise<ResearchJob | null> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_jobs')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('project_id', projectId)
        .eq('type', RESEARCH_JOB_TYPES.HS_MATCH)
        .in('status', ['queued', 'running'])
        .limit(1)
        .maybeSingle();
    if (error) {
        log.error({ err: error }, 'hs:match in-flight check failed');
        throw new AppError('Failed to start HS matching', 500);
    }
    return (data as ResearchJob | null) ?? null;
}

/** Advisory project-column guard for one queued/running market analysis. */
async function findInflightMarketAnalysis(tenantId: string, projectId: string): Promise<ResearchJob | null> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_jobs')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('project_id', projectId)
        .eq('type', RESEARCH_JOB_TYPES.MARKET_ANALYZE)
        .in('status', ['queued', 'running'])
        .limit(1)
        .maybeSingle();
    if (error) {
        log.error({ err: error }, 'market:analyze in-flight check failed');
        throw new AppError('Failed to start market analysis', 500);
    }
    return (data as ResearchJob | null) ?? null;
}

// ── POST /api/research/hs/match — enqueue validated HS proposals ────────────
router.post('/match', requireWriter, validateBody(projectSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { project_id } = req.body as z.infer<typeof projectSchema>;

        const { data: project, error: projErr } = await researchSupabaseAdmin
            .from('research_projects')
            .select('id')
            .eq('id', project_id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (projErr) {
            log.error({ err: projErr }, 'project lookup failed');
            throw new AppError('Failed to start HS matching', 500);
        }
        if (!project) {
            res.status(404).json({ error: 'Research project not found' });
            return;
        }

        const inflight = await findInflightHsMatch(tenantId, project_id);
        if (inflight) {
            res.status(200).json(sanitizeJobForRole(inflight as unknown as Record<string, unknown>, await effectiveCostRole(req.user, req.tenantId)));
            return;
        }

        let job: ResearchJob;
        try {
            job = await enqueueJob({
                tenantId,
                type: RESEARCH_JOB_TYPES.HS_MATCH,
                payload: {},
                projectId: project_id,
                createdBy: req.user?.id ?? null,
            });
        } catch (enqueueErr) {
            // The DB-level partial unique index for hs:match closes the check-then-enqueue race
            // the same way migration 117 does for market:analyze: adopt the winning concurrent
            // job on a unique violation (23505) rather than returning a raw 500.
            if ((enqueueErr as { code?: string })?.code === '23505') {
                const raced = await findInflightHsMatch(tenantId, project_id);
                if (raced) {
                    res.status(200).json(sanitizeJobForRole(raced as unknown as Record<string, unknown>, await effectiveCostRole(req.user, req.tenantId)));
                    return;
                }
            }
            throw enqueueErr;
        }
        res.status(202).json(sanitizeJobForRole(job as unknown as Record<string, unknown>, await effectiveCostRole(req.user, req.tenantId)));
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'hs match error');
        next(new AppError('Failed to start HS matching', 500));
    }
});

// ── GET /api/research/hs?project_id=&status= ────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { project_id, status } = req.query;

        if (!project_id || typeof project_id !== 'string') {
            res.status(400).json({ error: 'project_id is required' });
            return;
        }
        if (!uuidField().safeParse(project_id).success) {
            res.status(400).json({ error: 'Invalid project_id' });
            return;
        }

        let query = researchSupabaseAdmin
            .from('research_hs_codes')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('project_id', project_id)
            .order('created_at', { ascending: false });

        if (status !== undefined) {
            if (typeof status !== 'string' || !HS_STATUSES.includes(status as (typeof HS_STATUSES)[number])) {
                res.status(400).json({ error: 'Invalid HS status' });
                return;
            }
            query = query.eq('status', status);
        }

        const { data, error } = await query;
        if (error) {
            log.error({ err: error }, 'list hs codes failed');
            throw new AppError('Failed to fetch HS codes', 500);
        }
        res.json({ data: data || [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'list hs codes error');
        next(new AppError('Failed to fetch HS codes', 500));
    }
});

// ── PATCH /api/research/hs/:id — approve or reject a candidate ──────────────
router.patch('/:id', requireWriter, validateBody(updateHsSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid HS code ID' });
            return;
        }
        const tenantId = req.tenantId!;
        const { status } = req.body as z.infer<typeof updateHsSchema>;

        const { data, error } = await researchSupabaseAdmin
            .from('research_hs_codes')
            .update({ status })
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .select()
            .maybeSingle();
        if (error) {
            log.error({ err: error }, 'update hs code failed');
            throw new AppError('Failed to update HS code', 500);
        }
        if (!data) {
            res.status(404).json({ error: 'HS code not found' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'update hs code error');
        next(new AppError('Failed to update HS code', 500));
    }
});

// ── POST /api/research/hs/market-analyze — enqueue Comtrade evidence ────────
router.post('/market-analyze', requireWriter, validateBody(projectSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { project_id } = req.body as z.infer<typeof projectSchema>;

        const { data: project, error: projErr } = await researchSupabaseAdmin
            .from('research_projects')
            .select('id')
            .eq('id', project_id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (projErr) {
            log.error({ err: projErr }, 'project lookup failed');
            throw new AppError('Failed to start market analysis', 500);
        }
        if (!project) {
            res.status(404).json({ error: 'Research project not found' });
            return;
        }

        const { count, error: countErr } = await researchSupabaseAdmin
            .from('research_hs_codes')
            .select('id', { count: 'exact', head: true })
            .eq('project_id', project_id)
            .eq('tenant_id', tenantId)
            .eq('status', 'approved');
        if (countErr) {
            log.error({ err: countErr }, 'approved hs count failed');
            throw new AppError('Failed to start market analysis', 500);
        }
        if (!count) {
            res.status(409).json({ error: 'At least one approved HS code is required before running market analysis' });
            return;
        }

        const inflight = await findInflightMarketAnalysis(tenantId, project_id);
        if (inflight) {
            res.status(200).json(sanitizeJobForRole(inflight as unknown as Record<string, unknown>, await effectiveCostRole(req.user, req.tenantId)));
            return;
        }

        let job: ResearchJob;
        try {
            job = await enqueueJob({
                tenantId,
                type: RESEARCH_JOB_TYPES.MARKET_ANALYZE,
                payload: {},
                projectId: project_id,
                createdBy: req.user?.id ?? null,
            });
        } catch (enqueueErr) {
            // Migration 117's partial unique index closes the check-then-enqueue race: a
            // concurrent request that won it lands here as a unique violation (23505) instead
            // of a duplicate in-flight job — adopt the winner's job rather than 500ing.
            if ((enqueueErr as { code?: string })?.code === '23505') {
                const raced = await findInflightMarketAnalysis(tenantId, project_id);
                if (raced) {
                    res.status(200).json(sanitizeJobForRole(raced as unknown as Record<string, unknown>, await effectiveCostRole(req.user, req.tenantId)));
                    return;
                }
            }
            throw enqueueErr;
        }
        res.status(202).json(sanitizeJobForRole(job as unknown as Record<string, unknown>, await effectiveCostRole(req.user, req.tenantId)));
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'market analyze error');
        next(new AppError('Failed to start market analysis', 500));
    }
});

export default router;
