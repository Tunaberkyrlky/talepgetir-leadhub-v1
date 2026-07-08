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
import { availableCredits } from '../../lib/research/engine/ledger.js';
import { sanitizeJobForRole } from '../../lib/research/sanitize.js';
import { effectiveCostRole } from '../../lib/research/freshRole.js';
import { icpRevisionSchema } from '../../lib/research/icp/reviseSchema.js';

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

// Calibration sample caps are a SERVER constant, never customer input — cap-shaped knobs stay
// off the customer wire (068 rule), and the sample must stay small enough for trial credits.
const CALIBRATION_CAPS = { maxQueries: 6, maxFetches: 18, maxCandidates: 12 };

const calibrateSchema = z.object({
    geography: z.string().min(1).max(120),
    source: z.enum(['web', 'maps']).optional(),
});

const feedbackSchema = z.object({
    // CAS (codex #1): ratings describe firms sampled under a SPECIFIC ruleset — pin the save
    // to the version the customer was looking at; a concurrent edit bumps it → 409, never a
    // silent re-attribution of old ratings to new rules.
    ruleset_version: z.number().int().min(1),
    items: z
        .array(
            z.object({
                company_id: uuidField('Invalid company ID'),
                rating: z.enum(['good', 'bad']),
                note: z.string().max(2000).optional(),
            })
        )
        .min(1)
        .max(100),
});

const applyRevisionSchema = z.object({
    // CAS: apply only onto the ruleset the customer reviewed the diff against (063 #11 pattern).
    ruleset_version: z.number().int().min(1),
    // CAS on the PROPOSAL identity too (085 review P2): a second icp:revise run swaps
    // revision_draft without bumping ruleset_version — binding the apply to the job that
    // produced the reviewed diff keeps "diff shown" == "content applied".
    revision_job_id: uuidField('Invalid revision job ID'),
});

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

// ═══ Calibration loop (WP1 / 084) — sample → rate → revise → apply → re-approve ═══

