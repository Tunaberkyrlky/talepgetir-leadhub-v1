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
import { proxyAgentFor } from '../../../linkedin/proxy.js';
import { validateSession, type ValidateClassifier } from '../../../linkedin/client.js';

const log = createLogger('research:handler:linkedin-validate');

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
    li_at_enc: string | null;
    jsessionid_enc: string | null;
}

/** Mark this row a duplicate identity (RESTRICTED, no member_urn) + audit. Shared by the
 *  pre-check and the 23505 race path so both write exactly one audit row. */
async function markDuplicate(tenantId: string, accountId: string, httpStatus: number, jobId: string, now: string) {
    await researchSupabaseAdmin.from('linkedin_accounts')
        .update({ status: 'RESTRICTED', last_validated_at: now })
        .eq('id', accountId).eq('tenant_id', tenantId);
    const { error: auditErr } = await researchSupabaseAdmin.from('linkedin_actions').insert({
        tenant_id: tenantId, account_id: accountId, type: 'validate', status: 'ok',
        classifier: 'duplicate_identity', http_status: httpStatus, job_id: jobId,
    });
    if (auditErr) log.warn({ err: auditErr, accountId }, 'validate duplicate audit insert failed (non-fatal)');
}

export const linkedinValidateHandler: JobHandler = async ({ job, heartbeat }) => {
    const tenantId = job.tenant_id;
    const accountId = typeof job.payload?.account_id === 'string' ? job.payload.account_id : null;
    if (!accountId) throw new Error('linkedin:validate requires payload.account_id');

    await heartbeat({ stage: 'validating', account_id: accountId });

    const { data, error: loadErr } = await researchSupabaseAdmin
        .from('linkedin_accounts')
        .select('id, status, proxy_session_id, user_agent, li_at_enc, jsessionid_enc')
        .eq('id', accountId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (loadErr) throw loadErr;
    if (!data) throw new Error(`linkedin:validate: account ${accountId} not found for tenant ${tenantId}`);
    const account = data as AccountRow;

    const now = new Date().toISOString();

    // ── Probe /voyager/api/me through the sticky proxy ────────────────────────────
    let result: Awaited<ReturnType<typeof validateSession>> | null = null;
    let transportError: string | null = null;
    try {
        if (!account.li_at_enc || !account.jsessionid_enc) throw new Error('account has no stored session cookies');
        if (!account.proxy_session_id) throw new Error('account has no proxy_session_id');
        const creds = {
            liAt: decryptCookie(account.li_at_enc),
            jsessionid: decryptCookie(account.jsessionid_enc),
            userAgent: account.user_agent ?? '',
        };
        result = await validateSession(creds, proxyAgentFor(account.proxy_session_id));
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
    const { error: updErr } = await researchSupabaseAdmin
        .from('linkedin_accounts').update(patch).eq('id', accountId).eq('tenant_id', tenantId);

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

    const { error: auditErr } = await researchSupabaseAdmin.from('linkedin_actions').insert({
        tenant_id: tenantId, account_id: accountId, type: 'validate', status: 'ok',
        classifier: result.classifier, http_status: result.httpStatus, job_id: job.id,
    });
    if (auditErr) log.warn({ err: auditErr, accountId }, 'validate audit insert failed (non-fatal)');

    const finalStatus = patch.status ?? account.status;
    log.info({ jobId: job.id, accountId, classifier: result.classifier, status: finalStatus }, 'linkedin:validate complete');
    return { account_id: accountId, status: finalStatus, classifier: result.classifier };
};
