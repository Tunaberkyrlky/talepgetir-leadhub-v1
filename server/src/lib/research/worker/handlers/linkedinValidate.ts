/**
 * linkedin:validate — real session liveness + identity + health (§4/§6).
 *
 * FAZ 1: hits /voyager/api/me through the account's STICKY proxy with its captured
 * user-agent, classifies the result (§4.4), promotes account.status, and fills the
 * member identity. A transport failure (proxy/timeout/decrypt) throws (job fails);
 * a reachable-but-unhealthy session (401/403/999) is a SUCCESSFUL check that records
 * the classification and does NOT throw.
 *
 * member_urn collision (migration 083 uq_linkedin_accounts_tenant_urn / critique P1-3):
 * a fast pre-check catches the common case, but the DB unique index is the real ARBITER
 * — the status+identity UPDATE catches 23505 (a concurrent validate claimed the same
 * identity first) and folds THIS row into the duplicate path, so the collision handling
 * survives the concurrency it targets instead of hard-failing the job.
 */
import type { JobHandler } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { createLogger } from '../../../logger.js';
import { decryptCookie } from '../../../linkedin/crypto.js';
import { validateSession, type ValidateClassifier } from '../../../linkedin/client.js';
import { cancelPendingAccountJobs, resolveDispatcher } from '../../../linkedin/actions.js';

const log = createLogger('research:handler:linkedin-validate');

/** Hard health states that auto-pause the account's queue (§6) — mirror actions.HARD_STATES. */
const HARD_STATES = new Set(['RESTRICTED', 'CHALLENGED', 'NEEDS_REAUTH']);

/** Map a validate classifier to the account status it implies (null = leave unchanged). */
function statusFor(classifier: ValidateClassifier): string | null {
    switch (classifier) {
        case 'success': return 'ACTIVE';
        case 'session_invalid': return 'NEEDS_REAUTH';
        case 'challenge': return 'CHALLENGED';
        case 'restricted': return 'RESTRICTED';
        case 'rate_limited': return null; // transient — keep current status
        default: return null;
    }
}

interface AccountRow {
    id: string;
    status: string;
    proxy_session_id: string | null;
    user_agent: string | null;
    accept_language: string | null;
    warmup_started_at: string | null;
    li_at_enc: string | null;
    jsessionid_enc: string | null;
    geo: string | null;
    proxy_mode: string;
    last_validated_proxy_generation: number | null;
}

/** Mark this row a duplicate identity (RESTRICTED, no member_urn) + audit. Shared by the
 *  pre-check and the 23505 race path so both write exactly one audit row. The status
 *  downgrade is PAUSE-guarded (codex P2): a duplicate must never clobber an operator PAUSE;
 *  if the row is PAUSED the queue-cancel is skipped (the operator already stopped it). */
async function markDuplicate(tenantId: string, accountId: string, httpStatus: number, jobId: string, now: string) {
    const { data: row } = await researchSupabaseAdmin.from('linkedin_accounts')
        .update({ status: 'RESTRICTED', last_validated_at: now })
        .eq('id', accountId).eq('tenant_id', tenantId)
        .neq('status', 'PAUSED')
        .select('id').maybeSingle();
    const { error: auditErr } = await researchSupabaseAdmin.from('linkedin_actions').insert({
        tenant_id: tenantId, account_id: accountId, type: 'validate', status: 'ok',
        classifier: 'duplicate_identity', http_status: httpStatus, job_id: jobId,
    });
    if (auditErr) log.warn({ err: auditErr, accountId }, 'validate duplicate audit insert failed (non-fatal)');
    // Only auto-pause the queue if we actually applied RESTRICTED (row matched, i.e. not PAUSED).
    if (row) await cancelPendingAccountJobs(tenantId, accountId, 'duplicate_identity');
}