// ── POST /api/research/icps/:id/calibrate — enqueue a SMALL calibration sample ──
router.post('/:id/calibrate', requireWriter, validateBody(calibrateSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid ICP ID' });
            return;
        }
        const tenantId = req.tenantId!;
        const { geography, source } = req.body as z.infer<typeof calibrateSchema>;
        const jobType = source === 'maps' ? RESEARCH_JOB_TYPES.MAPS_HARVEST : RESEARCH_JOB_TYPES.HARVEST_RUN;

        // Same admission rule as a full harvest: only an approved ICP at its current ruleset
        // can produce billable MATCHes, so sampling a draft ICP would burn COGS for nothing.
        const { data: icp, error: icpErr } = await researchSupabaseAdmin
            .from('research_icps')
            .select('id, project_id, status')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (icpErr) {
            log.error({ err: icpErr }, 'calibrate icp lookup failed');
            throw new AppError('Failed to start calibration', 500);
        }
        if (!icp) {
            res.status(404).json({ error: 'ICP not found' });
            return;
        }
        if ((icp as { status: string }).status !== 'approved') {
            res.status(409).json({ error: 'ICP must be approved before calibrating' });
            return;
        }

        // Pre-enqueue quota gate (fast-fail UX): the worker's research_reserve_hold is the
        // authoritative, race-safe admission decision — this is an advisory snapshot.
        const available = await availableCredits(tenantId);
        if (available < 1) {
            res.status(402).json({ error: 'Insufficient research credits', available });
            return;
        }

        // ONE in-flight harvest per ICP across ANY harvest type (same advisory guard as
        // harvest/run): two concurrent runs of the same ICP make the (company, icp, ruleset)
        // verdict a last-writer-wins race between two LIVE attempts.
        const { data: inflight, error: infErr } = await researchSupabaseAdmin
            .from('research_jobs')
            .select('id')
            .eq('tenant_id', tenantId)
            .in('type', [
                RESEARCH_JOB_TYPES.HARVEST_RUN,
                RESEARCH_JOB_TYPES.MAPS_HARVEST,
                RESEARCH_JOB_TYPES.TRADE_HARVEST,
            ])
            .in('status', ['queued', 'running'])
            .contains('payload', { icp_id: parsed.data.id })
            .limit(1)
            .maybeSingle();
        if (infErr) {
            log.error({ err: infErr }, 'calibrate in-flight check failed');
            throw new AppError('Failed to start calibration', 500);
        }
        if (inflight) {
            res.status(409).json({
                error: 'A harvest for this ICP is already queued or running',
                job_id: (inflight as { id: string }).id,
            });
            return;
        }

        const job = await enqueueJob({
            tenantId,
            type: jobType,
            payload: {
                icp_id: parsed.data.id,
                geography,
                source: source ?? 'web',
                calibration: true,
                caps: CALIBRATION_CAPS,
            },
            projectId: (icp as { project_id: string }).project_id,
            // Spends real money and is not cost-idempotent — run once (harvest/run rule).
            maxAttempts: 1,
            createdBy: req.user?.id ?? null,
        });

        // Advisory flow state only — the job is already enqueued, so a failed/0-row state
        // update must not fail the request (ruleset integrity is owned by the 062 trigger).
        const { error: stateErr } = await researchSupabaseAdmin
            .from('research_icps')
            // Re-sampling RE-OPENS the loop: a previously calibrated ICP loses both the badge
            // and its timestamp together (085 review — no contradictory calibrated_at leftovers),
            // and any pending proposal is invalidated (codex #3) — the new sample's feedback
            // supersedes what the old proposal was computed from.
            .update({ calibration_state: 'sampling', calibrated_at: null, revision_draft: null, revision_job_id: null })
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId);
        if (stateErr) log.error({ err: stateErr }, 'calibration_state=sampling update failed');

        // Role-sanitized echo (068 rule): the raw job would echo payload.caps back.
        res.status(202).json(sanitizeJobForRole(job as unknown as Record<string, unknown>, await effectiveCostRole(req.user, req.tenantId)));
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'calibrate error');
        next(new AppError('Failed to start calibration', 500));
    }
});

// ── GET /api/research/icps/:id/feedback?ruleset_version= — rated sample rows ─────
router.get('/:id/feedback', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid ICP ID' });
            return;
        }
        const tenantId = req.tenantId!;

        const { data: icp, error: icpErr } = await researchSupabaseAdmin
            .from('research_icps')
            .select('id, ruleset_version')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (icpErr) {
            log.error({ err: icpErr }, 'feedback icp lookup failed');
            throw new AppError('Failed to fetch calibration feedback', 500);
        }
        if (!icp) {
            res.status(404).json({ error: 'ICP not found' });
            return;
        }

        // Default to the CURRENT ruleset; an explicit version lets the client show history.
        let version = (icp as { ruleset_version: number }).ruleset_version;
        if (req.query.ruleset_version !== undefined) {
            const parsedVersion = z.coerce.number().int().min(1).safeParse(req.query.ruleset_version);
            if (!parsedVersion.success) {
                res.status(400).json({ error: 'Invalid ruleset_version' });
                return;
            }
            version = parsedVersion.data;
        }

        const { data: rows, error: fbErr } = await researchSupabaseAdmin
            .from('research_company_feedback')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('icp_id', parsed.data.id)
            .eq('ruleset_version', version)
            .order('created_at', { ascending: false })
            .limit(200);
        if (fbErr) {
            log.error({ err: fbErr }, 'list feedback failed');
            throw new AppError('Failed to fetch calibration feedback', 500);
        }

        const feedback = (rows || []) as Array<Record<string, unknown>>;
        const companies = new Map<string, { name: string | null; domain: string | null }>();
        const companyIds = [...new Set(feedback.map((r) => r.company_id as string))];
        if (companyIds.length > 0) {
            const { data: comps, error: compErr } = await researchSupabaseAdmin
                .from('research_companies')
                .select('id, name, domain')
                .eq('tenant_id', tenantId)
                .in('id', companyIds);
            if (compErr) {
                log.error({ err: compErr }, 'feedback company lookup failed');
                throw new AppError('Failed to fetch calibration feedback', 500);
            }
            for (const c of (comps || []) as Array<{ id: string; name: string | null; domain: string | null }>) {
                companies.set(c.id, { name: c.name, domain: c.domain });
            }
        }
        res.json({
            data: feedback.map((r) => ({ ...r, company: companies.get(r.company_id as string) ?? null })),
            ruleset_version: version,
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'list feedback error');
        next(new AppError('Failed to fetch calibration feedback', 500));
    }
});

