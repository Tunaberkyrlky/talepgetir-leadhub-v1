/**
 * TG-LinkedIn — the shared REAL-SEND spine (Faz 4 extraction).
 *
 * Faz 2/3 put the invite/message send flow inline in each job handler; Faz 4's sequence
 * engine needs the exact same flow (reserve → send → classify → refund-if-not-sent → health →
 * audit) inline too. Extracting it here keeps that flow in ONE place — the caps, refund and
 * health-transition semantics can't drift between the manual single-send handlers and the
 * campaign engine.
 *
 * Both `performInvite` and `performMessage`:
 *   - reserve a daily+weekly slot (095 RPC; ACTIVE-gated under the row lock),
 *   - decrypt creds + get the sticky dispatcher (a failure here is transport-class → THROWS),
 *   - send through the seam, classify §4.4 (never HTTP status alone),
 *   - refund the slot if the write did not land (isNotSent),
 *   - apply the health transition (403→RESTRICTED / 999→CHALLENGED / 401→NEEDS_REAUTH; §6
 *     auto-pause cancels the queue on a hard state),
 *   - write exactly one linkedin_actions audit row,
 *   - return a normalized SendOutcome.
 *
 * They THROW only on transport-class failure (decrypt/proxy/network) so the caller decides
 * whether to fail-the-job (single-send handler) or mark-the-enrollment-retryable (engine).
 * Every non-transport non-send (cap/weekly/urn miss/restricted/…) is a returned SendOutcome
 * with sent=false and a `skipped`/classifier — never a throw.
 */
import { createLogger } from '../logger.js';
import { sendInvite, sendMessage, resolveProfileUrn, isNotSent } from './client.js';
import { INVITE_NOTE_MAX } from './voyager.js';
import {
    credsFor, resolveDispatcher, consumeQuota, releaseQuota, applyWriteHealth, classifierForResolve,
    auditAction, dailyCapFor, weeklyCapFor, COUNTER_KEY, type LinkedInAccountRow,
} from './actions.js';

const log = createLogger('linkedin:executor');

export interface SendOutcome {
    sent: boolean;
    classifier: string;
    httpStatus?: number | null;
    /** Account status after any health transition. */
    accountStatus: string;
    /** The resolved recipient urn (invite: after public-id resolution). */
    targetUrn?: string | null;
    /** Set when the action did not land for a non-transport reason (cap / urn miss / restrict…). */
    skipped?: string;
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Perform ONE connection request on an ACTIVE account. Caller must have already confirmed
 * account.status === 'ACTIVE' and handled dry-run/defer. Throws on transport failure.
 */
export async function performInvite(
    account: LinkedInAccountRow, tenantId: string,
    target: { profileUrn?: string | null; publicId?: string | null; note?: string },
    jobId: string,
): Promise<SendOutcome> {
    const accountId = account.id;
    const COUNTER = COUNTER_KEY.invite;
    const note = (target.note ?? '').trim().slice(0, INVITE_NOTE_MAX);
    const dailyCap = dailyCapFor(account, 'invite');
    const weeklyCap = weeklyCapFor('invite');

    const grant = await consumeQuota(tenantId, accountId, 'invite', dailyCap, weeklyCap);
    if (!grant.granted) {
        const classifier = grant.reason === 'not_active' ? `account_${(grant.status ?? 'unknown').toLowerCase()}`
            : grant.reason === 'weekly_cap' ? 'weekly_cap' : 'daily_cap';
        await auditAction({ tenantId, accountId, type: 'invite', status: 'skipped', classifier, jobId });
        return { sent: false, classifier, accountStatus: account.status, skipped: classifier };
    }

    let creds, dispatcher;
    try {
        creds = credsFor(account);
    } catch (err) {
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'invite', status: 'error', classifier: 'transport_error', error: errMsg(err), jobId });
        throw err;
    }
    // Fail-closed egress: a static_required account with no healthy, validated dedicated IP
    // must SKIP (never fall back to a rotating IP; codex §9-P1.10/P1.12).
    const gate = await resolveDispatcher(tenantId, account, 'send');
    if (!gate.ok) {
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'invite', status: 'skipped', classifier: gate.reason, jobId });
        return { sent: false, classifier: gate.reason, accountStatus: account.status, skipped: gate.reason };
    }
    dispatcher = gate.dispatcher;

    // Resolve the profile urn if only a public id was given (§4.3, best-effort GET).
    let targetUrn = target.profileUrn ?? null;
    if (!targetUrn && target.publicId) {
        let resolved;
        try {
            resolved = await resolveProfileUrn(creds, dispatcher, target.publicId);
        } catch (err) {
            await releaseQuota(tenantId, accountId, COUNTER);
            await auditAction({ tenantId, accountId, type: 'invite', status: 'error', classifier: 'transport_error', error: errMsg(err), jobId });
            throw err;
        }
        targetUrn = resolved.urn;
        if (!targetUrn) {
            await releaseQuota(tenantId, accountId, COUNTER);
            const healthClassifier = classifierForResolve(resolved.httpStatus);
            if (healthClassifier) {
                const st = await applyWriteHealth(tenantId, account, healthClassifier);
                await auditAction({ tenantId, accountId, type: 'invite', status: 'error', classifier: healthClassifier, httpStatus: resolved.httpStatus, jobId });
                return { sent: false, classifier: healthClassifier, httpStatus: resolved.httpStatus, accountStatus: st, skipped: healthClassifier };
            }
            await auditAction({ tenantId, accountId, type: 'invite', status: 'skipped', classifier: 'urn_unresolved', httpStatus: resolved.httpStatus, jobId });
            return { sent: false, classifier: 'urn_unresolved', httpStatus: resolved.httpStatus, accountStatus: account.status, skipped: 'urn_unresolved' };
        }
    }

    // No profile_urn and no resolvable public_id → nothing to invite. Refund + skip (not a throw).
    if (!targetUrn) {
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'invite', status: 'skipped', classifier: 'no_target', jobId });
        return { sent: false, classifier: 'no_target', accountStatus: account.status, skipped: 'no_target' };
    }

    let result;
    try {
        result = await sendInvite(creds, dispatcher, targetUrn, note || undefined);
    } catch (err) {
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'invite', status: 'error', classifier: 'transport_error', error: errMsg(err), jobId });
        throw new Error(`linkedin invite transport error: ${errMsg(err)}`);
    }

    if (isNotSent(result.classifier)) await releaseQuota(tenantId, accountId, COUNTER);
    const finalStatus = await applyWriteHealth(tenantId, account, result.classifier);
    await auditAction({
        tenantId, accountId, type: 'invite', status: result.sent ? 'ok' : 'error',
        classifier: result.classifier, httpStatus: result.httpStatus, error: result.detail ?? null, jobId,
    });
    log.info({ jobId, accountId, classifier: result.classifier, status: finalStatus }, 'linkedin invite complete');
    return { sent: result.sent, classifier: result.classifier, httpStatus: result.httpStatus, accountStatus: finalStatus, targetUrn };
}

