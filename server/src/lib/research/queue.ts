/**
 * TG-Research — Postgres-backed job queue (K3).
 *
 * The API enqueues work here; the separate worker service claims and runs it.
 * Claiming is atomic via the research_claim_job() RPC (FOR UPDATE SKIP LOCKED),
 * so many worker instances can poll concurrently without grabbing the same row.
 *
 * All access uses the service-role client (bypasses RLS); callers must already
 * have resolved/authorized the tenant.
 */
import { researchSupabaseAdmin } from './supabase.js';
import { createLogger } from '../logger.js';

const log = createLogger('research:queue');

export type ResearchJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/** Row shape of research_jobs (mirrors migration 055). */
export interface ResearchJob {
    id: string;
    tenant_id: string;
    project_id: string | null;
    type: string;
    payload: Record<string, unknown>;
    status: ResearchJobStatus;
    priority: number;
    attempts: number;
    max_attempts: number;
    progress: Record<string, unknown>;
    result: Record<string, unknown> | null;
    error: string | null;
    scheduled_at: string;
    locked_by: string | null;
    /** Per-attempt fencing token, minted by research_claim_job on each claim (060/062). */
    lease: string | null;
    locked_at: string | null;
    heartbeat_at: string | null;
    started_at: string | null;
    finished_at: string | null;
    created_by: string | null;
    created_at: string;
    updated_at: string;
}

export interface EnqueueOptions {
    tenantId: string;
    type: string;
    payload?: Record<string, unknown>;
    projectId?: string | null;
    priority?: number;
    maxAttempts?: number;
    /** Delay execution until this time (also used internally for retry backoff). */
    scheduledAt?: Date;
    createdBy?: string | null;
}

/** Insert a new job in the `queued` state. Returns the created row. */
export async function enqueueJob(opts: EnqueueOptions): Promise<ResearchJob> {
    const insert: Record<string, unknown> = {
        tenant_id: opts.tenantId,
        project_id: opts.projectId ?? null,
        type: opts.type,
        payload: opts.payload ?? {},
        priority: opts.priority ?? 0,
        max_attempts: opts.maxAttempts ?? 3,
        created_by: opts.createdBy ?? null,
    };
    if (opts.scheduledAt) insert.scheduled_at = opts.scheduledAt.toISOString();

    const { data, error } = await researchSupabaseAdmin
        .from('research_jobs')
        .insert(insert)
        .select()
        .single();

    if (error) {
        log.error({ err: error, type: opts.type, tenantId: opts.tenantId }, 'enqueueJob failed');
        throw error;
    }
    return data as ResearchJob;
}

/**
 * Atomically claim the next eligible job for this worker.
 * Returns null when the queue has nothing runnable right now.
 */
export async function claimJob(workerId: string, types?: string[]): Promise<ResearchJob | null> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_claim_job', {
        p_worker_id: workerId,
        p_types: types && types.length > 0 ? types : null,
    });
    if (error) {
        log.error({ err: error, workerId }, 'claimJob failed');
        throw error;
    }
    const rows = (data ?? []) as ResearchJob[];
    return rows.length > 0 ? rows[0] : null;
}

/**
 * Refresh the lock heartbeat (and optionally progress) for a running job.
 * Fenced: the update only lands when BOTH locked_by (this worker) AND lease (this
 * attempt) still match, so an attempt that was reaped + reclaimed — even by the same
 * worker id — can never clobber the newer attempt (queue lease fencing, 062 #7).
 */
export async function heartbeatJob(jobId: string, workerId: string, lease: string | null, progress?: Record<string, unknown>): Promise<void> {
    const patch: Record<string, unknown> = { heartbeat_at: new Date().toISOString() };
    if (progress) patch.progress = progress;
    let q = researchSupabaseAdmin
        .from('research_jobs')
        .update(patch)
        .eq('id', jobId)
        .eq('locked_by', workerId)
        .eq('status', 'running');
    q = lease ? q.eq('lease', lease) : q.is('lease', null);
    const { error } = await q;
    if (error) log.warn({ err: error, jobId }, 'heartbeatJob failed (non-fatal)');
}

/**
 * Mark a job succeeded with its result payload. Fenced by (locked_by, lease): if this
 * attempt no longer holds the running lock (e.g. it was reaped as stale and reclaimed),
 * the update matches nothing and the late result is discarded rather than overwriting
 * the newer attempt. Returns true only if THIS attempt actually finalized the job, so the
 * caller doesn't log a false "succeeded" after a lost lease.
 */
export async function completeJob(jobId: string, workerId: string, lease: string | null, result?: Record<string, unknown>): Promise<boolean> {
    const now = new Date().toISOString();
    let q = researchSupabaseAdmin
        .from('research_jobs')
        .update({
            status: 'succeeded',
            result: result ?? {},
            error: null,
            finished_at: now,
            heartbeat_at: now,
        })
        .eq('id', jobId)
        .eq('locked_by', workerId)
        .eq('status', 'running');
    q = lease ? q.eq('lease', lease) : q.is('lease', null);
    const { data, error } = await q.select('id');
    if (error) {
        log.error({ err: error, jobId }, 'completeJob failed');
        throw error;
    }
    if (!data || data.length === 0) {
        log.warn({ jobId, workerId }, 'completeJob matched no row — lease lost (reaped/reclaimed); result discarded');
        return false;
    }
    return true;
}

/**
 * Record a failure. Retries with exponential backoff (10s, 20s, 40s… capped at
 * 5m) until attempts hit max_attempts, then marks the job permanently failed.
 * `job.attempts` reflects the count *after* the claim (claim does attempts + 1),
 * so the first run sees attempts = 1.
 */
