/**
 * linkedin:invite — send ONE connection request (§4.1), noteless by default.
 *
 * DRY-RUN is the DEFAULT (payload.dry_run !== false): it previews the exact plan with no
 * decrypt, no network and no quota consume, so it runs with zero env keys and can never
 * send by accident. A real send requires dry_run === false AND an ACTIVE account.
 *
 * Safety spine (see lib/linkedin/actions.ts): reserve a daily-quota slot BEFORE sending,
 * refund it if the write did not land, classify §4.4 (never HTTP-status alone), transition
 * account health, and write exactly one audit row. maxAttempts=1 upstream (non-idempotent).
 */
import type { JobHandler } from '../types.js';
import { createLogger } from '../../../logger.js';
import { sendInvite, resolveProfileUrn, isNotSent } from '../../../linkedin/client.js';
import { INVITE_NOTE_MAX } from '../../../linkedin/voyager.js';
import {
    loadAccount, credsFor, dispatcherFor, currentCount, consumeQuota, releaseQuota,
    applyWriteHealth, classifierForHttp, auditAction, dailyCapFor, weeklyCapFor,
    scheduleSendAt, weeklyCount, maybeDeferSend, COUNTER_KEY,
} from '../../../linkedin/actions.js';

const log = createLogger('research:handler:linkedin-invite');
const COUNTER = COUNTER_KEY.invite;
const ACTION = 'invite' as const;

