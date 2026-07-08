/**
 * TG-LinkedIn — authenticated account routes (mounted at /api/linkedin, behind
 * authMiddleware). All reads use the service-role researchSupabaseAdmin scoped by
 * req.tenantId and NEVER select *_enc columns (deny-all RLS keeps them off
 * PostgREST anyway; the API also never echoes them).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { randomBytes, createHash } from 'crypto';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { enqueueJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPES } from '../../lib/research/jobTypes.js';
import { sanitizeJobForRole } from '../../lib/research/sanitize.js';
import { effectiveCostRole } from '../../lib/research/freshRole.js';

const log = createLogger('route:linkedin:accounts');
const router = Router();
const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');

// Never selects li_at_enc / jsessionid_enc — encrypted cookies never leave the server.
const SAFE_COLUMNS =
    'id, name, public_id, status, warmup_day, geo, timezone, daily_counters, last_validated_at, created_at';

// ── GET /accounts — list this tenant's connected accounts ─────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { data, error } = await researchSupabaseAdmin
            .from('linkedin_accounts')
            .select(SAFE_COLUMNS)
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false });
        if (error) throw new AppError('Failed to list LinkedIn accounts', 500);
        res.json({ data: data ?? [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'list accounts error');
        next(new AppError('Failed to list LinkedIn accounts', 500));
    }
});

// ── GET /accounts/:id/health — status + recent-action rollup (Faz-0 stub) ─────
router.get('/:id/health', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const id = req.params.id;
        if (!uuidField().safeParse(id).success) { res.status(400).json({ error: 'Invalid id' }); return; }

        const { data: account, error } = await researchSupabaseAdmin
            .from('linkedin_accounts')
            .select(SAFE_COLUMNS)
            .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        if (error) throw new AppError('Failed to read health', 500);
        if (!account) { res.status(404).json({ error: 'Account not found' }); return; }

        // Last 20 actions → classifier counts (Faz 3 turns this into the health signal).
        const { data: actions } = await researchSupabaseAdmin
            .from('linkedin_actions')
            .select('type, status, classifier, created_at')
            .eq('tenant_id', tenantId).eq('account_id', id)
            .order('created_at', { ascending: false }).limit(20);

        res.json({ account, recent_actions: actions ?? [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'health error');
        next(new AppError('Failed to read health', 500));
    }
});

// ── POST /accounts/link-token — issue a single-use extension-pairing token ─────
const linkTokenSchema = z.object({ account_id: uuidField('Invalid account_id').optional() });
router.post('/link-token', requireWriter, validateBody(linkTokenSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { account_id } = req.body as z.infer<typeof linkTokenSchema>;

        // P1-2: a re-auth token must reference an account owned by THIS tenant. Verify
        // before minting, so a token can never carry another tenant's account_id.
        if (account_id) {
            const { data: acct, error: acctErr } = await researchSupabaseAdmin
                .from('linkedin_accounts').select('id')
                .eq('id', account_id).eq('tenant_id', tenantId).maybeSingle();
            if (acctErr) throw new AppError('Failed to issue link token', 500);
            if (!acct) { res.status(404).json({ error: 'Account not found' }); return; }
        }

        // Deep-link origin must be configured — a relative URL would not resolve for
        // the extension (critique P2-f). Fail loud rather than emit a broken link.
        const origin = process.env.LINKEDIN_APP_ORIGIN || process.env.CLIENT_URL;
        if (!origin) throw new AppError('LINKEDIN_APP_ORIGIN not configured', 500);

        // Raw token returned ONCE; only its SHA-256 hash is stored.
        const raw = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(raw).digest('hex');
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

        const { error } = await researchSupabaseAdmin.from('linkedin_link_tokens').insert({
            tenant_id: tenantId,
            token_hash: tokenHash,
            account_id: account_id ?? null,
            created_by: req.user?.id ?? null,
            expires_at: expiresAt.toISOString(),
        });
        if (error) throw new AppError('Failed to issue link token', 500);

        // Deep link the MV3 extension opens to capture cookies + POST them back.
        const url = `${origin}/linkedin/connect#token=${raw}`;
        res.status(201).json({ token: raw, url, expires_at: expiresAt.toISOString() });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'link-token error');
        next(new AppError('Failed to issue link token', 500));
    }
});

// ── POST /accounts/:id/validate — enqueue a liveness check ─────────────────────
router.post('/:id/validate', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const id = req.params.id;
        if (!uuidField().safeParse(id).success) { res.status(400).json({ error: 'Invalid id' }); return; }

        const { data: account, error: loadErr } = await researchSupabaseAdmin
            .from('linkedin_accounts').select('id')
            .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        if (loadErr) throw new AppError('Failed to enqueue validation', 500);
        if (!account) { res.status(404).json({ error: 'Account not found' }); return; }

        const job = await enqueueJob({
            tenantId,
            type: RESEARCH_JOB_TYPES.LINKEDIN_VALIDATE,
            payload: { account_id: id },
            maxAttempts: 1,             // non-idempotent network probe; operator re-runs on failure
            createdBy: req.user?.id ?? null,
        });
        // Parity with research routes: strip any cost fields for non-internal roles (P2-b).
        res.status(202).json(sanitizeJobForRole(
            job as unknown as Record<string, unknown>,
            await effectiveCostRole(req.user, req.tenantId),
        ));
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'enqueue validate error');
        next(new AppError('Failed to enqueue validation', 500));
    }
});

export default router;
