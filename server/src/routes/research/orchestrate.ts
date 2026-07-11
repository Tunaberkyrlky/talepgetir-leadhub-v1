/**
 * Research orchestrate (WP9 — adım 18, "Derin araştırma çalışıyor").
 * One-click conductor for an approved icp × geo cell: enqueues research:orchestrate, which
 * itself enqueues + polls the EXISTING channels:discover/harvest (Y1) and harvest:run (Y3)
 * jobs in sequence until scale_target/credits/full coverage stops it. This route only gates
 * admission (approved cell, one-in-flight, credits) — every write happens in the jobs it
 * conducts, unchanged. Pattern mirrors routes/research/channels.ts.
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
import { availableCredits } from '../../lib/research/engine/ledger.js';
import { sanitizeJobForRole } from '../../lib/research/sanitize.js';
import { effectiveCostRole } from '../../lib/research/freshRole.js';

const log = createLogger('route:research:orchestrate');
const router = Router();

const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');

const runSchema = z.object({
    icp_id: uuidField('Invalid ICP ID'),
    geo_id: uuidField('Invalid geography ID'),
});

/** Best-effort in-flight guard (advisory, channels.ts's findInflight pattern): adopt an
 *  orchestrate job already running this cell instead of stacking a second one — the conductor
 *  itself is idempotent to re-adopt (it just re-reads state), but a second live instance would
 *  double up on decision-making (e.g. two conductors could each enqueue a harvest for the same
 *  ICP moments apart, both finding "nothing in flight yet"). */
async function findInflightOrchestrate(tenantId: string, icpId: string, geoId: string): Promise<ResearchJob | null> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_jobs')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('type', RESEARCH_JOB_TYPES.ORCHESTRATE)
        .in('status', ['queued', 'running'])
        .contains('payload', { icp_id: icpId, geo_id: geoId })
        .limit(1)
        .maybeSingle();
    if (error) {
        log.error({ err: error }, 'orchestrate in-flight check failed');
        throw new AppError('Failed to start deep research', 500);
    }
    return (data as ResearchJob | null) ?? null;
}

// ── POST /api/research/orchestrate/run — conduct Y1+Y3 for one approved cell ─────
router.post('/run', requireWriter, validateBody(runSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { icp_id, geo_id } = req.body as z.infer<typeof runSchema>;

        const { data: icp, error: icpErr } = await researchSupabaseAdmin
            .from('research_icps')
            .select('id, project_id, status')
            .eq('id', icp_id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (icpErr) {
            log.error({ err: icpErr }, 'orchestrate icp lookup failed');
            throw new AppError('Failed to start deep research', 500);
        }
        if (!icp) {
            res.status(404).json({ error: 'ICP not found' });
            return;
        }
        if ((icp as { status: string }).status !== 'approved') {
            res.status(409).json({ error: 'ICP must be approved before deep research' });
            return;
        }

        const { data: geo, error: geoErr } = await researchSupabaseAdmin
            .from('research_geographies')
            .select('id, icp_id, status')
            .eq('id', geo_id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (geoErr) {
            log.error({ err: geoErr }, 'orchestrate geo lookup failed');
            throw new AppError('Failed to start deep research', 500);
        }
        if (!geo || (geo as { icp_id: string | null }).icp_id !== icp_id) {
            res.status(404).json({ error: 'Geography not found for this ICP' });
            return;
        }
        if ((geo as { status: string }).status !== 'approved') {
            res.status(409).json({ error: 'Approve this geography before deep research' });
            return;
        }

        const costRole = await effectiveCostRole(req.user, req.tenantId);

        const inflight = await findInflightOrchestrate(tenantId, icp_id, geo_id);
        if (inflight) {
            res.status(200).json(sanitizeJobForRole(inflight as unknown as Record<string, unknown>, costRole));
            return;
        }

        // NOTE (P2 fix, adversarial review): this route deliberately does NOT 409 on an
        // in-flight harvest for this ICP the way harvest.ts/channels.ts do — those routes
        // refuse because THEY would otherwise enqueue a competing job themselves. The
        // conductor doesn't enqueue anything on its very first move; its own decide-loop
        // checks for exactly this (findInflightHarvest) before its FIRST enqueue and adopts
        // whatever it finds. A 409 here would tell the customer to wait for something that was
        // never queued in the first place — contradictory, since the copy also claims deep
        // research "will pick it up automatically" (it will, because the job below starts
        // regardless and adopts on its first iteration, not because anything was queued now).

        const available = await availableCredits(tenantId);
        if (available < 1) {
            res.status(402).json({ error: 'Insufficient research credits', available });
            return;
        }

        const job = await enqueueJob({
            tenantId,
            type: RESEARCH_JOB_TYPES.ORCHESTRATE,
            payload: { icp_id, geo_id },
            projectId: (icp as { project_id: string }).project_id,
            // Long-running conductor, not cost-idempotent to retry from scratch — a failed
            // attempt is simply re-run (new job); its own children are unaffected either way.
            maxAttempts: 1,
            createdBy: req.user?.id ?? null,
        });
        res.status(202).json(sanitizeJobForRole(job as unknown as Record<string, unknown>, costRole));
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'orchestrate run error');
        next(new AppError('Failed to start deep research', 500));
    }
});

export default router;
