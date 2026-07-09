/**
 * Shared plumbing for the Faz-2 write handlers (linkedin:invite / linkedin:message).
 *
 * Both handlers follow the SAME safety spine and only differ in the actual send:
 *   1. load the account (service-role, tenant-scoped)
 *   2. DRY-RUN default → preview the plan with NO decrypt / NO network / NO consume
 *   3. guard status === 'ACTIVE' (a hard state is a skip, never a throw → no retry burn)
 *   4. atomically RESERVE a daily-quota slot (093 fence) — over-cap is a skip
 *   5. send through the sticky proxy, classify (§4.4, never status-alone)
 *   6. REFUND the slot if the write definitively did not land (isNotSent)
 *   7. apply the health transition (403→RESTRICTED, 999→CHALLENGED, 401→NEEDS_REAUTH),
 *      never lifting an operator PAUSE
 *   8. write exactly one linkedin_actions audit row
 */
import { researchSupabaseAdmin } from '../research/supabase.js';
import { createLogger } from '../logger.js';
import { decryptCookie } from './crypto.js';
import { proxyAgentFor } from './proxy.js';
import { effectiveDailyCap, WEEKLY_CAP, type ActionType } from './limits.js';
import { nextSendAt, normalizeWorkingHours } from './schedule.js';
import { enqueueJob } from '../research/queue.js';
import type { VoyagerCreds } from './voyager.js';
import type { WriteClassifier } from './client.js';

const log = createLogger('linkedin:actions');

/** A send more than this far in the future is re-deferred at execution time rather than sent
 *  now — a small drift from the enqueue-time schedule is tolerated, a late worker firing hours
 *  off-window is not (codex P2). */
const EXECUTION_DEFER_THRESHOLD_MS = 5 * 60_000;

// linkedin_actions.type ('invite'|'message') → daily_counters key ('invites'|'messages').
export const COUNTER_KEY = { invite: 'invites', message: 'messages' } as const;

export interface LinkedInAccountRow {
    id: string;
    status: string;
    proxy_session_id: string | null;
    user_agent: string | null;
    accept_language: string | null;
    li_at_enc: string | null;
    jsessionid_enc: string | null;
    member_urn: string | null;
    daily_counters: Record<string, unknown> | null;
    warmup_started_at: string | null;
    working_hours: Record<string, unknown> | null;
    timezone: string | null;
    created_at: string;
}

const ACCOUNT_COLUMNS =
    'id, status, proxy_session_id, user_agent, accept_language, li_at_enc, jsessionid_enc, ' +
    'member_urn, daily_counters, warmup_started_at, working_hours, timezone, created_at';

/** The warmup-derived DAILY cap for this account+action (limits.ts §1 ramp). */
export function dailyCapFor(account: LinkedInAccountRow, type: ActionType, now: number = Date.now()): number {
    return effectiveDailyCap(type, account.warmup_started_at, account.created_at, now);
}

/** The rolling 7-day ceiling for an action (§1). */
export function weeklyCapFor(type: ActionType): number {
    return WEEKLY_CAP[type];
}

