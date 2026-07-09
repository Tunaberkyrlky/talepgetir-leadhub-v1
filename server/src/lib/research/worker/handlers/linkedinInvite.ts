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
import { INVITE_NOTE_MAX } from '../../../linkedin/voyager.js';
import {
    loadAccount, currentCount, auditAction, dailyCapFor, weeklyCapFor,
    scheduleSendAt, weeklyCount, maybeDeferSend, COUNTER_KEY,
} from '../../../linkedin/actions.js';
import { performInvite } from '../../../linkedin/executor.js';

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

    // Reserve → resolve urn → send → refund-if-not-sent → health → audit (shared spine).
    const outcome = await performInvite(account, tenantId, { profileUrn, publicId, note }, job.id);
    return {
        account_id: accountId, type: 'invite', sent: outcome.sent, classifier: outcome.classifier,
        http_status: outcome.httpStatus, account_status: outcome.accountStatus,
        ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
    };
};
