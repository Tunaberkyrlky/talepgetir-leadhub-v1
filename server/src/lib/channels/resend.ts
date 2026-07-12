/**
 * Resend transactional adapter (v3 §11.1, §26 lib/channels/resend.ts).
 *
 * The brand_transactional transport for the channel layer: booking receipts, "your
 * report link", system notices — the messages a lead should see leave FROM the brand,
 * via Resend (systemMailer.ts). This is a thin, TYPED wrapper so the email channel
 * adapter gets a discriminated result (sent | skipped | failed) instead of a throw.
 *
 * ENV-GATED INERT: with RESEND_API_KEY / RESEND_FROM_EMAIL unset (systemMailer
 * isConfigured() === false) send() is a NO-OP — it returns
 * { providerMessageId: null, deliveryState: 'skipped', reason: 'resend_inert' } and
 * sends NOTHING. So on the night worker (no Resend env) this can never leak a live send,
 * independently of the email node's own dry-run gate.
 *
 * IDEMPOTENCY: systemMailer.sendSystemEmail exposes no Idempotency-Key header today, so
 * provider-level idempotency is NOT available here. At-most-once is enforced upstream by
 * the automation action ledger (one action per run+node) + messages.provider_message_id
 * UNIQUE — never by this adapter re-checking the provider.
 */
import { isConfigured, sendSystemEmail } from '../systemMailer.js';
import { createLogger } from '../logger.js';

const log = createLogger('channels:resend');

/** Discriminated send outcome — the email channel adapter maps this to a messages row. */
export interface ResendSendResult {
    /** Resend message id on a real send; null when inert / failed. */
    providerMessageId: string | null;
    /** sent = delivered to Resend; skipped = env-inert (no send); failed = provider error. */
    deliveryState: 'sent' | 'skipped' | 'failed';
    /** Machine reason on skipped / failed (e.g. 'resend_inert'); absent on sent. */
    reason?: string;
}

export interface ResendSendParams {
    to: string | string[];
    subject: string;
    html: string;
    text?: string;
    replyTo?: string | null;
    cc?: string | string[];
    bcc?: string | string[];
}

/**
 * Send a transactional email via Resend. Never throws — a provider error is captured as
 * { deliveryState: 'failed' } so the caller can record it on the ledger without aborting
 * the run. Returns { deliveryState: 'skipped', reason: 'resend_inert' } when Resend is
 * not configured (the night guardrail).
 */
export async function sendViaResend(params: ResendSendParams): Promise<ResendSendResult> {
    if (!isConfigured()) {
        // Env-inert: no RESEND_API_KEY / RESEND_FROM_EMAIL. Do NOT send.
        log.info({ subject: params.subject.slice(0, 60) }, 'Resend inert (unconfigured) — no send');
        return { providerMessageId: null, deliveryState: 'skipped', reason: 'resend_inert' };
    }
    try {
        const result = await sendSystemEmail({
            to: params.to,
            subject: params.subject,
            html: params.html,
            text: params.text,
            replyTo: params.replyTo ?? undefined,
            cc: params.cc,
            bcc: params.bcc,
        });
        return { providerMessageId: result.messageId, deliveryState: 'sent' };
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.error({ err, subject: params.subject.slice(0, 60) }, 'Resend send failed');
        return { providerMessageId: null, deliveryState: 'failed', reason };
    }
}