export async function loadAccount(tenantId: string, accountId: string): Promise<LinkedInAccountRow | null> {
    const { data, error } = await researchSupabaseAdmin
        .from('linkedin_accounts')
        .select(ACCOUNT_COLUMNS)
        .eq('id', accountId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (error) throw error;
    return (data as LinkedInAccountRow | null) ?? null;
}

/** Decrypt the stored session into the creds the client seam needs. Throws (transport-
 *  class failure) on a missing/bad key or absent cookies — the caller fails the job. */
export function credsFor(account: LinkedInAccountRow): VoyagerCreds {
    if (!account.li_at_enc || !account.jsessionid_enc) throw new Error('account has no stored session cookies');
    return {
        liAt: decryptCookie(account.li_at_enc),
        jsessionid: decryptCookie(account.jsessionid_enc),
        userAgent: account.user_agent ?? '',
        acceptLanguage: account.accept_language,
    };
}

export function dispatcherFor(account: LinkedInAccountRow) {
    if (!account.proxy_session_id) throw new Error('account has no proxy_session_id');
    return proxyAgentFor(account.proxy_session_id);
}

/** Current same-day count for a counter key (0 after a rollover we haven't written yet). */
export function currentCount(account: LinkedInAccountRow, counterKey: string): number {
    const c = account.daily_counters ?? {};
    const today = new Date().toISOString().slice(0, 10); // UTC yyyy-mm-dd (matches 093)
    if (c.date !== today) return 0;
    const n = Number(c[counterKey]);
    return Number.isFinite(n) ? n : 0;
}

export interface ConsumeResult {
    granted: boolean;
    reason?: 'ok' | 'not_active' | 'cap' | 'weekly_cap';
    current?: number;
    cap?: number;
    weekly?: number;
    weekly_cap?: number;
    status?: string;
}

/**
 * Atomically reserve a daily slot (095 RPC): ACTIVE-gated + daily cap + rolling-weekly cap,
 * all under one row lock. `actionType` is 'invite'|'message' (the audit type; the RPC derives
 * the daily_counters key). `weeklyCap` null skips the weekly ceiling.
 *
 * KNOWN BOUND (codex P2, accepted): the DAILY cap is a true reserve-before-send (counter bumped
 * under the lock), but the WEEKLY ceiling counts landed `status='ok'` audit rows written AFTER
 * the send — so N same-account sends already in flight are invisible to each other's weekly
 * check and can overshoot the weekly cap by up to the worker concurrency width. This weakens
 * (does not remove) a conservative anti-ban backstop, never bills, and today's usage is single
 * manual sends (no concurrent per-account batch). The Faz-4 sequence engine — which is what
 * enqueues per-account batches — is where a per-account reservation/serialization closes it.
 */
export async function consumeQuota(
    tenantId: string, accountId: string, actionType: ActionType, dailyCap: number, weeklyCap: number | null,
): Promise<ConsumeResult> {
    const { data, error } = await researchSupabaseAdmin.rpc('linkedin_try_consume_quota', {
        p_tenant: tenantId, p_account: accountId, p_action_type: actionType,
        p_cap: dailyCap, p_weekly_cap: weeklyCap,
    });
    if (error) throw error;
    return data as ConsumeResult;
}

export async function releaseQuota(tenantId: string, accountId: string, counterKey: string): Promise<void> {
    const { error } = await researchSupabaseAdmin.rpc('linkedin_release_quota', {
        p_tenant: tenantId, p_account: accountId, p_type: counterKey,
    });
    if (error) log.warn({ err: error, accountId, counterKey }, 'linkedin quota release failed (non-fatal)');
}

/** Rolling 7-day count of LANDED sends of this action (mirrors the 095 RPC's weekly count) —
 *  used only for the dry-run preview's would_send accuracy (the RPC is the real enforcer). */
export async function weeklyCount(tenantId: string, accountId: string, actionType: ActionType): Promise<number> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { count, error } = await researchSupabaseAdmin
        .from('linkedin_actions')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('account_id', accountId)
        .eq('type', actionType).eq('status', 'ok')
        .gt('created_at', sevenDaysAgo);
    if (error) { log.warn({ err: error, accountId }, 'weeklyCount read failed (non-fatal)'); return 0; }
    return count ?? 0;
}

/** The account's most recent action timestamp (for scheduler min-gap spacing); null = none. */
export async function lastActionAt(tenantId: string, accountId: string): Promise<string | null> {
    const { data, error } = await researchSupabaseAdmin
        .from('linkedin_actions')
        .select('created_at')
        .eq('tenant_id', tenantId).eq('account_id', accountId)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) { log.warn({ err: error, accountId }, 'lastActionAt read failed (non-fatal)'); return null; }
    return (data as { created_at: string } | null)?.created_at ?? null;
}

export interface ScheduleResult {
    /** UTC ms the action should fire (queue scheduled_at). */
    atMs: number;
    /** ISO form. */
    atIso: string;
    /** True when `atMs` is essentially now (no deferral into a future window). */
    immediate: boolean;
}

/**
 * Compute the humane scheduled_at for the account's next action (§2 working-hours + jitter).
 * Used by the route (real send → queue scheduled_at), the execution-time recheck (maybeDeferSend),
 * and the handlers' dry-run preview. `jitter:false` returns the deterministic earliest slot for a
 * clean preview.
 *
 * KNOWN BOUND (codex P2, accepted): the min-gap floor is derived from lastActionAt (the newest
 * LANDED audit row), so a batch of jobs enqueued together — before any has run — all read the
 * same stale `last` and get only independent jitter, not a pairwise min-gap. Sequential/manual
 * sends (today's usage) space correctly; a true per-account batch pacer is Faz-4 sequence-engine
 * work. The execution-time maybeDeferSend recheck already keeps every send inside the window.
 */
