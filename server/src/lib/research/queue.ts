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
 * Ownership-guarded: only the worker that holds the lock (locked_by) updates it,
 * so a worker whose job was reaped + reclaimed elsewhere can't clobber it.
 */
export async function heartbeatJob(jobId: string, workerId: string, progress?: Record<string, unknown>): Promise<void> {
    const patch: Record<string, unknown> = { heartbeat_at: new Date().toISOString() };
    if (progress) patch.progress = progress;
    const { error } = await researchSupabaseAdmin
        .from('research_jobs')
        .update(patch)
        .eq('id', jobId)
        .eq('locked_by', workerId)
        .eq('status', 'running');
    if (error) log.warn({ err: error, jobId }, 'heartbeatJob failed (non-fatal)');
}

/**
 * Mark a job succeeded with its result payload. Ownership-guarded: if this worker
 * no longer holds the running lock (e.g. it was reaped as stale and reclaimed by
 * another worker), the update matches nothing and the late result is discarded
 * rather than overwriting the newer attempt.
 */
export async function completeJob(jobId: string, workerId: string, result?: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    const { data, error } = await researchSupabaseAdmin
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
        .eq('status', 'running')
        .select('id');
    if (error) {
        log.error({ err: error, jobId }, 'completeJob failed');
        throw error;
    }
    if (!data || data.length === 0) {
        log.warn({ jobId, workerId }, 'completeJob matched no row — lock lost (reaped/reclaimed); result discarded');
    }
}

/**
 * Record a failure. Retries with exponential backoff (10s, 20s, 40s… capped at
 * 5m) until attempts hit max_attempts, then marks the job permanently failed.
 * `job.attempts` reflects the count *after* the claim (claim does attempts + 1),
 * so the first run sees attempts = 1.
 */
export async function failJob(job: ResearchJob, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const willRetry = job.attempts < job.max_attempts;
    const now = new Date().toISOString();

    const patch: Record<string, unknown> = {
        error: message.slice(0, 2000),
        heartbeat_at: now,
    };

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

    // Ownership-guarded (see completeJob): only finalize a job this worker still
    // holds, so a reaped + reclaimed job isn't clobbered by the stale worker.
    const { data, error } = await researchSupabaseAdmin
        .from('research_jobs')
        .update(patch)
        .eq('id', job.id)
        .eq('locked_by', job.locked_by)
        .eq('status', 'running')
        .select('id');
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