// ── POST /api/research/icps/:id/feedback — rate sampled companies good/bad ───────
router.post('/:id/feedback', requireWriter, validateBody(feedbackSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid ICP ID' });
            return;
        }
        const tenantId = req.tenantId!;
        const { items, ruleset_version } = req.body as z.infer<typeof feedbackSchema>;

        const { data: icp, error: icpErr } = await researchSupabaseAdmin
            .from('research_icps')
            .select('id, ruleset_version')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (icpErr) {
            log.error({ err: icpErr }, 'feedback icp lookup failed');
            throw new AppError('Failed to save calibration feedback', 500);
        }
        if (!icp) {
            res.status(404).json({ error: 'ICP not found' });
            return;
        }
        const version = (icp as { ruleset_version: number }).ruleset_version;
        if (version !== ruleset_version) {
            // The ruleset moved between sampling and saving — these ratings describe firms
            // evaluated under OLD rules; attributing them to the new version would poison
            // the next revision. The client refetches and the customer re-rates.
            res.status(409).json({
                error: 'ICP changed since you rated these companies; reload and rate again',
                current_ruleset_version: version,
            });
            return;
        }

        // Last entry wins on a duplicate company in one request — same outcome as two
        // sequential upserts, and Postgres rejects a multi-row upsert hitting one row twice.
        const byCompany = new Map<string, (typeof items)[number]>();
        for (const item of items) byCompany.set(item.company_id, item);
        const deduped = [...byCompany.values()];
        const companyIds = [...byCompany.keys()];

        // Every rated company must belong to this tenant — the service-role write would
        // otherwise let a guessed UUID attach feedback to another tenant's company.
        const { data: comps, error: compErr } = await researchSupabaseAdmin
            .from('research_companies')
            .select('id')
            .eq('tenant_id', tenantId)
            .in('id', companyIds);
        if (compErr) {
            log.error({ err: compErr }, 'feedback company check failed');
            throw new AppError('Failed to save calibration feedback', 500);
        }
        const known = new Set(((comps || []) as Array<{ id: string }>).map((c) => c.id));
        if (companyIds.some((id) => !known.has(id))) {
            res.status(400).json({ error: 'Unknown company in feedback' });
            return;
        }

        // Provenance: link the verdict the customer was looking at (may not exist → null).
        const { data: verdicts, error: verErr } = await researchSupabaseAdmin
            .from('research_company_verdicts')
            .select('id, company_id')
            .eq('tenant_id', tenantId)
            .eq('icp_id', parsed.data.id)
            .eq('ruleset_version', version)
            .in('company_id', companyIds);
        if (verErr) {
            log.error({ err: verErr }, 'feedback verdict lookup failed');
            throw new AppError('Failed to save calibration feedback', 500);
        }
        const verdictByCompany = new Map(
            ((verdicts || []) as Array<{ id: string; company_id: string }>).map((v) => [v.company_id, v.id])
        );

        const { data, error } = await researchSupabaseAdmin
            .from('research_company_feedback')
            .upsert(
                deduped.map((item) => ({
                    tenant_id: tenantId,
                    icp_id: parsed.data.id,
                    company_id: item.company_id,
                    verdict_id: verdictByCompany.get(item.company_id) ?? null,
                    ruleset_version: version,
                    rating: item.rating,
                    note: item.note ?? null,
                    created_by: req.user?.id ?? null,
                })),
                { onConflict: 'tenant_id,icp_id,company_id,ruleset_version' }
            )
            .select();
        if (error) {
            log.error({ err: error }, 'feedback upsert failed');
            throw new AppError('Failed to save calibration feedback', 500);
        }

        // Advisory state advance — never regress an already-calibrated ICP; a failed/0-row
        // update must not fail the request (feedback is already saved). Changed ratings also
        // INVALIDATE any pending proposal (codex #3): it was computed from the old feedback
        // set and must be regenerated, never applied stale.
        const { error: stateErr } = await researchSupabaseAdmin
            .from('research_icps')
            .update({ calibration_state: 'feedback', revision_draft: null, revision_job_id: null })
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .neq('calibration_state', 'calibrated');
        if (stateErr) log.error({ err: stateErr }, 'calibration_state=feedback update failed');

        res.json({ data: data || [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'save feedback error');
        next(new AppError('Failed to save calibration feedback', 500));
    }
});

