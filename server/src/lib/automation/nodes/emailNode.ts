/**
 * Email node executor (v3 §10.1, §11.1 — Phase 5 C3). Replaces the skipped email STUB.
 *
 * Reads the node config { sending_class, subject, body_html, template_key, recipient },
 * resolves the recipient from the run context, calls the email CHANNEL adapter
 * (channels/email.ts — which resolves identity + applies the dry-run gate), and writes one
 * row to the messages ledger. WP4a asset delivery rides this same node (an asset link in
 * body_html); it is dry-run like every other send.
 *
 * GUARDRAIL: the channel adapter is DRY-RUN by default (AUTOMATION_WORKER_ENABLED!=='true')
 * and the runtime tick is flag-gated OFF, so this executor performs NO real send at rest.
 * At-most-once is the runtime's: stepRun inserts the (run,node) action row BEFORE calling
 * execute() and a re-step short-circuits on the 23505 WITHOUT re-running execute — so this
 * body (and its single messages insert) runs at most once per node.
 */
import type { NodeExecutor, NodeContext, NodeResult } from '../types.js';
import { supabaseAdmin } from '../../supabase.js';
import { createLogger } from '../../logger.js';
import { sendEmailChannel } from '../../channels/email.js';
import type { SendClass } from '../../mail/sendingIdentity.js';

const log = createLogger('lib:automation:nodes:email');

const SEND_CLASSES = new Set<SendClass>(['personal_grade', 'brand_transactional', 'marketing']);
/** Pragmatic RFC-lite email check (same shape used across the mail layer). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Read a dot-path (e.g. "lead.email" / "event.contact.email") out of the run context. */
function readPath(ctx: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, key) => {
        if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
        return undefined;
    }, ctx);
}

/**
 * Resolve the recipient email from config + context, in order:
 *   1. config.to            — an explicit literal email
 *   2. config.recipient_path — a dot-path into the assembled run context (C4 fills this)
 *   3. common context keys   — recipient_email / email (best-effort until C4)
 * Returns null when nothing resolves to a valid address (the node then skips, not fails).
 */
function resolveRecipient(config: Record<string, unknown>, context: Record<string, unknown>): string | null {
    const candidates: unknown[] = [];
    if (typeof config.to === 'string') candidates.push(config.to);
    if (typeof config.recipient_path === 'string') candidates.push(readPath(context, config.recipient_path));
    candidates.push(context.recipient_email, context.email);
    for (const c of candidates) {
        if (typeof c === 'string') {
            const trimmed = c.trim();
            if (EMAIL_RE.test(trimmed)) return trimmed;
        }
    }
    return null;
}

