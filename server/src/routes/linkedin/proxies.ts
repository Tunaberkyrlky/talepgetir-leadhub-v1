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
import { importAndAssignProxy } from '../../lib/linkedin/staticProxy.js';

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

export default router;
