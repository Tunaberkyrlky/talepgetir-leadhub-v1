/**
 * linkedin:message — send ONE new-conversation message (§4.2).
 *
 * Same DRY-RUN-default safety spine as linkedin:invite. The sender's own member_urn
 * (resolved at validate) is the mailboxUrn — a message can't be sent from an account with
 * no resolved identity, so a null member_urn is a SKIP (validate the account first).
 * Reply-to-existing-thread (conversationUrn) is a Faz-4 refinement.
 */
import type { JobHandler } from '../types.js';
import { createLogger } from '../../../logger.js';
import { sendMessage, isNotSent } from '../../../linkedin/client.js';
import {
    loadAccount, credsFor, dispatcherFor, currentCount, consumeQuota, releaseQuota,
    applyWriteHealth, auditAction, dailyCapFor, weeklyCapFor, scheduleSendAt, weeklyCount,
    maybeDeferSend, COUNTER_KEY,
} from '../../../linkedin/actions.js';

const log = createLogger('research:handler:linkedin-message');
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

    // Reserve a daily slot (atomic, fenced, ACTIVE-gated + rolling-weekly under the row lock).
    const grant = await consumeQuota(tenantId, accountId, ACTION, dailyCap, weeklyCap);
    if (!grant.granted) {
        const classifier = grant.reason === 'not_active' ? `account_${(grant.status ?? 'unknown').toLowerCase()}`
            : grant.reason === 'weekly_cap' ? 'weekly_cap' : 'daily_cap';
        await auditAction({ tenantId, accountId, type: 'message', status: 'skipped', classifier, jobId: job.id });
        return { account_id: accountId, type: 'message', sent: false, skipped: classifier, quota: grant };
    }

    let creds, dispatcher;
    try {
        creds = credsFor(account);
        dispatcher = dispatcherFor(account);
    } catch (err) {
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'message', status: 'error', classifier: 'transport_error', error: err instanceof Error ? err.message : String(err), jobId: job.id });
        throw err;
    }

    let result;
    try {
        result = await sendMessage(creds, dispatcher, {
            mailboxUrn: account.member_urn, recipientUrn, text: body,
        });
    } catch (err) {
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'message', status: 'error', classifier: 'transport_error', error: err instanceof Error ? err.message : String(err), jobId: job.id });
        throw new Error(`linkedin:message transport error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (isNotSent(result.classifier)) await releaseQuota(tenantId, accountId, COUNTER);

    const finalStatus = await applyWriteHealth(tenantId, account, result.classifier);
    await auditAction({
        tenantId, accountId, type: 'message', status: result.sent ? 'ok' : 'error',
        classifier: result.classifier, httpStatus: result.httpStatus, error: result.detail ?? null, jobId: job.id,
    });

    log.info({ jobId: job.id, accountId, classifier: result.classifier, status: finalStatus }, 'linkedin:message complete');
    return {
        account_id: accountId, type: 'message', sent: result.sent, classifier: result.classifier,
        http_status: result.httpStatus, account_status: finalStatus,
    };
};