export async function failJob(job: ResearchJob, err: unknown, partialResult?: Record<string, unknown>): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const willRetry = job.attempts < job.max_attempts;
    const now = new Date().toISOString();

    const patch: Record<string, unknown> = {
        error: message.slice(0, 2000),
        heartbeat_at: now,
    };
    // Persist a failed-but-paid attempt's partial COGS trail (usage_raw + cost_recheck) so the
    // admin margin panel can SUM failed spend instead of being blind to it (05 §1b(3) — was
    // log-only). KNOWN LIMIT (accepted, codex batch-3): each retry OVERWRITES the previous
    // attempt's tally and a final success overwrites it again, so multi-attempt paid retries
    // under-report — immaterial today because harvest (the dominant COGS) is maxAttempts=1 and
    // icp:generate retries cost cents; revisit if any paid job type becomes multi-attempt.
    // The column is hidden from client reads (068) and role-sanitized in the API.
    if (partialResult && Object.keys(partialResult).length > 0) {
        patch.result = partialResult;
    }

    if (willRetry) {
        const backoffSec = Math.min(300, 10 * Math.pow(2, job.attempts - 1));
        patch.status = 'queued';
        patch.locked_by = null;
        patch.locked_at = null;
        patch.scheduled_at = new Date(Date.now() + backoffSec * 1000).toISOString();
    } else {
        patch.status = 'failed';
        patch.finished_at = now;
    }

    // Fenced (see completeJob): only finalize the exact attempt this worker still holds
    // (locked_by + lease), so a reaped + reclaimed job isn't clobbered by the stale attempt.
    let q = researchSupabaseAdmin
        .from('research_jobs')
        .update(patch)
        .eq('id', job.id)
        .eq('locked_by', job.locked_by)
        .eq('status', 'running');
    q = job.lease ? q.eq('lease', job.lease) : q.is('lease', null);
    const { data, error } = await q.select('id');
    if (error) {
        log.error({ err: error, jobId: job.id }, 'failJob update failed');
        throw error;
    }
    if (!data || data.length === 0) {
        log.warn({ jobId: job.id, lockedBy: job.locked_by }, 'failJob matched no row — lock lost (reaped/reclaimed); skipped');
        return;
    }
    log.warn(
        { jobId: job.id, type: job.type, willRetry, attempts: job.attempts, max: job.max_attempts, message },
        'job failed'
    );
}

/**
 * Requeue (or fail) jobs whose worker died mid-run, detected by a stale
 * heartbeat. Returns the number reaped. Run periodically by the worker.
 */
export async function reapStaleJobs(timeout = '5 minutes'): Promise<number> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_reap_stale_jobs', { p_timeout: timeout });
    if (error) {
        log.error({ err: error }, 'reapStaleJobs failed');
        return 0;
    }
    return (data as number) ?? 0;
}

/**
 * Release quota reservations stranded by a crashed worker (an OPEN hold whose job reached a
 * terminal state or vanished, or an orphan jobless hold older than `timeout`). Run periodically
 * by the worker alongside reapStaleJobs. Returns the number released. Non-fatal on error.
 */
export async function releaseStaleHolds(timeout = '15 minutes'): Promise<number> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_release_stale_holds', { p_timeout: timeout });
    if (error) {
        log.error({ err: error }, 'releaseStaleHolds failed');
        return 0;
    }
    return (data as number) ?? 0;
}

/**
 * Apply the current period's automatic lead-quota grants (research_tenant_settings, no Stripe —
 * 073). IDEMPOTENT: the ledger ref is deterministic per (tenant, period), so re-running (worker
 * ticks call this every reap interval — a cheap no-op once applied) can never double-grant.
 * Returns the number of tenants granted this call. Non-fatal on error.
 */
/**
 * Daily feedback-aggregate tick (WP5): enqueue ONE feedback:aggregate job per tenant that has
 * exported research companies, at most once per UTC day. Idempotent from the reap loop — the
 * duplicate guard checks any job of the type created today (queued/running/terminal alike),
 * so the every-minute call is a cheap no-op after the first enqueue.
 */
export async function enqueueDailyFeedbackAggregates(): Promise<number> {
    // DISTINCT runs in the DB (100 helper RPC — review P2): a raw row scan with a limit
    // would let ONE big tenant's exported rows fill the window and silently starve every
    // other tenant's daily aggregate (and their opt-out → suppression sync) forever.
    const { data: tenants, error: tErr } = await researchSupabaseAdmin.rpc('research_tenants_with_exports');
    if (tErr) throw tErr;
    const tenantIds = ((tenants ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id);
    if (tenantIds.length === 0) return 0;

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    // Chunked .in() (codex P2): enough exporting tenants would push a single query past the
    // gateway URL limit and fail the whole daily tick.
    const done = new Set<string>();
    for (let i = 0; i < tenantIds.length; i += 200) {
        const { data: todays, error: jErr } = await researchSupabaseAdmin
            .from('research_jobs')
            .select('tenant_id')
            .eq('type', 'feedback:aggregate')
            .gte('created_at', dayStart.toISOString())
            .in('tenant_id', tenantIds.slice(i, i + 200));
        if (jErr) throw jErr;
        for (const r of (todays ?? []) as Array<{ tenant_id: string }>) done.add(r.tenant_id);
    }

    let enqueued = 0;
    for (const tenantId of tenantIds) {
        if (done.has(tenantId)) continue;
        await enqueueJob({ tenantId, type: 'feedback:aggregate', payload: {} });
        enqueued++;
    }
    return enqueued;
}

export async function applyPeriodGrants(): Promise<number> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_apply_period_grants', {});
    if (error) {
        log.error({ err: error }, 'applyPeriodGrants failed');
        return 0;
    }
    return (data as number) ?? 0;
}
