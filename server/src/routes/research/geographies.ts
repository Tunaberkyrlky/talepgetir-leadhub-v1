/**
 * Research geographies (WP2 — market structure → sub-ICP cells).
 * A geography row is the ICP instantiated for ONE country: local-language terms, localized
 * signals, key channels (WP3 seed), certifications, buyer titles and market-structure notes,
 * plus an E estimate. geo:analyze (worker) drafts the spec; the customer edits + approves —
 * the same human-gate philosophy as the ICP itself. Approved cells may then scope harvest
 * runs (geo_id): the spec affects DISCOVERY quality only — verdicts/billing stay keyed to
 * (icp, ruleset_version), so geo state never gates money.
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
import { geoAnalysisSchema } from '../../lib/research/geo/schema.js';
import { availableCredits } from '../../lib/research/engine/ledger.js';
import { loadMarketEvidenceForGeoCountry } from '../../lib/research/trade/marketEvidence.js';

const log = createLogger('route:research:geographies');
const router = Router();

const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');

// COGS surface bound (review P3): country is free text, so without a ceiling a writer role
// could script unbounded Opus spend one junk cell at a time. Generous for real use (a tenant
// rarely targets >10 countries per ICP), hard for abuse.
const MAX_CELLS_PER_ICP = 25;

const createSchema = z.object({
    icp_id: uuidField('Invalid ICP ID'),
    country: z.string().trim().min(2).max(80),
    region: z.string().trim().max(120).optional(),
});

const updateGeoSchema = z
    .object({
        // A spec write carries the FULL shape (whole-object replace) — a partial spec merge
        // could silently drop fields the worker drafted.
        spec: geoAnalysisSchema.optional(),
        note: z.string().max(4000).optional(),
        human_score: z.number().int().min(0).max(10).optional(),
        region: z.string().trim().max(120).optional(),
    })
    .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

const approveGeoSchema = z.object({
    human_score: z.number().int().min(0).max(10),
    // CAS token (ICP approve pattern, but REQUIRED — this endpoint has no legacy callers):
    // the row's updated_at as the client loaded it, so the approval binds to the exact spec
    // the human reviewed. Every spec write — human PATCH or the fenced persist RPC — bumps
    // updated_at (056 trigger), so a stale drawer 409s instead of approving unseen work.
    updated_at: z.string().datetime({ offset: true, message: 'updated_at must be a valid ISO datetime' }),
});

const idParamSchema = z.object({ id: uuidField('Invalid geography ID') });

// Exact case-insensitive match via ILIKE — same semantics as the lower(country) unique index
// (086); escape LIKE metacharacters so a country like 'C%' can't wildcard-match another row.
const likeExact = (value: string): string => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * Best-effort in-flight guard (advisory, check-then-enqueue like icps revise / harvest run):
 * two requests inside the same race window CAN still double-enqueue — the 086 lease fence
 * keeps the writes safe (last writer wins), this only prevents the common double-click spend.
 * Queued/running only — a finished job never blocks a re-analysis.
 */
async function findInflightAnalysis(tenantId: string, geoId: string): Promise<ResearchJob | null> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_jobs')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('type', RESEARCH_JOB_TYPES.GEO_ANALYZE)
        .in('status', ['queued', 'running'])
        .contains('payload', { geo_id: geoId })
        .limit(1)
        .maybeSingle();
    if (error) {
        log.error({ err: error }, 'geo:analyze in-flight check failed');
        throw new AppError('Failed to start geography analysis', 500);
    }
    return (data as ResearchJob | null) ?? null;
}

function enqueueAnalysis(tenantId: string, geoId: string, projectId: string, createdBy: string | null): Promise<ResearchJob> {
    return enqueueJob({
        tenantId,
        type: RESEARCH_JOB_TYPES.GEO_ANALYZE,
        payload: { geo_id: geoId },
        projectId,
        // Strategy-model spend (Opus) and not cost-idempotent — run once (icps revise rule);
        // a failed analysis is simply re-run (new job).
        maxAttempts: 1,
        createdBy,
    });
}

