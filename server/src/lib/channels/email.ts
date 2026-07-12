/**
 * Email channel adapter (v3 §11.1, §26 lib/channels/email.ts).
 *
 * The single seam the automation email node calls to "send an email". It resolves WHICH
 * identity the message goes out AS (sendingIdentity.ts, B1) and routes to the right
 * transport:
 *   brand_transactional → Resend           (channels/resend.ts)
 *   personal_grade      → the owner mailbox (mail router → SMTP/Nango)
 *   marketing           → NOT wired here    (belongs to the campaign engine / cold side;
 *                         this transactional adapter deliberately does not touch it, §2.3.1)
 *
 * GUARDRAIL — DRY-RUN BY DEFAULT (the night guardrail):
 * When AUTOMATION_WORKER_ENABLED !== 'true' (or the caller passes dryRun) NO real send
 * happens. The identity is resolved (a pure READ) and the intended send is LOGGED, but the
 * transport is never invoked; the result is { deliveryState: 'skipped', reason: 'dry_run' }.
 * This is a SECOND, independent gate on top of (a) the flag-gated, unwired runtimeTick and
 * (b) Resend/SMTP being env-inert — so even a personal_grade owner mailbox with real SMTP
 * creds cannot leak a live send at night.
 *
 * IDEMPOTENCY: this adapter does not itself dedupe. At-most-once is enforced by the caller
 * (the runtime action ledger: one action per run+node) + messages.provider_message_id
 * UNIQUE. idempotencyKey is threaded only for logging/traceability.
 *
 * This adapter never throws — every failure path returns a typed result the caller records.
 */
import { resolveSendingIdentity, type SendClass } from '../mail/sendingIdentity.js';
import { sendMail } from '../mail/router.js';
import { sendViaResend } from './resend.js';
import { createLogger } from '../logger.js';
import type { MailProviderName } from '../mail/types.js';

const log = createLogger('channels:email');

export interface EmailChannelInput {
    tenantId: string;
    /** Which identity to send AS (defaults to brand_transactional at the caller). */
    sendClass: SendClass;
    /** Recipient email (already resolved from run context by the caller). */
    to: string;
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    /** Template handle recorded on the messages ledger (audit only). */
    templateKey?: string | null;
    /** Traceability key (runId:nodeKey) — logged; NOT a provider idempotency header. */
    idempotencyKey: string;
    /** personal_grade: pin the owner whose mailbox we send AS (email_connections.owner_user_id). */
    ownerUserId?: string | null;
    /** Pin an explicit mailbox (personal_grade From, or marketing rotation box). */
    accountEmail?: string | null;
    /** brand_transactional: person-looking reply-to owner (§3.2.3). */
    replyTo?: string | null;
    /** Force dry-run even if the worker flag is on (a node-level override). */
    dryRun?: boolean;
}

/** Discriminated outcome the caller maps onto a messages row + NodeResult. */
export interface EmailChannelResult {
    /** sent = real send; skipped = dry-run / inert / unresolved identity; failed = provider error. */
    deliveryState: 'sent' | 'skipped' | 'failed';
    /** External id on a real send; null otherwise. */
    providerMessageId: string | null;
    /** The transport's provider name once resolved; null when unresolved / dry-run. */
    provider: MailProviderName | null;
    /** Machine reason on skipped / failed (e.g. 'dry_run', 'resend_inert', the resolve reason). */
    reason?: string;
    /** The resolved send class (echoed for the ledger). */
    sendClass: SendClass;
    /**
     * Whether this was a LIVE send attempt (AUTOMATION_WORKER_ENABLED==='true' and NOT a
     * dryRun override). The caller needs this to disambiguate a `skipped` outcome:
     *   live===false → deliberate DRY-RUN simulation (or a dry-run identity miss) → ADVANCE.
     *   live===true  → the send genuinely could not happen (identity unresolved / transport
     *                  inert) → PAUSE the run instead of silently advancing.
     * A `skipped` reason is never 'dry_run' when live===true (that reason is dry-run only).
     */
    live: boolean;
}

/** Is this a real, live send? Only the literal 'true' flag enables it, and never in dryRun. */
function isLiveSend(dryRun?: boolean): boolean {
    if (dryRun) return false;
    return process.env.AUTOMATION_WORKER_ENABLED === 'true';
}