export async function scheduleSendAt(
    account: LinkedInAccountRow, tenantId: string,
    opts?: { now?: number; jitter?: boolean },
): Promise<ScheduleResult> {
    const now = opts?.now ?? Date.now();
    const last = await lastActionAt(tenantId, account.id);
    const atMs = nextSendAt({
        timezone: account.timezone,
        workingHours: normalizeWorkingHours(account.working_hours),
        lastActionAt: last,
        now,
        jitterMs: opts?.jitter === false ? 0 : undefined,
        jitterFraction: opts?.jitter === false ? 0 : undefined,
    });
    return { atMs, atIso: new Date(atMs).toISOString(), immediate: atMs - now < 60_000 };
}

export interface DeferResult {
    deferred: boolean;
    /** When deferred: the ISO time the fresh job was rescheduled to, and its id. */
    rescheduledTo?: string;
    rescheduledJobId?: string;
}

/**
 * Execution-time working-hours + min-gap RECHECK (§2). The route stamps scheduled_at at
 * enqueue, but if the worker is backed up / was down, a past-due job could otherwise fire at
 * 03:00 or seconds after a sibling. Before a real send, recompute the humane slot: if it's
 * more than a small threshold in the future, re-enqueue a FRESH job at that slot (maxAttempts=1)
 * and report deferred so the caller returns WITHOUT sending or reserving quota. `send_now`
 * bypasses this (smoke/urgent). Converges: each defer targets a concrete in-window future
 * instant, so when the worker runs it on time the recheck passes.
 */
export async function maybeDeferSend(
    account: LinkedInAccountRow, tenantId: string, jobType: string, payload: Record<string, unknown>,
    opts: { sendNow: boolean; createdBy?: string | null; now?: number },
): Promise<DeferResult> {
    if (opts.sendNow) return { deferred: false };
    const now = opts.now ?? Date.now();
    const sched = await scheduleSendAt(account, tenantId, { now });
    if (sched.atMs - now <= EXECUTION_DEFER_THRESHOLD_MS) return { deferred: false };
    const fresh = await enqueueJob({
        tenantId, type: jobType,
        payload: { ...payload, account_id: account.id, dry_run: false, send_now: false },
        maxAttempts: 1,
        scheduledAt: new Date(sched.atMs),
        createdBy: opts.createdBy ?? null,
    });
    log.info({ accountId: account.id, jobType, rescheduledTo: sched.atIso, jobId: fresh.id },
        'linkedin send re-deferred to next working-hours slot');
    return { deferred: true, rescheduledTo: sched.atIso, rescheduledJobId: fresh.id };
}

/** A reachable-but-unhealthy classifier that implies an account-status change (null = keep). */
export function statusForWrite(classifier: WriteClassifier): string | null {
    switch (classifier) {
        case 'restricted': return 'RESTRICTED';
        case 'challenge': return 'CHALLENGED';
        case 'session_invalid': return 'NEEDS_REAUTH';
        default: return null; // sent / already_connected / cant_resend_yet / rate_limited / unknown
    }
}

/** Hard health states that must AUTO-PAUSE the account's queue (§6 checkpoint auto-pause). */
const HARD_STATES = new Set(['RESTRICTED', 'CHALLENGED', 'NEEDS_REAUTH']);

/**
 * Auto-pause (§6): cancel this account's still-QUEUED linkedin:* jobs when it enters a hard
 * health state, so a restricted/challenged/dead-session account stops attempting sends
 * immediately instead of draining its backlog into skip-audits. Only 'queued' rows are
 * touched (an in-flight job self-guards on its own ACTIVE re-check), and the eq('status',
 * 'queued') is part of the UPDATE, so a job claimed concurrently is never clobbered. Best-
 * effort: a failure here is logged, not thrown (health was already applied).
 */
