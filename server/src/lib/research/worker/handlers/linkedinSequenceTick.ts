/**
 * linkedin:sequence-tick — advance a tenant's due campaign enrollments one batch (§5).
 *
 * Claims due enrollments (097 RPC: per-account-serialized + min-gap-paced + lease-guarded),
 * runs each through the sequence state machine, then RE-SEEDS itself while the tenant still
 * has an active campaign — a self-perpetuating loop seeded by campaign activation. The claim's
 * SKIP LOCKED + lease TTL make a few overlapping loops harmless (no double-send), so the loop
 * favors liveness over exactly-one.
 */
import type { JobHandler } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { createLogger } from '../../../logger.js';
import { enqueueJob } from '../../queue.js';
import { RESEARCH_JOB_TYPES } from '../../jobTypes.js';
import { processEnrollment, type EnrollmentRow } from '../../../linkedin/sequences/engine.js';

const log = createLogger('research:handler:linkedin-sequence-tick');

const BATCH_SIZE = 20;
const MIN_GAP_SECONDS = 90;      // §2 per-account min spacing (matches schedule.ts default)
const LEASE_TTL_SECONDS = 120;   // a claimed enrollment can't be re-claimed for 2m (crash guard)
const TICK_BUSY_MS = 30_000;     // re-seed sooner when the batch had work
const TICK_IDLE_MS = 60_000;     // re-seed later when idle but campaigns are still active

export const linkedinSequenceTickHandler: JobHandler = async ({ job, heartbeat }) => {
    const tenantId = job.tenant_id;
    await heartbeat({ stage: 'sequence-tick' });

    const { data, error } = await researchSupabaseAdmin.rpc('linkedin_claim_due_enrollments', {
        p_tenant: tenantId, p_worker: job.id, p_limit: BATCH_SIZE,
        p_min_gap_seconds: MIN_GAP_SECONDS, p_lease_ttl_seconds: LEASE_TTL_SECONDS,
    });
    if (error) throw error;
    const claimed = (data ?? []) as EnrollmentRow[];

    const outcomes: Record<string, number> = {};
    for (const enr of claimed) {
        const tag = await processEnrollment(enr, job.id);
        outcomes[tag] = (outcomes[tag] ?? 0) + 1;
        await heartbeat({ stage: 'sequence-tick', processed: Object.values(outcomes).reduce((a, b) => a + b, 0) });
    }

    // Backstop for the per-account poll loop (codex P2): a poll loop can die (auto-pause cancels
    // its queued job; a transient outage; a crash). The tick is the always-running heartbeat, so
    // it re-seeds a poll for any account with awaiting-event enrollments that has no poll queued.
    await reseedDroppedPolls(tenantId);

    // Re-seed the loop while this tenant still has an active campaign.
    const { count } = await researchSupabaseAdmin
        .from('linkedin_campaigns').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('status', 'active');
    let rescheduled = false;
    if ((count ?? 0) > 0) {
        const delay = claimed.length > 0 ? TICK_BUSY_MS : TICK_IDLE_MS;
        await enqueueJob({
            tenantId, type: RESEARCH_JOB_TYPES.LINKEDIN_SEQUENCE_TICK,
            payload: {}, maxAttempts: 1, scheduledAt: new Date(Date.now() + delay),
        });
        rescheduled = true;
    }

    log.info({ jobId: job.id, tenantId, claimed: claimed.length, outcomes, rescheduled }, 'linkedin:sequence-tick complete');
    return { claimed: claimed.length, outcomes, rescheduled };
};

/** Ensure every account with awaiting-event enrollments has a live poll loop (re-seed if none). */
async function reseedDroppedPolls(tenantId: string): Promise<void> {
    const { data: awaiting } = await researchSupabaseAdmin
        .from('linkedin_enrollments').select('account_id')
        .eq('tenant_id', tenantId).in('state', ['invited', 'messaged']).not('account_id', 'is', null);
    const accountIds = [...new Set((awaiting ?? []).map((r) => (r as { account_id: string }).account_id))];
    for (const accountId of accountIds) {
        const { data: existing } = await researchSupabaseAdmin
            .from('research_jobs').select('id')
            .eq('tenant_id', tenantId).eq('type', RESEARCH_JOB_TYPES.LINKEDIN_POLL)
            .filter('payload->>account_id', 'eq', accountId)
            .in('status', ['queued', 'running']).limit(1);
        if (!existing || existing.length === 0) {
            await enqueueJob({ tenantId, type: RESEARCH_JOB_TYPES.LINKEDIN_POLL, payload: { account_id: accountId }, maxAttempts: 1 });
        }
    }
}