// ── POST /api/research/icps/:id/revise — enqueue the strategy-model revision ─────
router.post('/:id/revise', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid ICP ID' });
            return;
        }
        const tenantId = req.tenantId!;

        const { data: icp, error: icpErr } = await researchSupabaseAdmin
            .from('research_icps')
            .select('id, project_id, ruleset_version')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (icpErr) {
            log.error({ err: icpErr }, 'revise icp lookup failed');
            throw new AppError('Failed to start ICP revision', 500);
        }
        if (!icp) {
            res.status(404).json({ error: 'ICP not found' });
            return;
        }

        // A revision without feedback at the CURRENT ruleset has nothing to learn from —
        // feedback given against an older ruleset must not silently drive a newer one (084).
        const { count, error: cntErr } = await researchSupabaseAdmin
            .from('research_company_feedback')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .eq('icp_id', parsed.data.id)
            .eq('ruleset_version', (icp as { ruleset_version: number }).ruleset_version);
        if (cntErr) {
            log.error({ err: cntErr }, 'revise feedback count failed');
            throw new AppError('Failed to start ICP revision', 500);
        }
        if (!count) {
            res.status(400).json({ error: 'No calibration feedback for the current ruleset' });
            return;
        }

        // ONE in-flight revision per ICP — two concurrent proposals would race on
        // revision_draft (last fenced writer wins) and double-spend the strategy model.
        const { data: inflight, error: infErr } = await researchSupabaseAdmin
            .from('research_jobs')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('type', RESEARCH_JOB_TYPES.ICP_REVISE)
            .in('status', ['queued', 'running'])
            .contains('payload', { icp_id: parsed.data.id })
            .limit(1)
            .maybeSingle();
        if (infErr) {
            log.error({ err: infErr }, 'revise in-flight check failed');
            throw new AppError('Failed to start ICP revision', 500);
        }
        if (inflight) {
            res.status(409).json({
                error: 'A revision for this ICP is already queued or running',
                job_id: (inflight as { id: string }).id,
            });
            return;
        }

        const job = await enqueueJob({
            tenantId,
            type: RESEARCH_JOB_TYPES.ICP_REVISE,
            payload: { icp_id: parsed.data.id },
            projectId: (icp as { project_id: string }).project_id,
            // ONE attempt (codex #2): the job id doubles as the PROPOSAL identity in the
            // apply-revision CAS. A retry under the same id could persist a DIFFERENT draft
            // than the one the customer reviewed; with maxAttempts=1 a reaped/failed attempt
            // can never run again (the fenced RPC also requires status='running'), so one job
            // id ↔ at most one persisted proposal. A failed revise is simply re-run (new job).
            maxAttempts: 1,
            createdBy: req.user?.id ?? null,
        });
        // 202: accepted, runs in the worker; client polls /api/research/jobs/:id.
        res.status(202).json(job);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'revise error');
        next(new AppError('Failed to start ICP revision', 500));
    }
});

