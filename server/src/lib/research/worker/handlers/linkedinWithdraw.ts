/**
 * linkedin:withdraw — retract STALE pending connection requests (§2 "davet hijyeni").
 *
 * Too many unanswered outgoing invites is itself a weekly-limit / restriction signal (§2), so
 * this periodically withdraws invitations older than `withdraw_after_days` (default 21, the §2
 * 7–30 band). Withdrawal does NOT consume send quota — it's cleanup, not a send.
 *
 * DRY-RUN is the DEFAULT (payload.dry_run !== false): it lists which invitations WOULD be
 * withdrawn with no decrypt/network mutation, so it runs safely before the endpoints are
 * live-verified. NOTE: the sent-invitations + withdraw voyager paths are a HOT-SURFACE that
 * this module has not yet proven against a live account (voyager.ts) — a real run must
 * re-verify the shape. maxAttempts=1 upstream (each withdrawal is a non-idempotent-ish write).
 *
 * Every network call that tunnels through the account's dispatcher (the LIST — including in
 * DRY-RUN, since a list still egresses through the proxy even though it mutates nothing — and
 * EACH individual withdraw POST) is wrapped in `withStaticLease` (109 extension, closes the same
 * gate<->network TOCTOU `performInvite`/`performMessage` already close for sends). One lease per
 * network call, not one held across the whole run — see `withStaticLease`'s doc comment for why.
 * A lease denial mid-run is a conservative SKIP, never a throw (this job is maxAttempts=1: a
 * throw here would burn the only attempt with no automatic retry, unlike invite/message where the
 * operator can just re-fire — see codex P2 in `acquireStaticLease`'s own doc comment for the
 * identical reasoning applied there).
 */
import type { JobHandler } from '../types.js';
import { createLogger } from '../../../logger.js';
import { listSentInvitations, withdrawInvitation, type SentInvitationsResult } from '../../../linkedin/client.js';
import {
    loadAccount, credsFor, resolveDispatcher, applyWriteHealth, classifierForHttp, auditAction,
} from '../../../linkedin/actions.js';
import { withStaticLease } from '../../../linkedin/executor.js';

const log = createLogger('research:handler:linkedin-withdraw');

const DAY_MS = 86_400_000;
const DEFAULT_AFTER_DAYS = 21;
const MIN_AFTER_DAYS = 7;   // §2 floor — withdrawing sooner churns invites
const MAX_AFTER_DAYS = 30;  // §2 ceiling
const DEFAULT_MAX = 10;     // per-run withdrawal cap (avoid a burst pattern)
const MAX_MAX = 50;

/** Classifiers that mean "stop hammering this account and transition its health". */
const STOP_CLASSIFIERS = new Set(['session_invalid', 'restricted', 'challenge', 'rate_limited']);

