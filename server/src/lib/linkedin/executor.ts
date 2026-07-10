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
 *   - for a `static_required` account, acquire an assignment-scoped send-lease (109) immediately
 *     before the real send — an atomic last-instant re-check that REPLACES trusting the earlier
 *     resolveDispatcher snapshot, closing the gate<->network TOCTOU window (codex §10 P1.4),
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
    auditAction, dailyCapFor, weeklyCapFor, COUNTER_KEY, acquireSendLease, releaseSendLease,
    type LinkedInAccountRow, type SendLease,
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
 * Immediately before the real network send, re-validate a `static_required` account's egress
 * via an atomic assignment-scoped lease (mig 109, codex §10 P1.4 follow-up) instead of trusting
 * resolveDispatcher's earlier snapshot — a burn/health-apply/replacement landing in the gap
 * between the gate check and the actual outbound HTTP call would otherwise tunnel a send
 * through an IP the caller only THOUGHT was still validated. A `legacy_rotating` account
 * (gate.staticProxyId === null) still ROUND-TRIPS the RPC (C5): only a fresh 'not_static_required'
 * refusal confirms it is genuinely legacy and may proceed unleased — a GRANTED lease there means it
 * flipped to static after resolveDispatcher (mode-transition TOCTOU) and is fail-closed skipped.
 * Denial — including a proxy/generation mismatch against the dispatcher resolveDispatcher already
 * built (the assignment moved in the tiny window between the two reads) — is fail-closed: the caller
 * SKIPs (never throws, never falls back to rotating), exactly like a resolveDispatcher gate miss.
 */
async function acquireStaticLease(
    tenantId: string, accountId: string, jobId: string,
    gate: { staticProxyId: string | null; staticGeneration: number | null },
): Promise<{ ok: true; token: string | null } | { ok: false; classifier: string }> {
    // C5 (codex P1.5): close the legacy→static mode-transition TOCTOU. We must NOT early-return on
    // gate.staticProxyId===null and send unleased — the account could have flipped legacy_rotating →
    // static_required between resolveDispatcher's read and here (a proxy import/claim landed), which
    // would tunnel a send through a rotating IP an admin already replaced with a dedicated one. So we
    // ALWAYS call the RPC, which re-derives proxy_mode FRESH, and interpret against the gate snapshot.
    // A transient DB/schema error while ACQUIRING the lease must degrade to the SAME fail-closed
    // skip as an explicit denial — never throw through to the caller (that would bypass the quota
    // refund + audit path below and burn the maxAttempts=1 attempt while leaking the reservation;
    // codex P2). The network send has not happened, so this stays closed either way.
    let lease: SendLease;
    try {
        lease = await acquireSendLease(tenantId, accountId, jobId);
    } catch {
        return { ok: false, classifier: 'lease_error' };
    }
    if (!lease.ok) {
        // The account is genuinely still legacy_rotating: the RPC re-read proxy_mode <> 'static_required'
        // and refused with 'not_static_required' (mig 109). With the gate ALSO saying legacy
        // (staticProxyId===null) the two agree → no lease is needed, proceed unleased. ANY other refusal
        // reason (or a not_static refusal while the gate thought static) is fail-closed skip.
        //
        // ACCEPTED BOUNDARY (post-C5 residual): this 'not_static_required' read is fresh AS OF the RPC
        // call, but `fn()` (the actual network send) doesn't start until a few ms later — a mode flip
        // (proxy import/claim landing) in that gap can still let THIS ONE call ride the rotating
        // dispatcher `withStaticLease` already captured, even though the account is now static_required.
        // We deliberately do not close this last sliver: the import/claim RPC path (mig 111) nulls the
        // account's validated proxy pointers on flip, so every SUBSEQUENT send is gated (this call was
        // already in flight, authorized under legacy mode when it was resolved, and the window is
        // milliseconds). Fully closing it would need a legacy-mode lease honored by
        // import/claim too — not built, since the risk window is this small and self-healing on the
        // very next call.
        if (gate.staticProxyId === null && lease.reason === 'not_static_required') {
            return { ok: true, token: null }; // legacy confirmed fresh — no lease needed
        }
        return { ok: false, classifier: `lease_${lease.reason}` };
    }
    // A lease was GRANTED. If the gate still thought this was a legacy account, the account flipped to
    // static_required AFTER resolveDispatcher — the dispatcher already built is the STALE rotating one.
    // Release the just-granted lease and fail-closed skip rather than send through the wrong egress.
    if (gate.staticProxyId === null) {
        await releaseSendLease(tenantId, accountId, lease.leaseToken);
        return { ok: false, classifier: 'lease_mode_transition' };
    }
    if (lease.proxyId !== gate.staticProxyId || lease.generation !== gate.staticGeneration) {
        // The assignment changed between resolveDispatcher's read and this one — the dispatcher
        // already built is for the STALE pointer. Release the just-granted (but now-useless)
        // lease and skip rather than send through a mismatched agent.
        await releaseSendLease(tenantId, accountId, lease.leaseToken);
        return { ok: false, classifier: 'lease_mismatch' };
    }
    return { ok: true, token: lease.leaseToken };
}

