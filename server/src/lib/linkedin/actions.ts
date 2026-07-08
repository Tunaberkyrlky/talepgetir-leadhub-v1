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
import type { VoyagerCreds } from './voyager.js';
import type { WriteClassifier } from './client.js';

const log = createLogger('linkedin:actions');

// Faz-2 SAFETY ceilings (§1 plato max) — a hard backstop, not the warmup ramp (Faz 3).
export const DAILY_CAPS = { invite: 40, message: 60 } as const;

// linkedin_actions.type ('invite'|'message') → daily_counters key ('invites'|'messages').
export const COUNTER_KEY = { invite: 'invites', message: 'messages' } as const;

export interface LinkedInAccountRow {
    id: string;
    status: string;
    proxy_session_id: string | null;
    user_agent: string | null;
    li_at_enc: string | null;
    jsessionid_enc: string | null;
    member_urn: string | null;
    daily_counters: Record<string, unknown> | null;
}

const ACCOUNT_COLUMNS =
    'id, status, proxy_session_id, user_agent, li_at_enc, jsessionid_enc, member_urn, daily_counters';

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
    reason?: 'ok' | 'not_active' | 'cap';
    current?: number;
    cap?: number;
    status?: string;
}

export async function consumeQuota(
    tenantId: string, accountId: string, counterKey: string, cap: number,
): Promise<ConsumeResult> {
    const { data, error } = await researchSupabaseAdmin.rpc('linkedin_try_consume_quota', {
        p_tenant: tenantId, p_account: accountId, p_type: counterKey, p_cap: cap,
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

/** A reachable-but-unhealthy classifier that implies an account-status change (null = keep). */
export function statusForWrite(classifier: WriteClassifier): string | null {
    switch (classifier) {
        case 'restricted': return 'RESTRICTED';
        case 'challenge': return 'CHALLENGED';
        case 'session_invalid': return 'NEEDS_REAUTH';
        default: return null; // sent / already_connected / cant_resend_yet / rate_limited / unknown
    }
}

/** Map a raw HTTP status (e.g. from a profile-resolution GET) to a health classifier. */
export function classifierForHttp(httpStatus: number): WriteClassifier | null {
    if (httpStatus === 401) return 'session_invalid';
    if (httpStatus === 403) return 'restricted';
    if (httpStatus === 999) return 'challenge';
    return null;
}

/**
 * Apply a health transition from a write outcome. Never lifts an operator PAUSE — the guard
 * is BOTH the in-memory snapshot AND a DB-level `status <> 'PAUSED'` on the update, so a
 * PAUSE that landed concurrently (after this handler loaded the row) is not clobbered (codex P1).
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
    return next;
}

export interface AuditFields {
    tenantId: string;
    accountId: string;
    type: 'invite' | 'message';
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