// ── POST /api/research/geographies — create-or-reuse a cell + enqueue analysis ───
router.post('/', requireWriter, validateBody(createSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { icp_id, country, region } = req.body as z.infer<typeof createSchema>;

        // The ICP must exist in this tenant — ANY status is fine: market-structure analysis can
        // run while the ICP itself is still being shaped (pre-approval). Harvest admission
        // separately requires BOTH the ICP and the cell approved.
        const { data: icp, error: icpErr } = await researchSupabaseAdmin
            .from('research_icps')
            .select('id, project_id')
            .eq('id', icp_id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (icpErr) {
            log.error({ err: icpErr }, 'geography icp lookup failed');
            throw new AppError('Failed to create geography', 500);
        }
        if (!icp) {
            res.status(404).json({ error: 'ICP not found' });
            return;
        }

        // Reuse FIRST (codex P3): re-adding an existing country must reuse its row even when
        // the ICP is at the cell ceiling — the ceiling bounds NEW Opus-spend surface, not
        // access to cells that already exist.
        let geography: Record<string, unknown> | null = null;
        const { data: preExisting, error: preErr } = await researchSupabaseAdmin
            .from('research_geographies')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('icp_id', icp_id)
            .ilike('country', likeExact(country))
            .maybeSingle();
        if (preErr) {
            log.error({ err: preErr }, 'geography reuse lookup failed');
            throw new AppError('Failed to create geography', 500);
        }
        if (preExisting) geography = preExisting as Record<string, unknown>;

        if (!geography) {
            // Ceiling applies to a genuine CREATE only (advisory count — the ceiling is an
            // abuse bound, not an invariant, so a razor-thin race past it is acceptable).
            const { count: cellCount, error: cntErr } = await researchSupabaseAdmin
                .from('research_geographies')
                .select('id', { count: 'exact', head: true })
                .eq('tenant_id', tenantId)
                .eq('icp_id', icp_id);
            if (cntErr) {
                log.error({ err: cntErr }, 'geography count failed');
                throw new AppError('Failed to create geography', 500);
            }
            if ((cellCount ?? 0) >= MAX_CELLS_PER_ICP) {
                // Race window: a concurrent request may have created THIS country between the
                // reuse lookup and the count — the count now trips the ceiling, but the correct
                // answer is still "reuse", not 409. Re-check before refusing.
                const { data: raced, error: racedErr } = await researchSupabaseAdmin
                    .from('research_geographies')
                    .select('*')
                    .eq('tenant_id', tenantId)
                    .eq('icp_id', icp_id)
                    .ilike('country', likeExact(country))
                    .maybeSingle();
                if (racedErr) {
                    log.error({ err: racedErr }, 'geography ceiling recheck failed');
                    throw new AppError('Failed to create geography', 500);
                }
                if (!raced) {
                    res.status(409).json({ error: `This ICP already has ${MAX_CELLS_PER_ICP} geographies — remove or reuse existing cells` });
                    return;
                }
                geography = raced as Record<string, unknown>;
            }
        }

        if (!geography) {
            // One cell per (tenant, icp, country) — the unique violation (086 index) covers
            // the lookup→insert race window: a concurrent create is adopted, not errored.
            const { data: created, error: insErr } = await researchSupabaseAdmin
                .from('research_geographies')
                .insert({
                    tenant_id: tenantId,
                    project_id: (icp as { project_id: string }).project_id,
                    icp_id,
                    country,
                    region: region ?? null,
                })
                .select()
                .single();
            if (insErr) {
                if (insErr.code !== '23505') {
                    log.error({ err: insErr }, 'geography insert failed');
                    throw new AppError('Failed to create geography', 500);
                }
                const { data: existing, error: exErr } = await researchSupabaseAdmin
                    .from('research_geographies')
                    .select('*')
                    .eq('tenant_id', tenantId)
                    .eq('icp_id', icp_id)
                    .ilike('country', likeExact(country))
                    .maybeSingle();
                if (exErr || !existing) {
                    log.error({ err: exErr }, 'geography conflict lookup failed');
                    throw new AppError('Failed to create geography', 500);
                }
                geography = existing as Record<string, unknown>;
            } else {
                geography = created as Record<string, unknown>;
            }
        }

        // Re-adding a country that was ALREADY analyzed must not silently burn Opus and
        // overwrite (possibly hand-tuned, approved) work — the explicit Re-analyze path
        // carries that intent (review P2). A spec-less leftover cell still auto-analyzes.
        if (geography.spec != null) {
            res.status(200).json({ geography, job: null, reused: true });
            return;
        }
        const geoId = geography.id as string;

        const inflight = await findInflightAnalysis(tenantId, geoId);
        if (inflight) {
            // Adopt the analysis already in flight instead of stacking a second one.
            res.status(200).json({ geography, job: inflight });
            return;
        }

        // Fast-fail credit gate (same advisory snapshot as harvest run): analysis is unbilled
        // COGS on our side, but a zero-credit tenant has no path to USE the cell — refuse the
        // spend up front instead of drafting specs nobody can harvest with.
        const available = await availableCredits(tenantId);
        if (available < 1) {
            res.status(402).json({ error: 'Insufficient research credits', available });
            return;
        }

        const job = await enqueueAnalysis(tenantId, geoId, (icp as { project_id: string }).project_id, req.user?.id ?? null);
        // 202: accepted, runs in the worker; client polls /api/research/jobs/:id. Raw job echo
        // is fine here (icps generate pattern) — the payload carries no caps to sanitize.
        res.status(202).json({ geography, job });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'create geography error');
        next(new AppError('Failed to create geography', 500));
    }
});

