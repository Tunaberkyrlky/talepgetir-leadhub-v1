/**
 * linkedin:retention — daily PII retention purge for one tenant (§6 uyumluluk).
 *
 * Thin wrapper over the 101 RPC (old linkedin_actions deleted, expired link tokens deleted,
 * stale non-suppressed leads anonymized; suppressed identities keep their key but lose PII).
 *
 * SELF-HEALING LOOP (Faz-5 review P2): the daily reschedule runs on EVERY exit — including when
 * the purge RPC errors — so a single transient Supabase failure can't permanently kill the
 * tenant's retention (there is no other backstop; the sequence-tick only reseeds POLL loops).
 * The purge error is recorded on the audit trail + rethrown so the failed run is still visible,
 * but a successor is always queued first. Seeded by ensureRetentionLoop (campaign activation +
 * account validate) and by the internal POST /retention/run; a queued-guard keeps duplicates out.
 */
import type { JobHandler } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { createLogger } from '../../../logger.js';
import { enqueueJob } from '../../queue.js';
import { RESEARCH_JOB_TYPES } from '../../jobTypes.js';

const log = createLogger('research:handler:linkedin-retention');

export const RETENTION_DAYS_DEFAULT = 90;
const RETENTION_DAYS_MIN = 30;
const RETENTION_DAYS_MAX = 365;
const LOOP_MS = 24 * 3_600_000;

/**
 * Enqueue tomorrow's retention job for a tenant that still has a LinkedIn account, unless one is
 * already queued/running. Always carries the DEFAULT window: a one-off manual run with a custom
 * retention_days must not become the permanent policy. Never throws (best-effort keep-alive).
 *
 * excludeJobId: when the RUNNING retention handler calls this to self-perpetuate, its own job is
 * still status='running' and would match the dedup guard — so it passes its job.id to exclude
 * itself, otherwise the guard sees "a retention job is already running" and never queues the
 * successor (the loop would silently run exactly once per seed). Seed callers pass no id.
 */
export async function ensureRetentionLoop(tenantId: string, delayMs = LOOP_MS, excludeJobId?: string): Promise<boolean> {
    try {
        const { count, error: accErr } = await researchSupabaseAdmin
            .from('linkedin_accounts').select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId);
        // On a read error, fail-OPEN and still schedule — dropping the loop is the worse failure.
        if (!accErr && (count ?? 0) === 0) return false;
        let q = researchSupabaseAdmin
            .from('research_jobs').select('id')
            .eq('tenant_id', tenantId).eq('type', RESEARCH_JOB_TYPES.LINKEDIN_RETENTION)
            .in('status', ['queued', 'running']);
        if (excludeJobId) q = q.neq('id', excludeJobId);
        const { data: existing } = await q.limit(1);
        if (existing && existing.length > 0) return false;
        await enqueueJob({
            tenantId, type: RESEARCH_JOB_TYPES.LINKEDIN_RETENTION,
            payload: {}, maxAttempts: 1, scheduledAt: new Date(Date.now() + delayMs),
        });
        return true;
    } catch (err) {
        log.warn({ err, tenantId }, 'ensureRetentionLoop failed (non-fatal)');
        return false;
    }
}

export const linkedinRetentionHandler: JobHandler = async ({ job, heartbeat }) => {
    const tenantId = job.tenant_id;
    await heartbeat({ stage: 'retention' });

    const p = (job.payload ?? {}) as Record<string, unknown>;
    const raw = Number(p.retention_days);
    const days = Number.isFinite(raw)
        ? Math.min(RETENTION_DAYS_MAX, Math.max(RETENTION_DAYS_MIN, Math.floor(raw)))
        : RETENTION_DAYS_DEFAULT;

    // Run the purge, but ALWAYS reschedule (even on failure) so the loop self-heals.
    let result: Record<string, unknown> = {};
    let purgeError: unknown = null;
    try {
        const { data, error } = await researchSupabaseAdmin.rpc('linkedin_purge_retention', {
            p_tenant: tenantId, p_days: days,
        });
        if (error) throw error;
        result = (data ?? {}) as Record<string, unknown>;
    } catch (err) {
        purgeError = err;
    }

    // Exclude THIS job (still status='running' until the handler returns) so the guard doesn't
    // mistake it for an already-queued successor and skip the reschedule.
    const rescheduled = await ensureRetentionLoop(tenantId, LOOP_MS, job.id);

    if (purgeError) {
        log.error({ jobId: job.id, tenantId, err: purgeError, rescheduled }, 'linkedin:retention purge failed (loop kept alive)');
        throw purgeError; // mark THIS run failed (visible) — the successor is already queued
    }

    log.info({ jobId: job.id, tenantId, days, result, rescheduled }, 'linkedin:retention complete');
    return { retention_days: days, ...result, rescheduled };
};