/**
 * Perform ONE new-conversation message on an ACTIVE account with a resolved member_urn
 * (mailboxUrn). Caller confirms account.status === 'ACTIVE' + account.member_urn present.
 * Throws on transport failure.
 */
export async function performMessage(
    account: LinkedInAccountRow, tenantId: string,
    target: { recipientUrn: string; text: string },
    jobId: string,
): Promise<SendOutcome> {
    const accountId = account.id;
    const COUNTER = COUNTER_KEY.message;
    const dailyCap = dailyCapFor(account, 'message');
    const weeklyCap = weeklyCapFor('message');

    if (!account.member_urn) {
        await auditAction({ tenantId, accountId, type: 'message', status: 'skipped', classifier: 'no_identity', jobId });
        return { sent: false, classifier: 'no_identity', accountStatus: account.status, skipped: 'no_identity' };
    }

    const grant = await consumeQuota(tenantId, accountId, 'message', dailyCap, weeklyCap);
    if (!grant.granted) {
        const classifier = grant.reason === 'not_active' ? `account_${(grant.status ?? 'unknown').toLowerCase()}`
            : grant.reason === 'weekly_cap' ? 'weekly_cap' : 'daily_cap';
        await auditAction({ tenantId, accountId, type: 'message', status: 'skipped', classifier, jobId });
        return { sent: false, classifier, accountStatus: account.status, skipped: classifier };
    }

    let creds, dispatcher;
    try {
        creds = credsFor(account);
    } catch (err) {
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'message', status: 'error', classifier: 'transport_error', error: errMsg(err), jobId });
        throw err;
    }
    const gate = await resolveDispatcher(tenantId, account, 'send');
    if (!gate.ok) {
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'message', status: 'skipped', classifier: gate.reason, jobId });
        return { sent: false, classifier: gate.reason, accountStatus: account.status, skipped: gate.reason };
    }
    dispatcher = gate.dispatcher;

    let result;
    try {
        result = await sendMessage(creds, dispatcher, { mailboxUrn: account.member_urn, recipientUrn: target.recipientUrn, text: target.text });
    } catch (err) {
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'message', status: 'error', classifier: 'transport_error', error: errMsg(err), jobId });
        throw new Error(`linkedin message transport error: ${errMsg(err)}`);
    }

    if (isNotSent(result.classifier)) await releaseQuota(tenantId, accountId, COUNTER);
    const finalStatus = await applyWriteHealth(tenantId, account, result.classifier);
    await auditAction({
        tenantId, accountId, type: 'message', status: result.sent ? 'ok' : 'error',
        classifier: result.classifier, httpStatus: result.httpStatus, error: result.detail ?? null, jobId,
    });
    log.info({ jobId, accountId, classifier: result.classifier, status: finalStatus }, 'linkedin message complete');
    return { sent: result.sent, classifier: result.classifier, httpStatus: result.httpStatus, accountStatus: finalStatus, targetUrn: target.recipientUrn };
}