// ── GET /api/research/geographies?icp_id= ────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { icp_id } = req.query;

        let query = researchSupabaseAdmin
            .from('research_geographies')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false });

        if (icp_id && typeof icp_id === 'string') {
            if (!uuidField().safeParse(icp_id).success) {
                res.status(400).json({ error: 'Invalid icp_id' });
                return;
            }
            query = query.eq('icp_id', icp_id);
        }

        const { data, error } = await query;
        if (error) {
            log.error({ err: error }, 'list geographies failed');
            throw new AppError('Failed to fetch geographies', 500);
        }
        res.json({ data: data || [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'list geographies error');
        next(new AppError('Failed to fetch geographies', 500));
    }
});

// ── GET /api/research/geographies/:id/markets — raw Comtrade evidence, no LLM in the path ────
router.get('/:id/markets', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid geography ID' });
            return;
        }
        const tenantId = req.tenantId!;

        const { data: geo, error: geoErr } = await researchSupabaseAdmin
            .from('research_geographies')
            .select('id, project_id, country')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (geoErr) {
            log.error({ err: geoErr }, 'geography markets lookup failed');
            throw new AppError('Failed to fetch market evidence', 500);
        }
        if (!geo) {
            res.status(404).json({ error: 'Geography not found' });
            return;
        }

        const rows = await loadMarketEvidenceForGeoCountry({
            tenantId,
            projectId: (geo as { project_id: string }).project_id,
            geoCountry: (geo as { country: string }).country,
        });
        res.json({ data: rows });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'geography markets error');
        next(new AppError('Failed to fetch market evidence', 500));
    }
});

// ── POST /api/research/geographies/:id/analyze — (re-)enqueue the analysis ────
router.post('/:id/analyze', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid geography ID' });
            return;
        }
        const tenantId = req.tenantId!;

        const { data: geo, error: geoErr } = await researchSupabaseAdmin
            .from('research_geographies')
            .select('id, project_id')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (geoErr) {
            log.error({ err: geoErr }, 'analyze geo lookup failed');
            throw new AppError('Failed to start geography analysis', 500);
        }
        if (!geo) {
            res.status(404).json({ error: 'Geography not found' });
            return;
        }

        const inflight = await findInflightAnalysis(tenantId, parsed.data.id);
        if (inflight) {
            // Adopt the analysis already in flight instead of stacking a second one.
            res.status(200).json(inflight);
            return;
        }

        // Fast-fail credit gate — same rationale as the create path.
        const available = await availableCredits(tenantId);
        if (available < 1) {
            res.status(402).json({ error: 'Insufficient research credits', available });
            return;
        }

        // NOTE: re-analysis of an approved cell demotes it back to draft — the fenced persist
        // RPC (086) sets status='draft', so a regenerated spec must be re-approved.
        const job = await enqueueAnalysis(tenantId, parsed.data.id, (geo as { project_id: string }).project_id, req.user?.id ?? null);
        // 202: accepted, runs in the worker; client polls /api/research/jobs/:id.
        res.status(202).json(job);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'analyze geography error');
        next(new AppError('Failed to start geography analysis', 500));
    }
});