export const linkedinValidateHandler: JobHandler = async ({ job, heartbeat }) => {
    const tenantId = job.tenant_id;
    const accountId = typeof job.payload?.account_id === 'string' ? job.payload.account_id : null;
    if (!accountId) throw new Error('linkedin:validate requires payload.account_id');

    await heartbeat({ stage: 'validating', account_id: accountId });

    const { data, error: loadErr } = await researchSupabaseAdmin
        .from('linkedin_accounts')
        .select('id, status, proxy_session_id, user_agent, accept_language, warmup_started_at, li_at_enc, jsessionid_enc, geo, proxy_mode, last_validated_proxy_generation')
        .eq('id', accountId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (loadErr) throw loadErr;
    if (!data) throw new Error(`linkedin:validate: account ${accountId} not found for tenant ${tenantId}`);
    const account = data as AccountRow;

    const now = new Date().toISOString();

    // ── Probe /voyager/api/me through the account's proxy ─────────────────────────
    // For a static_required account this is its dedicated IP; validate is what proves that
    // IP alive, so on success we stamp last_validated_proxy_generation (the send-time gate).
    let result: Awaited<ReturnType<typeof validateSession>> | null = null;
    let transportError: string | null = null;
    let staticGeneration: number | null = null;
    try {
        if (!account.li_at_enc || !account.jsessionid_enc) throw new Error('account has no stored session cookies');
        const gate = await resolveDispatcher(tenantId, account, 'validate');
        if (!gate.ok) throw new Error(`proxy gate: ${gate.reason}`);
        staticGeneration = gate.staticGeneration;
        const creds = {
            liAt: decryptCookie(account.li_at_enc),
            jsessionid: decryptCookie(account.jsessionid_enc),
            userAgent: account.user_agent ?? '',
            acceptLanguage: account.accept_language,
        };
        result = await validateSession(creds, gate.dispatcher);
    } catch (err) {
        transportError = err instanceof Error ? err.message : String(err);
    }

    // Transport failure: couldn't reach LinkedIn (proxy/timeout/decrypt). Record + fail.
    if (!result) {
        const { error: auditErr } = await researchSupabaseAdmin.from('linkedin_actions').insert({
            tenant_id: tenantId, account_id: accountId, type: 'validate', status: 'error',
            classifier: 'transport_error', error: (transportError ?? 'unknown').slice(0, 500), job_id: job.id,
        });
        if (auditErr) log.warn({ err: auditErr, accountId }, 'validate transport audit insert failed (non-fatal)');
        throw new Error(`linkedin:validate transport error: ${transportError}`);
    }

    // ── member_urn collision fast pre-check → mark THIS row a duplicate ────────────
    if (result.ok && result.identity?.memberUrn) {
        const { data: dup, error: dupErr } = await researchSupabaseAdmin
            .from('linkedin_accounts')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('member_urn', result.identity.memberUrn)
            .neq('id', accountId)
            .maybeSingle();
        if (dupErr) throw dupErr; // a failed dedup read must NOT be read as "no duplicate"
        if (dup) {
            await markDuplicate(tenantId, accountId, result.httpStatus, job.id, now);
            log.warn({ jobId: job.id, accountId, memberUrn: result.identity.memberUrn }, 'linkedin:validate duplicate identity in workspace');
            return { account_id: accountId, status: 'RESTRICTED', classifier: 'duplicate_identity' };
        }
    }

    // ── Apply status + identity ───────────────────────────────────────────────────
    const nextStatus = statusFor(result.classifier);
    const patch: Record<string, unknown> = { last_validated_at: now };
    // A health probe only DOWNGRADES health — it must never lift an operator PAUSE.
    if (nextStatus && account.status !== 'PAUSED') patch.status = nextStatus;
    if (result.ok && result.identity) {
        if (result.identity.memberUrn) patch.member_urn = result.identity.memberUrn;
        if (result.identity.publicId) patch.public_id = result.identity.publicId;
        if (result.identity.name) patch.name = result.identity.name;
    }
    // Start the warmup clock the FIRST time an account validates alive (§1 ramp origin). Only
    // set it once; it's persisted so a re-validate can never reset the ramp progress.
    if (result.classifier === 'success' && !account.warmup_started_at) patch.warmup_started_at = now;
    // Static IP proven alive → record the generation the send-time gate compares against.
    if (result.classifier === 'success' && account.proxy_mode === 'static_required' && staticGeneration !== null) {
        patch.last_validated_proxy_generation = staticGeneration;
    }

    // DB-level PAUSE guard (codex P1): the in-memory `account.status !== 'PAUSED'` check above
    // was loaded BEFORE the multi-second proxied probe, so an operator PAUSE that landed during
    // the probe could be lifted back to ACTIVE by this write. When we're setting status, the
    // .neq('status','PAUSED') makes the DB the arbiter — a concurrent PAUSE wins. (When patch has
    // no status field — rate_limited/unknown — the guard is unnecessary; last_validated_at +
    // identity are benign to write onto any status.)
    let q = researchSupabaseAdmin
        .from('linkedin_accounts').update(patch).eq('id', accountId).eq('tenant_id', tenantId);
    if (patch.status) q = q.neq('status', 'PAUSED');
    const { data: updRow, error: updErr } = await q.select('id').maybeSingle();

    if (updErr) {
        // Unique-index race: a concurrent validate claimed this member_urn between our
        // pre-check and this write. The DB constraint is the arbiter — fold to duplicate
        // instead of hard-failing the job with a raw Postgres error (P1).
        if ((updErr as { code?: string }).code === '23505') {
            await markDuplicate(tenantId, accountId, result.httpStatus, job.id, now);
            log.warn({ jobId: job.id, accountId }, 'linkedin:validate lost member_urn race — folded to RESTRICTED');
            return { account_id: accountId, status: 'RESTRICTED', classifier: 'duplicate_identity' };
        }
        throw updErr;
    }
    // No row matched a status-setting update → a PAUSE landed concurrently and won. Record the
    // probe classifier but do NOT auto-pause (the operator already stopped it) or claim ACTIVE.
    if (patch.status && !updRow) {
        const { error: auditErr } = await researchSupabaseAdmin.from('linkedin_actions').insert({
            tenant_id: tenantId, account_id: accountId, type: 'validate', status: 'ok',
            classifier: result.classifier, http_status: result.httpStatus, job_id: job.id,
        });
        if (auditErr) log.warn({ err: auditErr, accountId }, 'validate (paused) audit insert failed (non-fatal)');
        log.info({ jobId: job.id, accountId, classifier: result.classifier }, 'linkedin:validate: PAUSE won concurrently — status unchanged');
        return { account_id: accountId, status: 'PAUSED', classifier: result.classifier };
    }

    const { error: auditErr } = await researchSupabaseAdmin.from('linkedin_actions').insert({
        tenant_id: tenantId, account_id: accountId, type: 'validate', status: 'ok',
        classifier: result.classifier, http_status: result.httpStatus, job_id: job.id,
    });
    if (auditErr) log.warn({ err: auditErr, accountId }, 'validate audit insert failed (non-fatal)');

    const finalStatus = (patch.status as string | undefined) ?? account.status;
    // §6 auto-pause: a probe that lands the account in a hard state cancels its queued jobs so
    // it stops attempting sends until re-auth/verify. (patch.status only set when not PAUSED.)
    if (patch.status && HARD_STATES.has(patch.status as string)) {
        await cancelPendingAccountJobs(tenantId, accountId, `validate:${result.classifier}`);
    }
    log.info({ jobId: job.id, accountId, classifier: result.classifier, status: finalStatus }, 'linkedin:validate complete');
    return { account_id: accountId, status: finalStatus, classifier: result.classifier };
};