export const linkedinWithdrawHandler: JobHandler = async ({ job, heartbeat }) => {
    const tenantId = job.tenant_id;
    const p = (job.payload ?? {}) as Record<string, unknown>;
    const accountId = typeof p.account_id === 'string' ? p.account_id : null;
    if (!accountId) throw new Error('linkedin:withdraw requires payload.account_id');

    const afterDays = clamp(numOr(p.withdraw_after_days, DEFAULT_AFTER_DAYS), MIN_AFTER_DAYS, MAX_AFTER_DAYS);
    const maxWithdrawals = clamp(numOr(p.max_withdrawals, DEFAULT_MAX), 1, MAX_MAX);
    const dryRun = p.dry_run !== false; // SAFE DEFAULT

    await heartbeat({ stage: 'withdraw', account_id: accountId, dry_run: dryRun });

    const account = await loadAccount(tenantId, accountId);
    if (!account) throw new Error(`linkedin:withdraw: account ${accountId} not found for tenant ${tenantId}`);

    // Hard account states are a SKIP (not a throw): don't touch a paused/restricted account.
    if (account.status !== 'ACTIVE') {
        if (!dryRun) await auditAction({ tenantId, accountId, type: 'withdraw', status: 'skipped', classifier: `account_${account.status.toLowerCase()}`, jobId: job.id });
        return { account_id: accountId, type: 'withdraw', withdrawn: 0, skipped: `account_${account.status}` };
    }

    let creds, dispatcher;
    try {
        creds = credsFor(account);
    } catch (err) {
        if (!dryRun) await auditAction({ tenantId, accountId, type: 'withdraw', status: 'error', classifier: 'transport_error', error: errMsg(err), jobId: job.id });
        throw err;
    }
    // Fail-closed egress: a static_required account must withdraw through its OWN dedicated IP,
    // never the rotating gateway (codex P1.1) — else it presents a second IP to LinkedIn.
    const gate = await resolveDispatcher(tenantId, account, 'send');
    if (!gate.ok) {
        if (!dryRun) await auditAction({ tenantId, accountId, type: 'withdraw', status: 'skipped', classifier: gate.reason, jobId: job.id });
        return { account_id: accountId, type: 'withdraw', withdrawn: 0, skipped: gate.reason };
    }
    dispatcher = gate.dispatcher;

    // List outgoing pending invitations through the sticky proxy — lease-protected (109
    // extension) even in DRY-RUN, because the LIST call itself still egresses through the
    // static proxy; only the DOWNSTREAM audit/mutation is what dry-run skips.
    let listed: SentInvitationsResult;
    try {
        const leased = await withStaticLease(tenantId, accountId, job.id, gate, () => listSentInvitations(creds, dispatcher));
        if (!leased.ok) {
            // Lease contention/denial: conservative skip, not a throw (maxAttempts=1 — see file
            // header). Mirrors the `!gate.ok` skip immediately above.
            if (!dryRun) await auditAction({ tenantId, accountId, type: 'withdraw', status: 'skipped', classifier: leased.classifier, jobId: job.id });
            return { account_id: accountId, type: 'withdraw', withdrawn: 0, skipped: leased.classifier, dry_run: dryRun };
        }
        listed = leased.result;
    } catch (err) {
        if (!dryRun) await auditAction({ tenantId, accountId, type: 'withdraw', status: 'error', classifier: 'transport_error', error: errMsg(err), jobId: job.id });
        throw new Error(`linkedin:withdraw list transport error: ${errMsg(err)}`);
    }

    // A failed/untrustworthy list (non-2xx OR a 2xx login-wall stub, listed.ok=false) is NOT an
    // empty pending list (§4.4) — never read it as "nothing to withdraw". A recognized health
    // status (401/403/999) transitions the account; anything else is a plain skip. DRY-RUN stays
    // side-effect-free (no audit, no health mutation) to match invite/message (codex P3).
    if (!listed.ok) {
        const hc = classifierForHttp(listed.httpStatus); // non-null only for 401/403/999
        if (hc && !dryRun) {
            const st = await applyWriteHealth(tenantId, account, hc);
            await auditAction({ tenantId, accountId, type: 'withdraw', status: 'error', classifier: hc, httpStatus: listed.httpStatus, jobId: job.id });
            return { account_id: accountId, type: 'withdraw', withdrawn: 0, skipped: hc, account_status: st };
        }
        if (!dryRun) await auditAction({ tenantId, accountId, type: 'withdraw', status: 'skipped', classifier: 'list_unavailable', httpStatus: listed.httpStatus, jobId: job.id });
        return { account_id: accountId, type: 'withdraw', withdrawn: 0, skipped: hc ?? 'list_unavailable', http_status: listed.httpStatus, dry_run: dryRun };
    }

    // Stale = age known AND older than the threshold. Unknown-age invites are LEFT ALONE
    // (never withdraw something we can't date — avoids retracting a fresh invite blind).
    const now = Date.now();
    const stale = listed.invitations.filter(
        (inv) => inv.sentAtMs != null && now - inv.sentAtMs > afterDays * DAY_MS,
    );

    // ── DRY-RUN: report the plan, no mutation ─────────────────────────────────────
    if (dryRun) {
        return {
            dry_run: true, account_id: accountId, type: 'withdraw',
            after_days: afterDays, max_withdrawals: maxWithdrawals,
            pending_total: listed.invitations.length,
            stale_candidates: stale.length,
            would_withdraw: Math.min(stale.length, maxWithdrawals),
            sample: stale.slice(0, 5).map((s) => ({ invitation_id: s.invitationId, sent_at_ms: s.sentAtMs })),
        };
    }

    // ── Real withdrawal: up to the per-run cap, stopping on a hard health signal ───
    let withdrawn = 0, failed = 0, consecutiveFails = 0, accountStatus = account.status, leaseSkipped = 0;
    for (const inv of stale.slice(0, maxWithdrawals)) {
        let result;
        try {
            // Fresh lease PER withdrawal (109 extension) — the same `gate` snapshot is reused
            // across the loop (its dispatcher/creds don't change), but the lease RPC re-verifies
            // fresh against the DB on every single call, so a reassignment/burn landing between
            // iterations is caught immediately rather than only at loop start.
            const leased = await withStaticLease(tenantId, accountId, job.id, gate, () => withdrawInvitation(creds, dispatcher, inv.invitationId));
            if (!leased.ok) {
                // Conservative: stop the loop rather than keep hammering an account whose egress
                // just failed its last-instant gate (mirrors the STOP_CLASSIFIERS break below).
                // Not a throw — maxAttempts=1 (see file header) — and not counted as `failed`
                // since the withdrawal was never attempted.
                leaseSkipped++;
                break;
            }
            result = leased.result;
        } catch (err) {
            // Transport failure mid-loop: audit and stop (the proxy/session is unhealthy).
            await auditAction({ tenantId, accountId, type: 'withdraw', status: 'error', classifier: 'transport_error', error: errMsg(err), jobId: job.id });
            failed++;
            break;
        }
        await auditAction({
            tenantId, accountId, type: 'withdraw', status: result.sent ? 'ok' : 'error',
            classifier: result.classifier, httpStatus: result.httpStatus, error: result.detail ?? null, jobId: job.id,
        });
        if (result.sent) { withdrawn++; consecutiveFails = 0; continue; }
        failed++; consecutiveFails++;
        if (STOP_CLASSIFIERS.has(result.classifier)) {
            accountStatus = await applyWriteHealth(tenantId, account, result.classifier);
            break; // restricted/challenged/rate-limited/dead — don't keep hitting the account
        }
        // A run of non-sent 'unknown'/'invalid_request' (e.g. a NON_JSON_2XX login wall that
        // classifies 'unknown', codex P3) is a SYSTEMIC failure, not a one-off already-gone
        // invite — stop hammering the account after 2 in a row rather than burning the whole cap.
        if (consecutiveFails >= 2) break;
    }

    log.info({ jobId: job.id, accountId, withdrawn, failed, leaseSkipped, stale: stale.length, status: accountStatus }, 'linkedin:withdraw complete');
    return {
        account_id: accountId, type: 'withdraw', withdrawn, failed,
        stale_candidates: stale.length, account_status: accountStatus,
        ...(leaseSkipped > 0 ? { lease_skipped: leaseSkipped } : {}),
    };
};

function numOr(v: unknown, dflt: number): number {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : dflt;
}
function clamp(n: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, Math.floor(n)));
}
function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
