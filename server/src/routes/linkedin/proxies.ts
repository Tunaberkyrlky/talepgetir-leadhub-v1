/**
 * TG-LinkedIn — static residential proxy management (internal-only).
 *
 * The ONE way a dedicated IP enters the pool: an internal operator POSTs a verified
 * host:port:user:pass to the SERVER (never a client paste — that leaks plaintext creds +
 * enables SSRF; codex §9-P1.18). The route SSRF-guards + echo-verifies + geo-checks +
 * refuses a burned IP, then atomically imports+assigns via RPC and kicks a re-validate so
 * the account's send-time generation gate can open on the new IP.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { enqueueJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPES } from '../../lib/research/jobTypes.js';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { importAndAssignProxy, importProxyToPool } from '../../lib/linkedin/staticProxy.js';
import { hasAdapter } from '../../lib/research/worker/handlers/linkedinProxySync.js';

const log = createLogger('route:linkedin:proxies');
const router = Router();
// Static proxy management is internal-only — it handles raw provider credentials and can
// dial arbitrary hosts, so client roles must never reach it.
const requireInternal = requireRole('superadmin', 'ops_agent');

const importSchema = z.object({
    account_id: uuidField('Invalid account_id'),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(400),
    password: z.string().min(1).max(400),
    provider: z.string().min(1).max(40).optional(),
    ext_id: z.string().min(1).max(200).optional(),
    plan_id: z.string().min(1).max(200).optional(),
});

// Pool import — same verified host:port:user:pass, but WITHOUT an account (P1). The country is
// derived server-side from the echo-observed egress, so there is no account_id and no geo field.
const poolImportSchema = z.object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(400),
    password: z.string().min(1).max(400),
    provider: z.string().min(1).max(40).optional(),
    ext_id: z.string().min(1).max(200).optional(),
    plan_id: z.string().min(1).max(200).optional(),
});

// ── POST /proxies/import — verify + import + assign one static proxy to an account ──
router.post('/import', requireInternal, validateBody(importSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const b = req.body as z.infer<typeof importSchema>;

        const result = await importAndAssignProxy({
            tenantId,
            accountId: b.account_id,
            host: b.host,
            port: b.port,
            username: b.username,
            password: b.password,
            provider: b.provider,
            extId: b.ext_id ?? null,
            planId: b.plan_id ?? null,
        });

        if (!result.ok) {
            // Map the verify/RPC failure to a 4xx the operator can act on. exitIp/country are
            // safe to echo (public IP); credentials never appear in the response.
            res.status(422).json({
                error: result.error ?? 'import_failed',
                exit_ip: result.exitIp ?? null,
                country: result.country ?? null,
            });
            return;
        }

        // New IP must be re-validated before any send (the generation gate is cleared by the RPC).
        const job = await enqueueJob({
            tenantId,
            type: RESEARCH_JOB_TYPES.LINKEDIN_VALIDATE,
            payload: { account_id: b.account_id },
            maxAttempts: 1,
            createdBy: req.user?.id ?? null,
        });

        res.status(201).json({
            ok: true,
            proxy_id: result.proxyId,
            endpoint_generation: result.endpointGeneration,
            exit_ip: result.exitIp,
            country: result.country,
            validate_job_id: (job as { id?: string }).id ?? null,
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'proxy import error');
        next(new AppError('Proxy import failed', 500));
    }
});

// Proxy-sync trigger — internal seed/run of the daily staged reconcile loop (Proxy P2, §4a).
const syncSchema = z.object({
    provider: z.string().min(1).max(40).optional(),
});

// ── POST /proxies/sync — enqueue an immediate staged provider-inventory reconcile ──
// Seeds/kicks the self-rescheduling linkedin:proxy-sync loop. The job itself is fail-closed:
// any provider fetch error records an 'incomplete' run and changes nothing (§4a P1.8).
router.post('/sync', requireInternal, validateBody(syncSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const b = req.body as z.infer<typeof syncSchema>;
        const provider = b.provider ?? 'iproyal';
        // Reject an unknown provider up front (400) — otherwise it would enqueue a job that can only
        // ever record a fail-closed 'no_adapter' incomplete run, wasting a loop cycle.
        if (!hasAdapter(provider)) {
            throw new AppError(`Unknown proxy provider: ${provider}`, 400);
        }
        // Dedup: a concurrent double-trigger must not double-enqueue. Queued-ONLY (C6, matching
        // ensureProxySyncLoop): a RUNNING job must not block a fresh manual trigger, and the mig-110
        // partial unique index (at most one queued proxy-sync per tenant) is the atomic backstop for
        // the read→insert race — a lost race surfaces as a 23505 we treat as already-queued.
        const { data: existing } = await researchSupabaseAdmin
            .from('research_jobs').select('id, scheduled_at')
            .eq('tenant_id', tenantId).eq('type', RESEARCH_JOB_TYPES.LINKEDIN_PROXY_SYNC)
            .eq('status', 'queued').limit(1);
        if (existing && existing.length > 0) {
            const existingJob = existing[0] as { id: string; scheduled_at: string | null };
            // A queued successor already exists — a bare "already_queued" leaves an operator's manual
            // kick doing nothing until the loop's own 24h schedule comes around. Advance it to run now,
            // but ONLY when it's still scheduled in the future and still 'queued' (the .eq('status',
            // 'queued') guard prevents touching a row the worker has since claimed — an update matching
            // 0 rows just means we lost that race, which is handled below by falling through).
            const isFuture = existingJob.scheduled_at ? new Date(existingJob.scheduled_at).getTime() > Date.now() : false;
            if (isFuture) {
                const { data: advanced } = await researchSupabaseAdmin
                    .from('research_jobs')
                    .update({ scheduled_at: new Date().toISOString() })
                    .eq('id', existingJob.id).eq('status', 'queued')
                    .select('id');
                if (advanced && advanced.length > 0) {
                    res.status(202).json({ ok: true, provider, advanced: true, sync_job_id: existingJob.id });
                    return;
                }
                // Raced (job was claimed between the read and the update) — fall through to the normal
                // enqueue attempt below, which is tolerant of a concurrent successor via 23505.
            } else {
                res.status(202).json({ ok: true, provider, already_queued: true, sync_job_id: existingJob.id });
                return;
            }
        }
        let job: { id?: string };
        try {
            job = await enqueueJob({
                tenantId,
                type: RESEARCH_JOB_TYPES.LINKEDIN_PROXY_SYNC,
                payload: { provider },
                maxAttempts: 1,
                createdBy: req.user?.id ?? null,
            });
        } catch (enqErr) {
            if ((enqErr as { code?: string })?.code === '23505') {
                res.status(202).json({ ok: true, provider, already_queued: true, sync_job_id: null });
                return;
            }
            throw enqErr;
        }
        res.status(202).json({ ok: true, provider, sync_job_id: job.id ?? null });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'proxy sync trigger error');
        next(new AppError('Proxy sync trigger failed', 500));
    }
});

// ── POST /proxies/pool — verify + import one static proxy into the POOL (no account) ──
// Seeds a dedicated IP into the pool for a later linkedin_claim_proxy. Identical SSRF +
// echo-verify path to /import; it just never binds an account (so no revalidate is kicked).
router.post('/pool', requireInternal, validateBody(poolImportSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const b = req.body as z.infer<typeof poolImportSchema>;

        const result = await importProxyToPool({
            tenantId,
            host: b.host,
            port: b.port,
            username: b.username,
            password: b.password,
            provider: b.provider,
            extId: b.ext_id ?? null,
            planId: b.plan_id ?? null,
        });

        if (!result.ok) {
            res.status(422).json({
                error: result.error ?? 'import_failed',
                exit_ip: result.exitIp ?? null,
                country: result.country ?? null,
            });
            return;
        }

        res.status(201).json({
            ok: true,
            proxy_id: result.proxyId,
            endpoint_generation: result.endpointGeneration,
            exit_ip: result.exitIp,
            country: result.country,
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'proxy pool import error');
        next(new AppError('Proxy pool import failed', 500));
    }
});

export default router;
