/**
 * linkedin:validate — session liveness + UA/proxy health (§4/§6).
 *
 * FAZ 0: STUB. Proves the loop (payload → load account → heartbeat → audit row →
 * result) and is idempotent. It does NOT hit the network and does NOT promote
 * account.status. Fleshed out in Faz 1 (see TODO below).
 *
 * Follows the mapsHarvest/harvestRun template: service-role client, tenant-scoped
 * writes, heartbeat for long work, throw to fail, return a JSON summary.
 */
import type { JobHandler } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:linkedin-validate');

export const linkedinValidateHandler: JobHandler = async ({ job, heartbeat }) => {
    const tenantId = job.tenant_id;
    const accountId = typeof job.payload?.account_id === 'string' ? job.payload.account_id : null;
    if (!accountId) throw new Error('linkedin:validate requires payload.account_id');

    // Fence identity — a claimed job always carries these (see harvestRun).
    const worker = job.locked_by;
    const lease = job.lease;
    if (!worker || !lease) throw new Error(`linkedin:validate: job ${job.id} has no running lease`);

    await heartbeat({ stage: 'validating', account_id: accountId });

    // Load the account (tenant-scoped). Must exist and belong to this tenant.
    // Faz 0 stub only needs id+status; Faz 1 re-selects proxy_session_id, user_agent,
    // li_at_enc, jsessionid_enc for the real decrypt + /voyager/api/me call — keeping the
    // decryptable session secrets out of worker memory until they're actually consumed.
    const { data: account, error: loadErr } = await researchSupabaseAdmin
        .from('linkedin_accounts')
        .select('id, status')
        .eq('id', accountId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (loadErr) throw loadErr;
    if (!account) throw new Error(`linkedin:validate: account ${accountId} not found for tenant ${tenantId}`);

    // ── TODO(Faz 1): real validation ──────────────────────────────────────────
    //   1. decryptCookie(li_at_enc) + decryptCookie(jsessionid_enc)  (lib/linkedin/crypto)
    //      — csrf-token header = the JSESSIONID value with its surrounding "quotes"
    //        STRIPPED (voyager golden recipe, §4.1 / critique P2-g).
    //   2. agent = proxyAgentFor(account.proxy_session_id)           (lib/linkedin/proxy)
    //   3. GET /voyager/api/me with the golden-recipe headers + captured user_agent,
    //      { dispatcher: agent, signal: AbortSignal.timeout(20_000) }; never-throw wrap.
    //   4. classify per §4.4 (200 → ACTIVE + fill member_urn/public_id/name;
    //      401/expired → NEEDS_REAUTH; 403/999/restrict → CHALLENGED/RESTRICTED).
    //   5. member_urn write MUST use the collision strategy from migration 083
    //      (uq_linkedin_accounts_tenant_urn / critique P1-3): pre-check (tenant_id,
    //      member_urn); on collision fold/RESTRICT the duplicate + surface
    //      "already connected", never a plain UPDATE that 23505s.
    // ──────────────────────────────────────────────────────────────────────────

    // Faz-0: record a 'skipped' audit row; do NOT change status.
    const { error: auditErr } = await researchSupabaseAdmin.from('linkedin_actions').insert({
        tenant_id: tenantId,
        account_id: accountId,
        type: 'validate',
        status: 'skipped',
        classifier: 'faz0_stub',
        job_id: job.id,
    });
    if (auditErr) throw auditErr;

    log.info({ jobId: job.id, accountId }, 'linkedin:validate (faz0 stub) complete');
    return { account_id: accountId, stub: true, status: (account as { status: string }).status };
};