export const linkedinInviteHandler: JobHandler = async ({ job, heartbeat }) => {
    const tenantId = job.tenant_id;
    const p = (job.payload ?? {}) as Record<string, unknown>;
    const accountId = typeof p.account_id === 'string' ? p.account_id : null;
    if (!accountId) throw new Error('linkedin:invite requires payload.account_id');

    const profileUrn = typeof p.profile_urn === 'string' && p.profile_urn ? p.profile_urn : null;
    const publicId = typeof p.public_id === 'string' && p.public_id ? p.public_id : null;
    const note = typeof p.note === 'string' ? p.note.trim().slice(0, INVITE_NOTE_MAX) : '';
    const dryRun = p.dry_run !== false; // SAFE DEFAULT: preview unless explicitly false
    const sendNow = p.send_now === true; // bypass execution-time working-hours recheck
    if (!profileUrn && !publicId) throw new Error('linkedin:invite requires payload.profile_urn or payload.public_id');

    await heartbeat({ stage: 'invite', account_id: accountId, dry_run: dryRun });

    const account = await loadAccount(tenantId, accountId);
    if (!account) throw new Error(`linkedin:invite: account ${accountId} not found for tenant ${tenantId}`);

    const dailyCap = dailyCapFor(account, ACTION);
    const weeklyCap = weeklyCapFor(ACTION);

    // ── DRY-RUN: deterministic preview, no side effects (reads are plain SELECTs) ──
    if (dryRun) {
        const current = currentCount(account, COUNTER);
        const week = await weeklyCount(tenantId, accountId, ACTION);
        const schedule = await scheduleSendAt(account, tenantId, { jitter: false });
        return {
            dry_run: true, account_id: accountId, type: 'invite',
            account_status: account.status,
            target: profileUrn ?? { public_id: publicId, note: 'resolved at send' },
            note_length: note.length, noteless: note.length === 0,
            quota: { current, cap: dailyCap, weekly: week, weekly_cap: weeklyCap },
            schedule: { next_send_at: schedule.atIso, immediate: schedule.immediate },
            would_send: account.status === 'ACTIVE' && current < dailyCap && week < weeklyCap,
        };
    }

    // ── Real send ─────────────────────────────────────────────────────────────────
    // Hard account states are a SKIP (not a throw): the job has done its job by refusing.
    if (account.status !== 'ACTIVE') {
        await auditAction({ tenantId, accountId, type: 'invite', status: 'skipped', classifier: `account_${account.status.toLowerCase()}`, jobId: job.id });
        return { account_id: accountId, type: 'invite', sent: false, skipped: `account_${account.status}` };
    }

    // Execution-time working-hours recheck: a late worker must not fire off-window (§2). Defers
    // to a fresh job at the next humane slot BEFORE reserving quota (no slot leak). send_now skips.
    const defer = await maybeDeferSend(account, tenantId, job.type,
        { profile_urn: profileUrn, public_id: publicId, note }, { sendNow, createdBy: job.created_by });
    if (defer.deferred) return { account_id: accountId, type: 'invite', sent: false, deferred: true, rescheduled_to: defer.rescheduledTo, rescheduled_job_id: defer.rescheduledJobId };

    // Reserve a daily slot up front (atomic, fenced, ACTIVE-gated + rolling-weekly). The RPC
    // re-checks status under the row lock, so a PAUSE that raced our pre-check still blocks it.
    const grant = await consumeQuota(tenantId, accountId, ACTION, dailyCap, weeklyCap);
    if (!grant.granted) {
        const classifier = grant.reason === 'not_active' ? `account_${(grant.status ?? 'unknown').toLowerCase()}`
            : grant.reason === 'weekly_cap' ? 'weekly_cap' : 'daily_cap';
        await auditAction({ tenantId, accountId, type: 'invite', status: 'skipped', classifier, jobId: job.id });
        return { account_id: accountId, type: 'invite', sent: false, skipped: classifier, quota: grant };
    }

    let creds, dispatcher;
    try {
        creds = credsFor(account);
        dispatcher = dispatcherFor(account);
    } catch (err) {
        // Decrypt / proxy config failure = transport class → refund + fail the job.
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'invite', status: 'error', classifier: 'transport_error', error: err instanceof Error ? err.message : String(err), jobId: job.id });
        throw err;
    }

    // Resolve the profile urn if only a public id was given (best-effort GET, §4.3).
    let targetUrn = profileUrn;
    if (!targetUrn && publicId) {
        let resolved;
        try {
            resolved = await resolveProfileUrn(creds, dispatcher, publicId);
        } catch (err) {
            await releaseQuota(tenantId, accountId, COUNTER);
            await auditAction({ tenantId, accountId, type: 'invite', status: 'error', classifier: 'transport_error', error: err instanceof Error ? err.message : String(err), jobId: job.id });
            throw err;
        }
        targetUrn = resolved.urn;
        if (!targetUrn) {
            await releaseQuota(tenantId, accountId, COUNTER);
            // A 401/403/999 during resolution is a HEALTH signal (not a plain miss): transition
            // the account so a dead/restricted session isn't left ACTIVE (codex P2).
            const healthClassifier = classifierForHttp(resolved.httpStatus);
            if (healthClassifier) {
                const st = await applyWriteHealth(tenantId, account, healthClassifier);
                await auditAction({ tenantId, accountId, type: 'invite', status: 'error', classifier: healthClassifier, httpStatus: resolved.httpStatus, jobId: job.id });
                return { account_id: accountId, type: 'invite', sent: false, skipped: healthClassifier, account_status: st };
            }
            // Otherwise a genuine miss: data problem, not transport → skip, don't retry-burn.
            await auditAction({ tenantId, accountId, type: 'invite', status: 'skipped', classifier: 'urn_unresolved', httpStatus: resolved.httpStatus, jobId: job.id });
            return { account_id: accountId, type: 'invite', sent: false, skipped: 'urn_unresolved', public_id: publicId };
        }
    }

    let result;
    try {
        result = await sendInvite(creds, dispatcher, targetUrn!, note || undefined);
    } catch (err) {
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'invite', status: 'error', classifier: 'transport_error', error: err instanceof Error ? err.message : String(err), jobId: job.id });
        throw new Error(`linkedin:invite transport error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Give the slot back if LinkedIn definitively did not create the invite.
    if (isNotSent(result.classifier)) await releaseQuota(tenantId, accountId, COUNTER);

    const finalStatus = await applyWriteHealth(tenantId, account, result.classifier);
    await auditAction({
        tenantId, accountId, type: 'invite', status: result.sent ? 'ok' : 'error',
        classifier: result.classifier, httpStatus: result.httpStatus, error: result.detail ?? null, jobId: job.id,
    });

    log.info({ jobId: job.id, accountId, classifier: result.classifier, status: finalStatus }, 'linkedin:invite complete');
    return {
        account_id: accountId, type: 'invite', sent: result.sent, classifier: result.classifier,
        http_status: result.httpStatus, account_status: finalStatus,
    };
};