/**
 * Resolve the sending identity, apply the dry-run gate, and (only on a live send) dispatch
 * to the transport. Returns a typed result — never throws. The caller writes the messages
 * ledger row from this result.
 */
export async function sendEmailChannel(input: EmailChannelInput): Promise<EmailChannelResult> {
    const { tenantId, sendClass, to, subject, idempotencyKey } = input;
    const live = isLiveSend(input.dryRun);

    // Identity resolution is a PURE READ (never sends) — safe to run even in dry-run so the
    // intended identity is visible in logs / the skipped ledger row.
    //
    // The resolver rejects an ownerUserId on any NON-personal class (it is a personal-grade
    // owner-mailbox pin only), so forward it ONLY for personal_grade. For brand_transactional
    // the resolver reads `accountEmail` as the person reply-to hint (§3.2.3), so pass replyTo
    // there; marketing keeps accountEmail as the rotation-selected box.
    const identity = await resolveSendingIdentity({
        tenantId,
        sendClass,
        ownerUserId: sendClass === 'personal_grade' ? (input.ownerUserId ?? null) : null,
        accountEmail: sendClass === 'brand_transactional'
            ? (input.replyTo ?? input.accountEmail ?? null)
            : (input.accountEmail ?? null),
    });

    if (!identity.ok) {
        // Unresolved identity → NO send (never falls back to the brand, §3.2.5). This check
        // runs BEFORE the dry-run gate, so it fires in BOTH modes: in dry-run it is a
        // simulated skip (advance), but on a LIVE send it means the step genuinely cannot
        // proceed — the caller pauses the run (via `live`) so an operator fixes the mailbox.
        log.info(
            { tenantId, sendClass, reason: identity.reason, idempotencyKey, live },
            'email channel: identity unresolved — no send',
        );
        return { deliveryState: 'skipped', providerMessageId: null, provider: null, reason: identity.reason, sendClass, live };
    }

    // DRY-RUN gate (the night guardrail). Log the intended send; do NOT dispatch.
    if (!live) {
        log.info(
            {
                tenantId, to, subject: subject.slice(0, 60), sendClass,
                transport: identity.transport, idempotencyKey,
            },
            'email channel: DRY-RUN — intended send NOT dispatched',
        );
        return { deliveryState: 'skipped', providerMessageId: null, provider: null, reason: 'dry_run', sendClass, live };
    }

    // ── LIVE send (only when AUTOMATION_WORKER_ENABLED==='true' and not dryRun) ──────────
    switch (identity.transport) {
        case 'resend': {
            const r = await sendViaResend({
                to,
                subject,
                html: input.bodyHtml,
                text: input.bodyText,
                replyTo: identity.replyTo ?? input.replyTo ?? undefined,
            });
            return {
                deliveryState: r.deliveryState,
                providerMessageId: r.providerMessageId,
                provider: r.deliveryState === 'sent' ? 'resend' : null,
                reason: r.reason,
                sendClass,
                live,
            };
        }
        case 'owner_mailbox': {
            // personal_grade: 1:1 from the owner's real mailbox. The mail router resolves the
            // concrete provider (SMTP / Nango-Gmail / Outlook) from the connection.
            try {
                const result = await sendMail({
                    channel: 'compose',
                    tenantId,
                    accountEmail: identity.accountEmail,
                    to,
                    subject,
                    bodyHtml: input.bodyHtml,
                    bodyText: input.bodyText,
                    replyTo: input.replyTo ?? undefined,
                    fromName: identity.fromName ?? undefined,
                });
                return {
                    deliveryState: result.success ? 'sent' : 'failed',
                    providerMessageId: result.providerMessageId ?? null,
                    provider: result.provider,
                    sendClass,
                    live,
                };
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                log.error({ err, tenantId, idempotencyKey }, 'email channel: owner mailbox send failed');
                return { deliveryState: 'failed', providerMessageId: null, provider: null, reason, sendClass, live };
            }
        }
        case 'campaign_mailbox': {
            // marketing → the drip rotation box. Deliberately NOT dispatched here: campaign
            // (cold-email) sending is the campaign engine's domain (§2.3.1), not this
            // transactional adapter. Record a skip so nothing leaks into that path.
            log.info({ tenantId, idempotencyKey }, 'email channel: marketing send is not wired here (campaign engine owns it)');
            return { deliveryState: 'skipped', providerMessageId: null, provider: null, reason: 'marketing_not_wired_here', sendClass, live };
        }
    }
}
