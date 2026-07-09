/**
 * Research contact enrichment (Hunter) — customer-facing, credit-gated.
 *
 * POST /run enqueues enrich:run for explicitly selected companies with the
 * customer's title-bucket priority (multilingual keyword bundles) + optional
 * custom keywords + per-company contact cap. Billing: 1 credit per company that
 * yields ≥1 contact, once-ever (research_bill_enrichment). Already-enriched
 * companies are free re-reads via GET /contacts.
 * Pattern mirrors routes/research/channels.ts (credit gate, in-flight adopt,
 * role-sanitized job echoes).
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
import { TITLE_BUCKETS, TITLE_BUCKET_CODES } from '../../lib/research/enrichment/titleBundles.js';

const log = createLogger('route:research:enrichment');
const router = Router();

const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');

const runSchema = z.object({
    company_ids: z.array(uuidField('Invalid company ID')).min(1).max(50),
    title_buckets: z.array(z.enum(TITLE_BUCKET_CODES as [string, ...string[]])).max(8).optional(),
    custom_keywords: z.array(z.string().trim().min(2).max(40)).max(20).optional(),
    max_contacts: z.number().int().min(1).max(10).optional(),
});

/** Best-effort in-flight guard (advisory, channels.ts pattern): one enrichment run per
 *  tenant at a time — adopting the live job instead of double-spending Hunter requests. */
async function findInflight(tenantId: string): Promise<ResearchJob | null> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_jobs')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('type', RESEARCH_JOB_TYPES.ENRICH_RUN)
        .in('status', ['queued', 'running'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) {
        log.warn({ err: error, tenantId }, 'inflight lookup failed (advisory — continuing)');
        return null;
    }
    return (data as ResearchJob) ?? null;
}

// ── GET /api/research/enrichment/buckets — the title-bundle catalog for the UI ──
router.get('/buckets', async (_req: Request, res: Response): Promise<void> => {
    res.json({
        data: TITLE_BUCKETS.map((b) => ({ code: b.code, label: b.label, keyword_count: b.keywords.length })),
    });
});

// ── GET /api/research/enrichment/status?company_ids=a,b,c — which are enriched ──
// Feeds the tab's cost preview: already-enriched companies re-run FREE, so the UI
// subtracts them from the "up to N credits" estimate and shows their contact counts.
router.get('/status', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const raw = typeof req.query.company_ids === 'string' ? req.query.company_ids : '';
        const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 100);
        if (ids.length === 0 || ids.some((id) => !uuidField().safeParse(id).success)) {
            res.status(400).json({ error: 'company_ids (comma-separated UUIDs) is required' });
            return;
        }
        const { data, error } = await researchSupabaseAdmin
            .from('research_enrichment_events')
            .select('company_id, contacts_count')
            .eq('tenant_id', tenantId)
            .in('company_id', ids);
        if (error) {
            log.error({ err: error }, 'enrichment status failed');
            throw new AppError('Failed to fetch enrichment status', 500);
        }
        res.json({ data: data || [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        next(new AppError('Failed to fetch enrichment status', 500));
    }
});

// ── GET /api/research/enrichment/contacts?company_id= — persisted contacts ──────
router.get('/contacts', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { company_id } = req.query;
        if (!company_id || typeof company_id !== 'string' || !uuidField().safeParse(company_id).success) {
            res.status(400).json({ error: 'company_id is required' });
            return;
        }
        const { data, error } = await researchSupabaseAdmin
            .from('research_contacts')
            .select('id, email, name, title, phone, linkedin, seniority, department, confidence, title_bucket, priority, domain, email_type, source, created_at')
            .eq('tenant_id', tenantId)
            .eq('company_id', company_id)
            .eq('suppressed', false)
            .order('priority', { ascending: true })
            .order('confidence', { ascending: false });
        if (error) {
            log.error({ err: error }, 'list contacts failed');
            throw new AppError('Failed to fetch contacts', 500);
        }
        res.json({ data: data || [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'list contacts error');
        next(new AppError('Failed to fetch contacts', 500));
    }
});

