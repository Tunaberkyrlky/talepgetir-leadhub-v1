/**
 * Public lead intake (v3 §7.4 generic website form). Mounted BEFORE
 * authMiddleware with its own limiter — a website form can't send our session
 * cookie. Authenticated purely by the form's globally-unique public_slug; do NOT
 * trust req.tenantId (none pre-auth) — the tenant comes from the resolved form row.
 * Honeypot + Cloudflare Turnstile (env-gated) both mark spam WITHOUT changing the
 * uniform response (never signal a bot that it was caught).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { request } from 'undici';
import { supabaseAdmin } from '../../lib/supabase.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, leadIntakeSchema } from '../../lib/validation.js';
import { processIntake, type LeadFormRow } from '../../lib/leads/intake.js';

const router = Router();
const log = createLogger('route:leads:intake');

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TIMEOUT_MS = 3_000;

/**
 * Verify a Cloudflare Turnstile token. Returns `false` ONLY on an explicit
 * verification failure (Cloudflare says success=false). A transport error
 * (Cloudflare unreachable / timeout) fails OPEN — returns `true` — so a CF
 * outage can never lock legitimate submitters out of a customer's form.
 */
async function verifyTurnstile(token: string, secret: string, remoteip?: string): Promise<boolean> {
    try {
        // remoteip binds the challenge to the submitter's IP. Behind a proxy this is
        // only as trustworthy as Express's trust-proxy / X-Forwarded-For handling;
        // when unavailable we omit it (the field is optional to Cloudflare).
        const form: Record<string, string> = { secret, response: token };
        if (remoteip) form.remoteip = remoteip;
        const res = await request(TURNSTILE_VERIFY_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(form).toString(),
            signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
        });
        const json = (await res.body.json()) as { success?: boolean };
        return json.success === true;
    } catch (err) {
        log.warn({ err }, 'turnstile siteverify unreachable — failing open');
        return true;
    }
}

function truthy(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    if (typeof value === 'number') return value !== 0;
    return false;
}

// Opaque server-generated base64url token (crypto.randomBytes(18) ⇒ 24 chars).
const SLUG_RE = /^[A-Za-z0-9_-]{16,64}$/;

// ── POST /api/lead-intake/:formSlug ───────────────────────────────────────────
router.post('/:formSlug', validateBody(leadIntakeSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const slug = String(req.params.formSlug || '');
        // Reject malformed slugs up front — never touch the DB with junk.
        if (!SLUG_RE.test(slug)) { res.status(404).json({ error: 'Form not found' }); return; }

        const { data: form, error } = await supabaseAdmin
            .from('lead_forms')
            .select('id, tenant_id, source_id, field_mapping, honeypot_field, success_behavior, is_active')
            .eq('public_slug', slug)
            .maybeSingle();
        if (error) throw new AppError('Intake failed', 500);
        // Unknown/inactive slug → 404, no write, no tenant leak.
        if (!form || !(form as { is_active: boolean }).is_active) { res.status(404).json({ error: 'Form not found' }); return; }

        const payload = req.body as Record<string, unknown>;
        const externalLeadId = typeof payload.external_lead_id === 'string' ? payload.external_lead_id : null;
        const testLead = truthy(payload.is_test) || truthy(payload._test);

        // ── Turnstile (env-gated): only enforced when TURNSTILE_SECRET is set.
        // With the secret unset the whole check is skipped and behavior is
        // unchanged. A missing token with the secret set is spam (turnstilePass
        // = false) without wasting a network round-trip.
        let turnstilePass: boolean | null = null;
        const turnstileSecret = process.env.TURNSTILE_SECRET;
        if (turnstileSecret) {
            const token = typeof payload['cf-turnstile-response'] === 'string'
                ? (payload['cf-turnstile-response'] as string).trim() : '';
            // Pass req.ip regardless of trust-proxy config; see verifyTurnstile note.
            turnstilePass = token ? await verifyTurnstile(token, turnstileSecret, req.ip) : false;
        } else {
            log.debug('TURNSTILE_SECRET unset — skipping Turnstile verification');
        }

        // Strip the Turnstile token before anything reaches the DB: it is a one-time
        // per-challenge secret that must never land in raw_payload, and — being unique
        // per submission — would otherwise defeat the organic-dedup fingerprint. The
        // honeypot field is deliberately kept; the spam audit trail relies on it.
        const sanitizedPayload = { ...payload };
        delete sanitizedPayload['cf-turnstile-response'];

        // Process synchronously but do NOT branch the response on the outcome.
        await processIntake({
            form: form as unknown as LeadFormRow,
            rawPayload: sanitizedPayload,
            externalLeadId,
            testLead,
            turnstilePass,
        });

        // Fast, UNIFORM 200 for every accepted submission — never reveal the internal
        // created/duplicate/ignored outcome to the poster (that would leak identity
        // enumeration and honeypot detection). The outcome lives only on the
        // submission record. success_behavior is per-form config, invariant across
        // outcomes, so returning it does not leak state.
        const successBehavior = (form as { success_behavior?: unknown }).success_behavior ?? { type: 'message' };
        res.status(200).json({ ok: true, success: successBehavior });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'lead intake error');
        next(new AppError('Intake failed', 500));
    }
});

export default router;