// ── POST /api/research/icps/:id/apply-revision — patch the proposal onto the live ruleset ──
router.post('/:id/apply-revision', requireWriter, validateBody(applyRevisionSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid ICP ID' });
            return;
        }
        const tenantId = req.tenantId!;
        const { ruleset_version, revision_job_id } = req.body as z.infer<typeof applyRevisionSchema>;

        const { data: icp, error: icpErr } = await researchSupabaseAdmin
            .from('research_icps')
            .select('id, revision_draft, revision_job_id, signals, negative_signals, neutral_signals, elimination_rules')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (icpErr) {
            log.error({ err: icpErr }, 'apply-revision icp lookup failed');
            throw new AppError('Failed to apply revision', 500);
        }
        if (!icp) {
            res.status(404).json({ error: 'ICP not found' });
            return;
        }
        const draft = (icp as { revision_draft: unknown }).revision_draft;
        if (!draft) {
            res.status(409).json({ error: 'No revision to apply' });
            return;
        }
        if ((icp as { revision_job_id: string | null }).revision_job_id !== revision_job_id) {
            res.status(409).json({ error: 'Revision changed since you loaded it; review the new proposal' });
            return;
        }
        // Defensive: the worker validated on persist, but the draft is stored JSONB — never
        // write an unvalidated shape onto the live ruleset columns.
        const parsedDraft = icpRevisionSchema.safeParse(draft);
        if (!parsedDraft.success) {
            log.error({ icpId: parsed.data.id, err: parsedDraft.error }, 'stored revision draft failed validation');
            res.status(409).json({ error: 'Revision draft is invalid; regenerate it' });
            return;
        }
        const revision = parsedDraft.data;

        // No-op guard (codex #6): identical arrays would NOT fire the ruleset trigger — the
        // draft would clear while the ICP silently stays approved at the same version, skipping
        // the re-approve/re-sample step the loop is built around. Refuse and drop the draft.
        const liveArrays = icp as unknown as {
            signals: string[]; negative_signals: string[]; neutral_signals: string[]; elimination_rules: string[];
        };
        const isNoop = (['signals', 'negative_signals', 'neutral_signals', 'elimination_rules'] as const)
            .every((k) => JSON.stringify(revision[k]) === JSON.stringify(liveArrays[k] ?? []));
        if (isNoop) {
            const { error: clearErr } = await researchSupabaseAdmin
                .from('research_icps')
                .update({ revision_draft: null, revision_job_id: null })
                .eq('id', parsed.data.id)
                .eq('tenant_id', tenantId)
                .eq('revision_job_id', revision_job_id);
            if (clearErr) log.error({ err: clearErr }, 'no-op revision clear failed');
            res.status(409).json({ error: 'Revision proposes no changes; gather more feedback and regenerate' });
            return;
        }

        // Writing the ruleset arrays fires the 062/085 guard trigger: ruleset_version bump +
        // approved→draft (+ draft cleanup) happen ATOMICALLY in the DB — do NOT set status/version
        // here. Double CAS: ruleset_version (concurrent edit bumps it) AND revision_job_id (a
        // concurrent re-revise swaps the draft without bumping) — either mismatch → 0 rows → 409.
        const { data, error } = await researchSupabaseAdmin
            .from('research_icps')
            .update({
                signals: revision.signals,
                negative_signals: revision.negative_signals,
                neutral_signals: revision.neutral_signals,
                elimination_rules: revision.elimination_rules,
                revision_draft: null,
                revision_job_id: null,
            })
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .eq('ruleset_version', ruleset_version)
            .eq('revision_job_id', revision_job_id)
            .select()
            .maybeSingle();
        if (error) {
            log.error({ err: error }, 'apply revision failed');
            throw new AppError('Failed to apply revision', 500);
        }
        if (!data) {
            // No row matched: the ICP vanished, its ruleset moved, or the proposal was swapped
            // by a concurrent re-revise between our read and the CAS update.
            const { data: exists } = await researchSupabaseAdmin
                .from('research_icps')
                .select('id, ruleset_version, revision_job_id')
                .eq('id', parsed.data.id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (exists) {
                if ((exists as { ruleset_version: number }).ruleset_version !== ruleset_version) {
                    res.status(409).json({
                        error: 'ICP changed since you loaded it; review the latest edits and approve again',
                        current_ruleset_version: (exists as { ruleset_version: number }).ruleset_version,
                    });
                } else {
                    res.status(409).json({ error: 'Revision changed since you loaded it; review the new proposal' });
                }
                return;
            }
            res.status(404).json({ error: 'ICP not found' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'apply revision error');
        next(new AppError('Failed to apply revision', 500));
    }
});

// ── POST /api/research/icps/:id/mark-calibrated — close the calibration loop ─────
router.post('/:id/mark-calibrated', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid ICP ID' });
            return;
        }
        const tenantId = req.tenantId!;

        const { data: icp, error: icpErr } = await researchSupabaseAdmin
            .from('research_icps')
            .select('id, status, ruleset_version, revision_job_id')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (icpErr) {
            log.error({ err: icpErr }, 'mark-calibrated icp lookup failed');
            throw new AppError('Failed to mark ICP calibrated', 500);
        }
        if (!icp) {
            res.status(404).json({ error: 'ICP not found' });
            return;
        }
        // Only a re-approved ICP can be declared calibrated — apply-revision reverts
        // approved→draft (062 trigger), so this forces the human re-approval step.
        if ((icp as { status: string }).status !== 'approved') {
            res.status(409).json({ error: 'ICP must be approved before marking calibrated' });
            return;
        }
        // A pending proposal means the loop is mid-flight — apply or regenerate it first
        // (codex #5): "calibrated with an unreviewed revision outstanding" is a contradiction.
        if ((icp as { revision_job_id: string | null }).revision_job_id) {
            res.status(409).json({ error: 'Apply or regenerate the pending revision before marking calibrated' });
            return;
        }

        // Evidence gate (085 review): "calibrated" is a scale-readiness signal — it means the
        // loop actually ran. Require at least one rating at the CURRENT ruleset; a fresh ICP
        // can't be declared calibrated with zero sampled evidence.
        const { count: feedbackCount, error: fbErr } = await researchSupabaseAdmin
            .from('research_company_feedback')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .eq('icp_id', parsed.data.id)
            .eq('ruleset_version', (icp as { ruleset_version: number }).ruleset_version);
        if (fbErr) {
            log.error({ err: fbErr }, 'mark-calibrated feedback count failed');
            throw new AppError('Failed to mark ICP calibrated', 500);
        }
        if (!feedbackCount) {
            res.status(400).json({ error: 'No calibration feedback for the current ruleset' });
            return;
        }

        // Conditional UPDATE (085 review + codex #5): the gates above are check-then-act — a
        // concurrent apply-revision can demote the ICP, and an edit+re-approve can move the
        // ruleset PAST the version whose feedback we just counted. Re-assert BOTH in the write;
        // 0 rows → the state moved under us.
        const { data, error } = await researchSupabaseAdmin
            .from('research_icps')
            .update({ calibration_state: 'calibrated', calibrated_at: new Date().toISOString() })
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .eq('status', 'approved')
            .eq('ruleset_version', (icp as { ruleset_version: number }).ruleset_version)
            // A concurrent icp:revise can persist a proposal without touching status/version —
            // assert no-pending-revision IN the write too (codex verify #5), not just the gate.
            .is('revision_job_id', null)
            .select()
            .maybeSingle();
        if (error) {
            log.error({ err: error }, 'mark calibrated failed');
            throw new AppError('Failed to mark ICP calibrated', 500);
        }
        if (!data) {
            res.status(409).json({ error: 'ICP must be approved before marking calibrated' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'mark calibrated error');
        next(new AppError('Failed to mark ICP calibrated', 500));
    }
});

export default router;
