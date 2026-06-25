/**
 * TG-Research worker — handler contract.
 * Kept in its own module so handlers and the registry don't import each other
 * (avoids an import cycle).
 */
import type { ResearchJob } from '../queue.js';

export interface HandlerContext {
    /** The claimed job (status already 'running', attempts already incremented). */
    job: ResearchJob;
    /** Report progress + refresh the lock heartbeat. Safe to call repeatedly. */
    heartbeat: (progress?: Record<string, unknown>) => Promise<void>;
}

/**
 * A job handler. Return a JSON-serializable object to store as the job result,
 * or void for no result. Throw to fail the job (the runner handles retry/backoff).
 */
export type JobHandler = (ctx: HandlerContext) => Promise<Record<string, unknown> | void>;
