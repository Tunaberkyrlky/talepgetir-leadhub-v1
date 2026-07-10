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
    // The cookie's real browser Accept-Language (§3 anti-detection) — replayed verbatim.
    accept_language: z.string().max(256).optional().nullable(),
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
            // Re-auth an existing account (keep its sticky proxy_session_id) through the atomic RPC
            // (mig 112). It does the whole thing under the account row lock: confirms existence+
            // ownership (P1-2 rowcount guard), PRESERVES a hard state — a mere cookie re-upload
            // optimistically clears a soft NEEDS_REAUTH but must NEVER lift RESTRICTED/CHALLENGED/
            // PAUSED (the enqueued validate re-classifies) — and bumps session_epoch = session_epoch
            // + 1 in the SAME UPDATE that writes the new cookies. The atomic epoch bump is what closes
            // the stale-401 residual: any in-flight job holding the OLD epoch can no longer flip this
            // freshly-valid account to NEEDS_REAUTH (server/src/lib/linkedin/actions.ts).
            const { data: reauth, error } = await researchSupabaseAdmin.rpc('linkedin_capture_reauth', {
                p_tenant: tenantId, p_account: existingAccountId,
                p_li_at_enc: li_at_enc, p_jsessionid_enc: jsessionid_enc,
                p_user_agent: body.user_agent,
                p_geo: body.geo ?? null, p_timezone: body.timezone ?? null,
                p_accept_language: body.accept_language ?? null,
            });
            if (error) throw new AppError('Capture failed', 500);
            const r = (reauth ?? {}) as Record<string, unknown>;
            if (r.ok !== true) {
                if (r.error === 'account_not_found') { res.status(404).json({ error: 'Account no longer exists' }); return; }
                throw new AppError('Capture failed', 500);
            }
            accountId = existingAccountId;
        } else {
            const { data: inserted, error } = await researchSupabaseAdmin.from('linkedin_accounts')
                .insert({
                    tenant_id: tenantId, owner_user_id: createdBy, created_by: createdBy,
                    li_at_enc, jsessionid_enc, user_agent: body.user_agent,
                    geo: body.geo ?? null, timezone: body.timezone ?? null,
                    accept_language: body.accept_language ?? null,
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
