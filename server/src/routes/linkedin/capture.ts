/**
 * TG-LinkedIn — public cookie-capture endpoint (mounted BEFORE authMiddleware,
 * own limiter). The browser extension can't send the httpOnly session cookie
 * cross-site, so this is authenticated purely by the single-use link token. Do NOT
 * trust req.tenantId (none pre-auth) — derive tenant/user from the atomically
 * claimed token row.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { createHash } from 'crypto';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody } from '../../lib/validation.js';
import { encryptCookie } from '../../lib/linkedin/crypto.js';
import { newProxySessionId } from '../../lib/linkedin/proxy.js';
import { enqueueJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPES } from '../../lib/research/jobTypes.js';

const log = createLogger('route:linkedin:capture');
const router = Router();

const captureSchema = z.object({
    token: z.string().min(32).max(128),
    li_at: z.string().min(1).max(4000),
    jsessionid: z.string().min(1).max(4000),
    user_agent: z.string().min(1).max(1000),
    geo: z.string().max(120).optional().nullable(),
    timezone: z.string().max(64).optional().nullable(),
});

// ── POST /api/linkedin/capture — extension posts captured cookies + UA ─────────
router.post('/', validateBody(captureSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const body = req.body as z.infer<typeof captureSchema>;
        const tokenHash = createHash('sha256').update(body.token).digest('hex');

        // Encrypt cookies BEFORE claiming the single-use token. encryptCookie throws 500
        // fail-closed on a missing/bad LINKEDIN_COOKIE_ENC_KEY; doing it first means a
        // server-config error can never BURN the token (encryption doesn't need the token).
        const li_at_enc = encryptCookie(body.li_at);
        const jsessionid_enc = encryptCookie(body.jsessionid);

        // Atomically CLAIM the single-use token (used_at IS NULL AND not expired).
        const now = new Date().toISOString();
        const { data: claimed, error: claimErr } = await researchSupabaseAdmin
            .from('linkedin_link_tokens')
            .update({ used_at: now })
            .eq('token_hash', tokenHash)
            .is('used_at', null)
            .gt('expires_at', now)
            .select('tenant_id, account_id, created_by')
            .maybeSingle();
        if (claimErr) throw new AppError('Capture failed', 500);
        if (!claimed) { res.status(401).json({ error: 'Invalid, used, or expired token' }); return; }

        const tenantId = (claimed as { tenant_id: string }).tenant_id;
        const existingAccountId = (claimed as { account_id: string | null }).account_id;
        const createdBy = (claimed as { created_by: string | null }).created_by;

        let accountId: string;
        if (existingAccountId) {
            // Re-auth an existing account (keep its sticky proxy_session_id). Read current
            // status first: confirms existence+ownership (P1-2 rowcount guard) AND lets us
            // preserve a hard state — a mere cookie re-upload optimistically clears a soft
            // NEEDS_REAUTH but must NEVER lift RESTRICTED/CHALLENGED/PAUSED (the enqueued
            // validate re-classifies).
            const { data: existing, error: readErr } = await researchSupabaseAdmin.from('linkedin_accounts')
                .select('id, status').eq('id', existingAccountId).eq('tenant_id', tenantId).maybeSingle();
            if (readErr) throw new AppError('Capture failed', 500);
            if (!existing) { res.status(404).json({ error: 'Account no longer exists' }); return; }
            const prev = (existing as { status: string }).status;
            const nextStatus = (prev === 'NEEDS_REAUTH' || prev === 'ACTIVE') ? 'ACTIVE' : prev;
            const { error } = await researchSupabaseAdmin.from('linkedin_accounts')
                .update({
                    li_at_enc, jsessionid_enc, user_agent: body.user_agent,
                    geo: body.geo ?? null, timezone: body.timezone ?? null,
                    status: nextStatus,
                })
                .eq('id', existingAccountId).eq('tenant_id', tenantId);
            if (error) throw new AppError('Capture failed', 500);
            accountId = existingAccountId;
        } else {
            const { data: inserted, error } = await researchSupabaseAdmin.from('linkedin_accounts')
                .insert({
                    tenant_id: tenantId, owner_user_id: createdBy, created_by: createdBy,
                    li_at_enc, jsessionid_enc, user_agent: body.user_agent,
                    geo: body.geo ?? null, timezone: body.timezone ?? null,
                    proxy_session_id: newProxySessionId(),
                    status: 'ACTIVE',
                })
                .select('id').single();
            if (error) throw new AppError('Capture failed', 500);
            accountId = (inserted as { id: string }).id;
        }

        // Audit + kick a liveness check. A failed audit row is a gap in the health/
        // rate-limit trail but must not fail an otherwise-successful capture — log it.
        const { error: auditErr } = await researchSupabaseAdmin.from('linkedin_actions').insert({
            tenant_id: tenantId, account_id: accountId, type: 'capture', status: 'ok', classifier: 'success',
        });
        if (auditErr) log.warn({ err: auditErr, accountId }, 'capture audit insert failed (non-fatal)');
        await enqueueJob({
            tenantId, type: RESEARCH_JOB_TYPES.LINKEDIN_VALIDATE,
            payload: { account_id: accountId }, maxAttempts: 1, createdBy,
        });

        res.status(201).json({ ok: true, account_id: accountId });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'capture error');
        next(new AppError('Capture failed', 500));
    }
});

export default router;