// One enqueue per TENANT at a time (harvest.ts export-mutex pattern, codex P1): the
// check-then-enqueue guard alone races — two concurrent POSTs could both pass findInflight
// and burn duplicate Hunter requests for the same companies. In-process is enough: the
// server is a single long-lived Railway process.
const runInFlight = new Set<string>();

// ── POST /api/research/enrichment/run — enqueue an enrichment run ───────────────
router.post('/run', requireWriter, validateBody(runSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const mutexKey = req.tenantId!;
    if (runInFlight.has(mutexKey)) {
        res.status(409).json({ error: 'An enrichment request for this workspace is already being processed' });
        return;
    }
    runInFlight.add(mutexKey);
    try {
        const tenantId = req.tenantId!;
        const body = req.body as z.infer<typeof runSchema>;
        const costRole = await effectiveCostRole(req.user, req.tenantId);

        const inflight = await findInflight(tenantId);
        if (inflight) {
            res.status(200).json(sanitizeJobForRole(inflight as unknown as Record<string, unknown>, costRole));
            return;
        }

        // Companies must exist in THIS tenant (a cross-tenant id in the list is a hard 400,
        // not a silent skip — the customer should see the selection is wrong).
        const ids = [...new Set(body.company_ids)];
        const { data: found, error: compErr } = await researchSupabaseAdmin
            .from('research_companies')
            .select('id, canonical_key, domain, suppressed')
            .eq('tenant_id', tenantId)
            .in('id', ids);
        if (compErr) {
            log.error({ err: compErr }, 'company ownership check failed');
            throw new AppError('Failed to validate companies', 500);
        }
        const owned = (found ?? []) as Array<{ id: string; canonical_key: string; domain: string | null; suppressed: boolean }>;
        if (owned.length !== ids.length) {
            res.status(400).json({ error: 'One or more companies do not belong to this workspace' });
            return;
        }

        // Quota gate ONLY when the selection contains FRESH (chargeable) work (codex P2):
        // already-enriched re-runs and event-without-contacts backfills are free and must
        // stay available to a zero-credit tenant. The worker re-checks authoritatively.
        const { data: evRows, error: evErr } = await researchSupabaseAdmin
            .from('research_enrichment_events')
            .select('canonical_key')
            .eq('tenant_id', tenantId)
            .in('canonical_key', owned.map((c) => c.canonical_key));
        if (evErr) {
            log.error({ err: evErr }, 'enrichment event check failed');
            throw new AppError('Failed to validate companies', 500);
        }
        const enrichedKeys = new Set(((evRows ?? []) as Array<{ canonical_key: string }>).map((r) => r.canonical_key));
        const needsCredit = owned.some((c) => !c.suppressed && !!c.domain && !enrichedKeys.has(c.canonical_key));
        if (needsCredit) {
            const available = await availableCredits(tenantId);
            if (available < 1) {
                res.status(402).json({ error: 'Insufficient research credits', available });
                return;
            }
        }

        const job = await enqueueJob({
            tenantId,
            type: RESEARCH_JOB_TYPES.ENRICH_RUN,
            payload: {
                company_ids: ids,
                title_buckets: body.title_buckets ?? [],
                custom_keywords: body.custom_keywords ?? [],
                max_contacts: body.max_contacts ?? 3,
            },
            // Paid external requests are not cost-idempotent — run once; re-runs skip
            // already-billed companies anyway (once-ever event), so a manual retry is cheap.
            maxAttempts: 1,
            createdBy: req.user?.id ?? null,
        });
        res.status(202).json(sanitizeJobForRole(job as unknown as Record<string, unknown>, costRole));
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'enrichment run error');
        next(new AppError('Failed to start enrichment', 500));
    } finally {
        runInFlight.delete(mutexKey);
    }
});

export default router;
