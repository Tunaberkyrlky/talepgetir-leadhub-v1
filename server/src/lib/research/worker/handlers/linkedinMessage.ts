/**
 * linkedin:message — send ONE new-conversation message (§4.2).
 *
 * Same DRY-RUN-default safety spine as linkedin:invite. The sender's own member_urn
 * (resolved at validate) is the mailboxUrn — a message can't be sent from an account with
 * no resolved identity, so a null member_urn is a SKIP (validate the account first).
 * Reply-to-existing-thread (conversationUrn) is a Faz-4 refinement.
 */
import type { JobHandler } from '../types.js';
import {
    loadAccount, currentCount, auditAction, dailyCapFor, weeklyCapFor, scheduleSendAt, weeklyCount,
    maybeDeferSend, COUNTER_KEY,
} from '../../../linkedin/actions.js';
import { performMessage } from '../../../linkedin/executor.js';

const COUNTER = COUNTER_KEY.message;
const ACTION = 'message' as const;
const TEXT_MAX = 8000; // LinkedIn message body ceiling (generous; real limit ~8k chars)

export const linkedinMessageHandler: JobHandler = async ({ job, heartbeat }) => {
    const tenantId = job.tenant_id;
    const p = (job.payload ?? {}) as Record<string, unknown>;
    const accountId = typeof p.account_id === 'string' ? p.account_id : null;
    if (!accountId) throw new Error('linkedin:message requires payload.account_id');

    const recipientUrn = typeof p.recipient_urn === 'string' && p.recipient_urn ? p.recipient_urn : null;
    const text = typeof p.text === 'string' ? p.text : '';
    const dryRun = p.dry_run !== false; // SAFE DEFAULT
    const sendNow = p.send_now === true; // bypass execution-time working-hours recheck
    if (!recipientUrn) throw new Error('linkedin:message requires payload.recipient_urn');
    if (!text.trim()) throw new Error('linkedin:message requires non-empty payload.text');
    const body = text.slice(0, TEXT_MAX);

    await heartbeat({ stage: 'message', account_id: accountId, dry_run: dryRun });

    const account = await loadAccount(tenantId, accountId);
    if (!account) throw new Error(`linkedin:message: account ${accountId} not found for tenant ${tenantId}`);

    const dailyCap = dailyCapFor(account, ACTION);
    const weeklyCap = weeklyCapFor(ACTION);

    // ── DRY-RUN preview ───────────────────────────────────────────────────────────
    if (dryRun) {
        const current = currentCount(account, COUNTER);
        const week = await weeklyCount(tenantId, accountId, ACTION);
        const schedule = await scheduleSendAt(account, tenantId, { jitter: false });
        return {
            dry_run: true, account_id: accountId, type: 'message',
            account_status: account.status,
            has_identity: !!account.member_urn,
            recipient_urn: recipientUrn, text_length: body.length,
            quota: { current, cap: dailyCap, weekly: week, weekly_cap: weeklyCap },
            schedule: { next_send_at: schedule.atIso, immediate: schedule.immediate },
            would_send: account.status === 'ACTIVE' && !!account.member_urn && current < dailyCap && week < weeklyCap,
        };
    }

    // ── Real send ─────────────────────────────────────────────────────────────────
    if (account.status !== 'ACTIVE') {
        await auditAction({ tenantId, accountId, type: 'message', status: 'skipped', classifier: `account_${account.status.toLowerCase()}`, jobId: job.id });
        return { account_id: accountId, type: 'message', sent: false, skipped: `account_${account.status}` };
    }
    if (!account.member_urn) {
        // No mailboxUrn → validate the account first. Not a throw (permanent until re-validate).
        await auditAction({ tenantId, accountId, type: 'message', status: 'skipped', classifier: 'no_identity', jobId: job.id });
        return { account_id: accountId, type: 'message', sent: false, skipped: 'no_identity' };
    }

    // Execution-time working-hours recheck (§2): a late worker must not fire off-window. Defers
    // to a fresh job before reserving quota; send_now bypasses. (member_urn re-checked above.)
    const defer = await maybeDeferSend(account, tenantId, job.type,
        { recipient_urn: recipientUrn, text: body }, { sendNow, createdBy: job.created_by });
    if (defer.deferred) return { account_id: accountId, type: 'message', sent: false, deferred: true, rescheduled_to: defer.rescheduledTo, rescheduled_job_id: defer.rescheduledJobId };

    // Reserve → send → refund-if-not-sent → health → audit (shared spine).
    const outcome = await performMessage(account, tenantId, { recipientUrn, text: body }, job.id);
    return {
        account_id: accountId, type: 'message', sent: outcome.sent, classifier: outcome.classifier,
        http_status: outcome.httpStatus, account_status: outcome.accountStatus,
        ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
    };
};
