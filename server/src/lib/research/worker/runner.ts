/**
 * TG-Research worker runtime.
 *
 * Polls the Postgres queue, claims up to `concurrency` jobs at a time, runs each
 * via its registered handler, and refreshes a heartbeat while it runs so a dead
 * worker's jobs can be reaped and retried. Designed to run as its own process
 * (its own Railway service), but instantiable in-process for tests.
 */
import { randomUUID } from 'crypto';
import { createLogger } from '../../logger.js';
import {
    claimJob,
    completeJob,
    failJob,
    heartbeatJob,
    reapStaleJobs,
    type ResearchJob,
} from '../queue.js';
import { getHandler } from './handlers/index.js';

const log = createLogger('research:worker');

export interface WorkerOptions {
    /** Stable id stored on claimed jobs (locked_by). Defaults to a random id. */
    workerId?: string;
    /** Max jobs processed in parallel. */
    concurrency?: number;
    /** Poll delay after a tick that claimed work. */
    pollIntervalMs?: number;
    /** Poll delay after a tick that found nothing. */
    idleIntervalMs?: number;
    /** How often to reap stale (dead-worker) jobs. */
    reapIntervalMs?: number;
    /** Heartbeat cadence for a running job. */
    heartbeatIntervalMs?: number;
    /** Restrict to these job types (omit = all). */
    types?: string[];
}

export class ResearchWorker {
    private readonly workerId: string;
    private readonly concurrency: number;
    private readonly pollIntervalMs: number;
    private readonly idleIntervalMs: number;
    private readonly reapIntervalMs: number;
    private readonly heartbeatIntervalMs: number;
    private readonly types?: string[];

    private active = 0;
    private started = false;
    private stopping = false;
    private loopTimer: ReturnType<typeof setTimeout> | null = null;
    private reapTimer: ReturnType<typeof setInterval> | null = null;
    private readonly inFlight = new Set<Promise<void>>();

    constructor(opts: WorkerOptions = {}) {
        this.workerId = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
        this.concurrency = Math.max(1, opts.concurrency ?? 4);
        this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
        this.idleIntervalMs = opts.idleIntervalMs ?? 3000;
        this.reapIntervalMs = opts.reapIntervalMs ?? 60_000;
        this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 15_000;
        this.types = opts.types;
    }

    get id(): string {
        return this.workerId;
    }

    start(): void {
        if (this.started) {
            log.warn({ workerId: this.workerId }, 'worker already started');
            return;
        }
        this.started = true;
        this.stopping = false;
        log.info(
            { workerId: this.workerId, concurrency: this.concurrency, types: this.types ?? 'all' },
            'research worker started'
        );
        this.scheduleNext(0);
        // Also not unref'd (see scheduleNext) — keeps the standalone process alive.
        this.reapTimer = setInterval(() => void this.reap(), this.reapIntervalMs);
    }

    private scheduleNext(delay: number): void {
        if (this.stopping) return;
        // Deliberately NOT unref'd: the worker is a standalone process whose only
        // job is this poll loop. unref'ing would let Node exit before the first
        // tick (nothing else holds the event loop open). stop() clears the timer.
        this.loopTimer = setTimeout(() => void this.tick(), delay);
    }

    private async tick(): Promise<void> {
        if (this.stopping) return;
        let claimedAny = false;

        while (this.active < this.concurrency && !this.stopping) {
            let job: ResearchJob | null = null;
            try {
                job = await claimJob(this.workerId, this.types);
            } catch (err) {
                log.error({ err }, 'claim error — backing off');
                break;
            }
            if (!job) break;

            claimedAny = true;
            this.active++;
            const p = this.runJob(job).finally(() => {
                this.active--;
                this.inFlight.delete(p);
            });
            this.inFlight.add(p);
        }

        this.scheduleNext(claimedAny ? this.pollIntervalMs : this.idleIntervalMs);
    }

    private async runJob(job: ResearchJob): Promise<void> {
        const handler = getHandler(job.type);
        if (!handler) {
            await failJob(job, new Error(`No handler registered for job type "${job.type}"`));
            return;
        }

        const hb = setInterval(() => void heartbeatJob(job.id, this.workerId), this.heartbeatIntervalMs);
        hb.unref?.();
        try {
            const result = await handler({
                job,
                heartbeat: (progress) => heartbeatJob(job.id, this.workerId, progress),
            });
            await completeJob(job.id, this.workerId, result ?? {});
            log.info({ jobId: job.id, type: job.type }, 'job succeeded');
        } catch (err) {
            await failJob(job, err);
        } finally {
            clearInterval(hb);
        }
    }

    private async reap(): Promise<void> {
        try {
            const n = await reapStaleJobs();
            if (n > 0) log.warn({ reaped: n }, 'reaped stale jobs');
        } catch (err) {
            log.error({ err }, 'reap error');
        }
    }

    /** Stop polling and wait for in-flight jobs to finish (graceful drain). */
    async stop(): Promise<void> {
        if (!this.started || this.stopping) return;
        this.stopping = true;
        if (this.loopTimer) clearTimeout(this.loopTimer);
        if (this.reapTimer) clearInterval(this.reapTimer);
        log.info({ workerId: this.workerId, inFlight: this.inFlight.size }, 'draining in-flight jobs');
        await Promise.allSettled([...this.inFlight]);
        this.started = false;
        log.info({ workerId: this.workerId }, 'research worker stopped');
    }
}