export async function cancelPendingAccountJobs(tenantId: string, accountId: string, reason: string): Promise<number> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_jobs')
        .update({
            status: 'canceled',
            finished_at: new Date().toISOString(),
            error: `auto-paused: ${reason}`.slice(0, 2000),
        })
        .eq('tenant_id', tenantId)
        .eq('status', 'queued')
        .like('type', 'linkedin:%')
        .filter('payload->>account_id', 'eq', accountId)
        .select('id');
    if (error) { log.warn({ err: error, accountId, reason }, 'auto-pause queue cancel failed (non-fatal)'); return 0; }
    const n = data?.length ?? 0;
    if (n > 0) log.warn({ accountId, reason, canceled: n }, 'auto-paused account: canceled pending jobs');
    return n;
}

/** Map a raw HTTP status (e.g. from a profile-resolution GET) to a health classifier. */
export function classifierForHttp(httpStatus: number): WriteClassifier | null {
    if (httpStatus === 401) return 'session_invalid';
    if (httpStatus === 403) return 'restricted';
    if (httpStatus === 999) return 'challenge';
    return null;
}

/**
 * Health classifier for a PROFILE-RESOLUTION GET (not a write). The identity API returns
 * 403 for a member it simply can't resolve (deleted / renamed vanity / typo'd public id —
 * verified live), so — unlike a write 403 — a resolve 403 must NOT restrict the account:
 * one stale lead would otherwise halt every campaign on it. Only 401 (dead session) and
 * 999 (challenge) are unambiguous account signals on a lookup; everything else is a plain
 * miss → the caller skips as urn_unresolved (the periodic /me validate stays authoritative).
 */
export function classifierForResolve(httpStatus: number): WriteClassifier | null {
    if (httpStatus === 401) return 'session_invalid';
    if (httpStatus === 999) return 'challenge';
    return null;
}

/**
 * Apply a health transition from a write outcome. Never lifts an operator PAUSE — the guard
 * is BOTH the in-memory snapshot AND a DB-level `status <> 'PAUSED'` on the update, so a
 * PAUSE that landed concurrently (after this handler loaded the row) is not clobbered (codex P1).
 *
 * KNOWN RESIDUAL (codex P3, accepted): the guard is PAUSE-only, so a late 401 from a send that
 * began with now-superseded cookies can still flip a freshly RE-AUTHED ACTIVE account to
 * NEEDS_REAUTH (and auto-cancel its recovery validate). This needs a per-session epoch/version
 * to detect "these creds are stale" — deferred to Faz 4/5; the window is the narrow overlap of
 * an in-flight send with a concurrent re-auth, and the operator can simply re-connect again.
 */
export async function applyWriteHealth(
    tenantId: string, account: LinkedInAccountRow, classifier: WriteClassifier,
): Promise<string> {
    const next = statusForWrite(classifier);
    if (!next || account.status === 'PAUSED' || next === account.status) return account.status;
    const { data, error } = await researchSupabaseAdmin
        .from('linkedin_accounts').update({ status: next })
        .eq('id', account.id).eq('tenant_id', tenantId)
        .neq('status', 'PAUSED') // DB guard: a concurrent PAUSE wins over this health downgrade
        .select('status').maybeSingle();
    if (error) { log.warn({ err: error, accountId: account.id }, 'write health update failed (non-fatal)'); return account.status; }
    if (!data) return 'PAUSED'; // no row matched → it was PAUSED concurrently; report the PAUSE
    // §6 auto-pause: on entering a hard state, drain the account's queued jobs so it stops
    // attempting. The transition actually landed (data matched), so this fires once per downgrade.
    if (HARD_STATES.has(next)) await cancelPendingAccountJobs(tenantId, account.id, `health:${classifier}`);
    return next;
}

export interface AuditFields {
    tenantId: string;
    accountId: string;
    type: 'invite' | 'message' | 'withdraw' | 'poll';
    status: 'ok' | 'error' | 'skipped';
    classifier: string;
    httpStatus?: number | null;
    error?: string | null;
    jobId: string;
}

export async function auditAction(a: AuditFields): Promise<void> {
    const { error } = await researchSupabaseAdmin.from('linkedin_actions').insert({
        tenant_id: a.tenantId, account_id: a.accountId, type: a.type, status: a.status,
        classifier: a.classifier, http_status: a.httpStatus ?? null,
        error: a.error ? a.error.slice(0, 500) : null, job_id: a.jobId,
    });
    if (error) log.warn({ err: error, accountId: a.accountId, type: a.type }, 'action audit insert failed (non-fatal)');
}
