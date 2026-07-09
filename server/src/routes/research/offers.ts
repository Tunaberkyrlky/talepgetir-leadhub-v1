/**
 * Research offers (WP4 — the offer/angle layer).
 * An offer is one evidence-bound outreach ANGLE for an approved ICP (pain hypothesis, value
 * prop, proof points, objections) — NOT message copy (that lives in TG-Core campaigns).
 * offer:generate (strategy role) drafts 3-5; the customer edits + /10-approves (ICP/geo human
 * gate). APPROVED angles feed the validation pass (angle_suggestion) and the CRM export
 * (Research Angle custom field). angle_code is immutable after creation — verdicts reference
 * it by value, so renaming would orphan every suggestion pointing at it.
 * Pattern mirrors routes/research/geographies.ts + channels.ts.
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

const log = createLogger('route:research:offers');
const router = Router();

const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');

// COGS surface bound (review P2, the MAX_CELLS_PER_ICP reasoning): every generate run drafts up
// to 5 NEW cards on house Opus with zero credits consumed — without a ceiling a writer role
// could loop it forever while the taken-codes prompt section grows each round. Generous for
// real use (an outreach playbook rarely needs >20 angles per segment), hard for abuse.
const MAX_OFFERS_PER_ICP = 20;

const generateSchema = z.object({
    icp_id: uuidField('Invalid ICP ID'),
    geo_id: uuidField('Invalid geography ID').optional(),
});

const noFence = (max: number) =>
    z.string().min(1).max(max).refine((s) => !s.includes('<<<'), { message: 'fence markers not allowed' });

const updateSchema = z
    .object({
        pain_hypothesis: noFence(400).optional(),
        value_prop: noFence(500).optional(),
        proof_points: z.array(noFence(300)).min(1).max(4).optional(),
        objections: z.array(noFence(300)).max(3).optional(),
        language: z.string().min(2).max(12).nullable().optional(),
        note: z.string().max(2000).optional(),
        human_score: z.number().int().min(0).max(10).optional(),
    })
    .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

const approveSchema = z.object({
    human_score: z.number().int().min(0).max(10),
    // CAS token (geographies approve pattern, REQUIRED): approval binds to the exact card the
    // human reviewed — every edit bumps updated_at (trigger), so a stale card 409s.
    updated_at: z.string().datetime({ offset: true, message: 'updated_at must be a valid ISO datetime' }),
});

const idParamSchema = z.object({ id: uuidField('Invalid offer ID') });

/** Active (non-rejected) cards for an ICP — the ceiling denominator. */
async function activeOfferCount(tenantId: string, icpId: string): Promise<number> {
    const { count, error } = await researchSupabaseAdmin
        .from('research_offers')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('icp_id', icpId)
        .neq('status', 'rejected');
    if (error) throw error;
    return count ?? 0;
}