// ── PATCH /api/research/geographies/:id — edit the final + score/note ─────────
router.patch('/:id', requireWriter, validateBody(updateGeoSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid geography ID' });
            return;
        }
        const tenantId = req.tenantId!;
        const body = req.body as z.infer<typeof updateGeoSchema>;

        const patch: Record<string, unknown> = {};
        if (body.note !== undefined) patch.note = body.note;
        if (body.human_score !== undefined) patch.human_score = body.human_score;
        if (body.region !== undefined) patch.region = body.region;
        if (body.spec !== undefined) {
            // An edited spec must be re-approved. Unlike ICPs (062 ruleset trigger) there is
            // no DB trigger for geographies — the approved→draft demotion is explicit here.
            patch.spec = body.spec;
            patch.status = 'draft';
            // Keep the 056 columns tracking the spec of record (review P2) — the same
            // projection the fenced persist RPC does, or the cells table/coverage view
            // would keep rendering a stale E after a human edit.
            patch.estimate = body.spec.estimate;
            patch.confidence = body.spec.confidence;
            patch.rationale = body.spec.estimate_basis || null;
        }

        const { data, error } = await researchSupabaseAdmin
            .from('research_geographies')
            .update(patch)
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .select()
            .maybeSingle();
        if (error) {
            log.error({ err: error }, 'update geography failed');
            throw new AppError('Failed to update geography', 500);
        }
        if (!data) {
            res.status(404).json({ error: 'Geography not found' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'update geography error');
        next(new AppError('Failed to update geography', 500));
    }
});

// ── POST /api/research/geographies/:id/approve — human /10 gate ──────────────
router.post('/:id/approve', requireWriter, validateBody(approveGeoSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid geography ID' });
            return;
        }
        const tenantId = req.tenantId!;
        const { human_score, updated_at } = req.body as z.infer<typeof approveGeoSchema>;

        const { data: geo, error: geoErr } = await researchSupabaseAdmin
            .from('research_geographies')
            .select('id, spec')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (geoErr) {
            log.error({ err: geoErr }, 'approve geo lookup failed');
            throw new AppError('Failed to approve geography', 500);
        }
        if (!geo) {
            res.status(404).json({ error: 'Geography not found' });
            return;
        }
        // Approval gates on an ANALYZED cell: without a spec there is nothing to approve —
        // the harvest engine would have no local terms/signals to consume.
        if ((geo as { spec: unknown }).spec == null) {
            res.status(409).json({ error: 'Analyze this geography before approving' });
            return;
        }

        // CAS: only approve if the row is still the one the client reviewed. A concurrent
        // re-analysis or spec edit bumps updated_at (trigger), so this match fails → 409,
        // never an unseen approval.
        const { data, error } = await researchSupabaseAdmin
            .from('research_geographies')
            .update({ status: 'approved', human_score })
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .eq('updated_at', updated_at)
            .select()
            .maybeSingle();
        if (error) {
            log.error({ err: error }, 'approve geography failed');
            throw new AppError('Failed to approve geography', 500);
        }
        if (!data) {
            // No row matched: either the cell is gone, or its spec moved under us.
            const { data: exists } = await researchSupabaseAdmin
                .from('research_geographies')
                .select('id, updated_at')
                .eq('id', parsed.data.id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (exists) {
                res.status(409).json({
                    error: 'Geography changed since you loaded it; review the latest spec and approve again',
                    current_updated_at: (exists as { updated_at: string }).updated_at,
                });
                return;
            }
            res.status(404).json({ error: 'Geography not found' });
            return;
        }
        res.json(data);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'approve geography error');
        next(new AppError('Failed to approve geography', 500));
    }
});

export default router;
