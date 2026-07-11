/**
 * Public lead intake (v3 §7.4 generic website form). Mounted BEFORE
 * authMiddleware with its own limiter — a website form can't send our session
 * cookie. Authenticated purely by the form's globally-unique public_slug; do NOT
 * trust req.tenantId (none pre-auth) — the tenant comes from the resolved form row.
 * Honeypot is accepted+ignored now; B3 layers Turnstile on top.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../../lib/supabase.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, leadIntakeSchema } from '../../lib/validation.js';
import { processIntake, type LeadFormRow } from '../../lib/leads/intake.js';

const router = Router();
const log = createLogger('route:leads:intake');

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

        // Process synchronously but do NOT branch the response on the outcome.
        await processIntake({
            form: form as unknown as LeadFormRow,
            rawPayload: payload,
            externalLeadId,
            testLead,
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