// ── POST /api/research/offers/generate — draft 3-5 angles for an approved ICP ─
router.post('/generate', requireWriter, validateBody(generateSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { icp_id, geo_id } = req.body as z.infer<typeof generateSchema>;

        const { data: icp, error: icpErr } = await researchSupabaseAdmin
            .from('research_icps')
            .select('id, project_id, status')
            .eq('id', icp_id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (icpErr) {
            log.error({ err: icpErr }, 'offer generate icp lookup failed');
            throw new AppError('Failed to start offer generation', 500);
        }
        if (!icp) {
            res.status(404).json({ error: 'ICP not found' });
            return;
        }
        if (icp.status !== 'approved') {
            res.status(409).json({ error: 'Approve the ICP before generating offers' });
            return;
        }
        if (geo_id) {
            const { data: geo } = await researchSupabaseAdmin
                .from('research_geographies')
                .select('id, icp_id')
                .eq('id', geo_id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (!geo || geo.icp_id !== icp_id) {
                res.status(404).json({ error: 'Geography not found for this ICP' });
                return;
            }
        }

        const costRole = await effectiveCostRole(req.user, req.tenantId);

        // Advisory in-flight guard (per ICP) + sanitized adopt (068 rule).
        const { data: inflight, error: infErr } = await researchSupabaseAdmin
            .from('research_jobs')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('type', RESEARCH_JOB_TYPES.OFFER_GENERATE)
            .in('status', ['queued', 'running'])
            .contains('payload', { icp_id })
            .limit(1)
            .maybeSingle();
        if (infErr) {
            log.error({ err: infErr }, 'offer generate in-flight check failed');
            throw new AppError('Failed to start offer generation', 500);
        }
        if (inflight) {
            res.status(200).json(sanitizeJobForRole(inflight as unknown as Record<string, unknown>, costRole));
            return;
        }

        // Ceiling (advisory count — an abuse bound, not an invariant; razor-thin races are fine).
        let offerCount = 0;
        try {
            offerCount = await activeOfferCount(tenantId, icp_id);
        } catch (cntErr) {
            log.error({ err: cntErr }, 'offer count failed');
            throw new AppError('Failed to start offer generation', 500);
        }
        if (offerCount >= MAX_OFFERS_PER_ICP) {
            res.status(409).json({ error: `This ICP already has ${MAX_OFFERS_PER_ICP} offer angles — edit or reject existing cards instead of generating more` });
            return;
        }

        // Fast-fail credit gate: offers are unbilled strategy COGS, but a zero-credit tenant
        // has no harvest path to ever consume the angle map.
        const available = await availableCredits(tenantId);
        if (available < 1) {
            res.status(402).json({ error: 'Insufficient research credits', available });
            return;
        }

        const job = await enqueueJob({
            tenantId,
            type: RESEARCH_JOB_TYPES.OFFER_GENERATE,
            payload: { icp_id, ...(geo_id ? { geo_id } : {}) },
            projectId: (icp as { project_id: string }).project_id,
            // Strategy-model spend, not cost-idempotent — run once; a failure is simply re-run.
            maxAttempts: 1,
            createdBy: req.user?.id ?? null,
        });
        res.status(202).json(sanitizeJobForRole(job as unknown as Record<string, unknown>, costRole));
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'generate offers error');
        next(new AppError('Failed to start offer generation', 500));
    }
});

// ── GET /api/research/offers?icp_id= ──────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { icp_id } = req.query;
        if (!icp_id || typeof icp_id !== 'string' || !uuidField().safeParse(icp_id).success) {
            res.status(400).json({ error: 'icp_id is required' });
            return;
        }
        const { data, error } = await researchSupabaseAdmin
            .from('research_offers')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('icp_id', icp_id)
            .order('created_at', { ascending: true });
        if (error) {
            log.error({ err: error }, 'list offers failed');
            throw new AppError('Failed to fetch offers', 500);
        }
        res.json({ data: data || [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'list offers error');
        next(new AppError('Failed to fetch offers', 500));
    }
});

