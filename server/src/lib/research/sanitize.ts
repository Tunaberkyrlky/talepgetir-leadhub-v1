/**
 * Role-based response sanitization for the Research module.
 *
 * Product rule: real COGS (USD — LLM tokens, grounding fees, fetch spend, per-run budgets) is an
 * INTERNAL margin signal. Customers see leads/credits (counts), never dollars. Internal roles
 * (superadmin, ops_agent) see everything. Migration 068 enforces the same split at the DB layer
 * (column-level grants for direct PostgREST reads); this is the API layer of the same rule, since
 * the API reads with the service role and would otherwise pass the full row through.
 */
import { isInternalRole } from '../roles.js';

/** Dollar-bearing keys inside a job's result payload (harvest:run summary). */
const COST_RESULT_KEYS = ['cost_usd', 'cost_recheck', 'usage_raw', 'caps', 'pricing_version'];

/**
 * Map a raw worker error to a customer-safe message. Raw text can carry provider billing/quota
 * strings (amounts, spend limits) — a cost-leak channel (codex P1); 072 also hides the DB column
 * from direct client reads. Known, customer-actionable failures keep a specific message; anything
 * else collapses to a generic one (the job id is the support reference).
 */
export function sanitizeJobError(error: unknown): string | null {
    if (typeof error !== 'string' || error.length === 0) return null;
    if (/insufficient research credits/i.test(error)) {
        return 'Insufficient lead quota — top up and re-run.';
    }
    // Order matters: the geography-cell check must precede the generic not-'approved' pattern,
    // or a demoted geo cell would misdirect the customer to re-approve the (approved) ICP.
    if (/geography cell .* not 'approved'/i.test(error)) {
        return 'The geography must be approved before running.';
    }
    if (/ICP .* not.*approved|not 'approved'/i.test(error)) {
        return 'The ICP must be approved before running.';
    }
    return 'The run failed. Please try again or contact support with this job id.';
}

/**
 * Strip cost-bearing fields from a research job row for non-internal roles.
 * result: cost breakdown / raw token meter / caps (per-run USD budget) are removed; lead-count
 * fields (matches, newly_billed, hold counts, …) stay. payload: caps (maxSpendUsd) removed.
 * error: replaced with a customer-safe message. Internal roles get the row untouched.
 */
export function sanitizeJobForRole<T extends Record<string, unknown>>(job: T, role: string): T {
    if (isInternalRole(role)) return job;
    const out: Record<string, unknown> = { ...job };
    if (out.result && typeof out.result === 'object' && !Array.isArray(out.result)) {
        const result = { ...(out.result as Record<string, unknown>) };
        for (const k of COST_RESULT_KEYS) delete result[k];
        out.result = result;
    }
    if (out.payload && typeof out.payload === 'object' && !Array.isArray(out.payload)) {
        const payload = { ...(out.payload as Record<string, unknown>) };
        delete payload.caps;
        out.payload = payload;
    }
    if ('error' in out) {
        out.error = sanitizeJobError(out.error);
    }
    return out as T;
}

/** Convenience for list endpoints. */
export function sanitizeJobsForRole<T extends Record<string, unknown>>(jobs: T[], role: string): T[] {
    if (isInternalRole(role)) return jobs;
    return jobs.map((j) => sanitizeJobForRole(j, role));
}