export const emailExecutor: NodeExecutor = {
    type: 'email',
    async execute(ctx: NodeContext): Promise<NodeResult> {
        const cfg = ctx.node.config ?? {};

        // Send class: default to brand_transactional (the safe automation default — a
        // system-looking send). An unknown value fails closed rather than guessing.
        const rawClass = (cfg.sending_class ?? cfg.send_class) as string | undefined;
        const sendClass: SendClass = (rawClass ?? 'brand_transactional') as SendClass;
        if (!SEND_CLASSES.has(sendClass)) {
            return { status: 'failed', retryReason: 'invalid_sending_class', output: { error: 'invalid_sending_class', value: rawClass } };
        }

        const to = resolveRecipient(cfg, ctx.context);
        if (!to) {
            // No recipient resolved (context not yet assembled / no link) — skip, do not fail.
            return { status: 'skipped', output: { skipped: 'no_recipient' } };
        }

        const subject = typeof cfg.subject === 'string' ? cfg.subject : '';
        const bodyHtml = typeof cfg.body_html === 'string' ? cfg.body_html : (typeof cfg.body === 'string' ? cfg.body : '');
        const templateKey = typeof cfg.template_key === 'string' ? cfg.template_key : null;
        const idemKey = `${ctx.run.id}:${ctx.nodeKey}`;

        const result = await sendEmailChannel({
            tenantId: ctx.run.tenant_id,
            sendClass,
            to,
            subject,
            bodyHtml,
            bodyText: typeof cfg.body_text === 'string' ? cfg.body_text : undefined,
            templateKey,
            idempotencyKey: idemKey,
            ownerUserId: typeof cfg.owner_user_id === 'string' ? cfg.owner_user_id : ctx.actorId,
            accountEmail: typeof cfg.account_email === 'string' ? cfg.account_email : null,
            replyTo: typeof cfg.reply_to === 'string' ? cfg.reply_to : null,
            // A node may force dry-run; otherwise the adapter's env gate governs.
            dryRun: cfg.dry_run === true,
        });

        // Link this send to the action ledger row stepRun inserted for (run, node) BEFORE
        // calling us. Best-effort — a lookup miss just leaves automation_action_id null.
        const { data: actionRow } = await supabaseAdmin
            .from('automation_actions')
            .select('id')
            .eq('run_id', ctx.run.id)
            .eq('node_key', ctx.nodeKey)
            .maybeSingle();

        const now = new Date().toISOString();
        const { data: messageRow, error: msgErr } = await supabaseAdmin
            .from('messages')
            .insert({
                tenant_id: ctx.run.tenant_id,
                lead_id: ctx.run.lead_id,
                company_id: ctx.run.company_id,
                direction: 'outbound',
                channel: 'email',
                provider: result.provider,
                provider_message_id: result.providerMessageId,
                template_key: templateKey,
                subject,
                body: bodyHtml || null,
                delivery_state: result.deliveryState,
                error_reason: result.reason ?? null,
                automation_run_id: ctx.run.id,
                automation_action_id: (actionRow as { id?: string } | null)?.id ?? null,
                sent_at: result.deliveryState === 'sent' ? now : null,
            })
            .select('id')
            .maybeSingle();
        if (msgErr) {
            // A ledger-write miss must not double-send. The send already happened (or was
            // skipped); surface the outcome but note the ledger gap.
            log.warn({ err: msgErr, runId: ctx.run.id, nodeKey: ctx.nodeKey }, 'messages ledger insert failed');
        }

        // Map the channel outcome onto the run cursor:
        //   sent            → succeeded (advance)
        //   failed          → failed    (terminal; retry/backoff is a later hardening)
        //   skipped, live   → PAUSE     (the send genuinely could not happen — identity
        //                                unresolved / transport inert; do NOT advance as if
        //                                sent. Park the run so an operator fixes config and
        //                                resumes. See channels/email.ts `live`.)
        //   skipped, !live  → skipped   (advance; the deliberate DRY-RUN simulation, or a
        //                                dry-run identity miss — the night guardrail path).
        const output = {
            delivery_state: result.deliveryState,
            send_class: result.sendClass,
            provider: result.provider,
            provider_message_id: result.providerMessageId ?? null,
            message_id: (messageRow as { id?: string } | null)?.id ?? null,
            reason: result.reason ?? null,
            dry_run: result.reason === 'dry_run',
            live: result.live,
        };

        if (result.deliveryState === 'sent') {
            return { status: 'succeeded', providerRequestId: result.providerMessageId ?? undefined, output };
        }
        if (result.deliveryState === 'failed') {
            return { status: 'failed', retryReason: result.reason, output };
        }
        // deliveryState === 'skipped'
        if (result.live) {
            // Live send that produced no message → pause (non-terminal), stay on this node.
            // status stays 'skipped' on the action ledger (no send occurred); pauseReason
            // drives the run-level pause in applyResult.
            log.warn(
                { runId: ctx.run.id, nodeKey: ctx.nodeKey, reason: result.reason, sendClass: result.sendClass },
                'email node: live send unresolved — pausing run (no advance)',
            );
            return { status: 'skipped', pauseReason: `email_send_unresolved:${result.reason ?? 'unknown'}`, output };
        }
        // Dry-run / simulation skip → advance normally (guardrail path unchanged).
        return { status: 'skipped', output };
    },
};