// ── PATCH /api/research/offers/:id — edit the card (demotes to draft) ─────────
router.patch('/:id', requireWriter, validateBody(updateSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid offer ID' });
            return;
        }
        const tenantId = req.tenantId!;
        const body = req.body as z.infer<typeof updateSchema>;

        // Reactivation gate (codex P2): a content edit moves the card to 'draft' — on a
        // REJECTED card that re-occupies a ceiling slot, so it must pass the same bound as
        // a fresh generation. Note/score-only PATCHes leave a rejected card rejected.
        const { data: current, error: curErr } = await researchSupabaseAdmin
            .from('research_offers')
            .select('id, icp_id, status')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (curErr) {
            log.error({ err: curErr }, 'offer lookup failed');
            throw new AppError('Failed to update offer', 500);
        }
        if (!current) {
            res.status(404).json({ error: 'Offer not found' });
            return;
        }

        const patch: Record<string, unknown> = {};
        let contentEdited = false;
        for (const key of ['pain_hypothesis', 'value_prop', 'proof_points', 'objections', 'language'] as const) {
            if (body[key] !== undefined) { patch[key] = body[key]; contentEdited = true; }
        }
        if (body.note !== undefined) patch.note = body.note;
        if (body.human_score !== undefined) patch.human_score = body.human_score;
        // An edited card must be re-approved (geographies convention — explicit demotion, no trigger).
        if (contentEdited) patch.status = 'draft';
        if (contentEdited && current.status === 'rejected') {
            const active = await activeOfferCount(tenantId, current.icp_id as string);
            if (active >= MAX_OFFERS_PER_ICP) {
                res.status(409).json({ error: `This ICP already has ${MAX_OFFERS_PER_ICP} offer angles — reject another card before reactivating this one` });
                return;
            }
        }

        const { data, error } = await researchSupabaseAdmin
            .from('research_offers')
            .update(patch)
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .select()
            .maybeSingle();
        if (error) {
            log.error({ err: error }, 'update offer failed');
            throw new AppError('Failed to update offer', 500);
        }
        if (!data) {
            res.status(404).json({ error: 'Offer not found' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'update offer error');
        next(new AppError('Failed to update offer', 500));
    }
});

// ── POST /api/research/offers/:id/approve — human /10 gate, CAS'd ─────────────
router.post('/:id/approve', requireWriter, validateBody(approveSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid offer ID' });
            return;
        }
        const tenantId = req.tenantId!;
        const { human_score, updated_at } = req.body as z.infer<typeof approveSchema>;

        // Reactivation gate (codex P2): approving a REJECTED card re-occupies a ceiling slot.
        const { data: current, error: curErr } = await researchSupabaseAdmin
            .from('research_offers')
            .select('id, icp_id, status')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (curErr) {
            log.error({ err: curErr }, 'approve offer lookup failed');
            throw new AppError('Failed to approve offer', 500);
        }
        if (!current) {
            res.status(404).json({ error: 'Offer not found' });
            return;
        }
        if (current.status === 'rejected') {
            const active = await activeOfferCount(tenantId, current.icp_id as string);
            if (active >= MAX_OFFERS_PER_ICP) {
                res.status(409).json({ error: `This ICP already has ${MAX_OFFERS_PER_ICP} offer angles — reject another card before reactivating this one` });
                return;
            }
        }

        const { data, error } = await researchSupabaseAdmin
            .from('research_offers')
            .update({ status: 'approved', human_score })
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .eq('updated_at', updated_at)
            .select()
            .maybeSingle();
        if (error) {
            log.error({ err: error }, 'approve offer failed');
            throw new AppError('Failed to approve offer', 500);
        }
        if (!data) {
            const { data: exists } = await researchSupabaseAdmin
                .from('research_offers')
                .select('id, updated_at')
                .eq('id', parsed.data.id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (exists) {
                res.status(409).json({
                    error: 'Offer changed since you loaded it; review the latest card and approve again',
                    current_updated_at: (exists as { updated_at: string }).updated_at,
                });
                return;
            }
            res.status(404).json({ error: 'Offer not found' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'approve offer error');
        next(new AppError('Failed to approve offer', 500));
    }
});

// ── POST /api/research/offers/:id/reject — free a ceiling slot ────────────────
// Rejected cards stop counting toward MAX_OFFERS_PER_ICP, disappear from the harvest angle
// map (approved-only read) and keep their history (no delete — the code stays reserved by
// the unique index, so a regeneration can't silently recreate a rejected angle).
router.post('/:id/reject', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid offer ID' });
            return;
        }
        const tenantId = req.tenantId!;
        const { data, error } = await researchSupabaseAdmin
            .from('research_offers')
            .update({ status: 'rejected' })
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .select()
            .maybeSingle();
        if (error) {
            log.error({ err: error }, 'reject offer failed');
            throw new AppError('Failed to reject offer', 500);
        }
        if (!data) {
            res.status(404).json({ error: 'Offer not found' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'reject offer error');
        next(new AppError('Failed to reject offer', 500));
    }
});

export default router;