/** Gate shape `withStaticLease` needs — the `ok:true` branch of `DispatcherGate` satisfies this
 *  structurally, so callers can pass their already-narrowed `resolveDispatcher` result straight
 *  through. */
export interface StaticLeaseGate {
    staticProxyId: string | null;
    staticGeneration: number | null;
}

/**
 * Run ONE network call that tunnels through `gate`'s dispatcher inside a freshly acquired
 * assignment-scoped send-lease (109), released immediately after `fn` settles — on success OR
 * on throw (try/finally, so a caller can never forget to release). Built to extend the same
 * gate<->network TOCTOU close that `performInvite`/`performMessage` apply to their sends onto
 * OTHER proxy-tunneled paths (withdraw's list+withdraw calls, poll's connections/conversations
 * reads) that don't fit the single-send shape those two functions assume.
 *
 * Deliberately ONE lease per network call, not one lease held across a whole multi-call run: the
 * lease TTL is short (default 45s, hard-clamped to <=120s in the RPC) while a multi-call caller
 * (e.g. withdraw's up-to-10-withdrawal loop) can run for minutes given client.ts's own 30s
 * per-call TOTAL_DEADLINE_MS — a single lease acquired once up front could lapse mid-loop and
 * silently stop protecting the later calls. Re-acquiring immediately before every individual
 * network call keeps each one inside a freshly fresh-DB-verified, still-live lease window, at the
 * cost of one extra RPC round trip per call (cheap relative to the LinkedIn HTTP call itself).
 *
 * `legacy_rotating` accounts (`gate.staticProxyId === null`) need no lease at all and `fn` runs
 * unprotected, same as `acquireStaticLease` above. Lease denial (`lease_held` / `lease_error` /
 * `lease_mismatch` / any RPC-reported reason) never throws — the caller gets a tagged skip result
 * and decides its own conservative skip/reschedule semantics; the network call is simply never
 * attempted in that case.
 */
export async function withStaticLease<T>(
    tenantId: string, accountId: string, jobId: string, gate: StaticLeaseGate, fn: () => Promise<T>,
): Promise<{ ok: true; result: T } | { ok: false; classifier: string }> {
    const lease = await acquireStaticLease(tenantId, accountId, jobId, gate);
    if (!lease.ok) return { ok: false, classifier: lease.classifier };
    try {
        const result = await fn();
        return { ok: true, result };
    } finally {
        if (lease.token) await releaseSendLease(tenantId, accountId, lease.token);
    }
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

    // Last-instant atomic re-check, immediately before the real send (109 send-lease) — REPLACES
    // trusting the gate snapshot taken above for static_required accounts.
    const lease = await acquireStaticLease(tenantId, accountId, jobId, gate);
    if (!lease.ok) {
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'invite', status: 'skipped', classifier: lease.classifier, jobId });
        return { sent: false, classifier: lease.classifier, accountStatus: account.status, skipped: lease.classifier };
    }

    let result;
    try {
        result = await sendInvite(creds, dispatcher, targetUrn, note || undefined);
    } catch (err) {
        if (lease.token) await releaseSendLease(tenantId, accountId, lease.token);
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'invite', status: 'error', classifier: 'transport_error', error: errMsg(err), jobId });
        throw new Error(`linkedin invite transport error: ${errMsg(err)}`);
    }
    if (lease.token) await releaseSendLease(tenantId, accountId, lease.token);

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

    // Last-instant atomic re-check, immediately before the real send (109 send-lease) — REPLACES
    // trusting the gate snapshot taken above for static_required accounts.
    const lease = await acquireStaticLease(tenantId, accountId, jobId, gate);
    if (!lease.ok) {
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'message', status: 'skipped', classifier: lease.classifier, jobId });
        return { sent: false, classifier: lease.classifier, accountStatus: account.status, skipped: lease.classifier };
    }

    let result;
    try {
        result = await sendMessage(creds, dispatcher, { mailboxUrn: account.member_urn, recipientUrn: target.recipientUrn, text: target.text });
    } catch (err) {
        if (lease.token) await releaseSendLease(tenantId, accountId, lease.token);
        await releaseQuota(tenantId, accountId, COUNTER);
        await auditAction({ tenantId, accountId, type: 'message', status: 'error', classifier: 'transport_error', error: errMsg(err), jobId });
        throw new Error(`linkedin message transport error: ${errMsg(err)}`);
    }
    if (lease.token) await releaseSendLease(tenantId, accountId, lease.token);

    if (isNotSent(result.classifier)) await releaseQuota(tenantId, accountId, COUNTER);
    const finalStatus = await applyWriteHealth(tenantId, account, result.classifier);
    await auditAction({
        tenantId, accountId, type: 'message', status: result.sent ? 'ok' : 'error',
        classifier: result.classifier, httpStatus: result.httpStatus, error: result.detail ?? null, jobId,
    });
    log.info({ jobId, accountId, classifier: result.classifier, status: finalStatus }, 'linkedin message complete');
    return { sent: result.sent, classifier: result.classifier, httpStatus: result.httpStatus, accountStatus: finalStatus, targetUrn: target.recipientUrn };
}
