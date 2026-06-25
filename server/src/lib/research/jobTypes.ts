/**
 * TG-Research — job type registry.
 *
 * The queue (`research_jobs.type`) is an open TEXT column; this is the canonical
 * set of types the worker knows how to run. Add a constant here AND register a
 * handler in lib/research/worker/handlers/index.ts when introducing a new job.
 *
 * Skeleton ships only `ping` — a no-op that proves the API→queue→worker→DB loop.
 * Real engine jobs (profile scrape, ICP generation, channel discovery, list
 * harvest, company validation, contact enrichment) land in later slices.
 */
export const RESEARCH_JOB_TYPES = {
    PING: 'ping',
} as const;

export type ResearchJobType = (typeof RESEARCH_JOB_TYPES)[keyof typeof RESEARCH_JOB_TYPES];

/** All known job types as a plain array (for validation / allowlisting). */
export const RESEARCH_JOB_TYPE_VALUES: readonly string[] = Object.values(RESEARCH_JOB_TYPES);

export function isKnownJobType(type: string): type is ResearchJobType {
    return RESEARCH_JOB_TYPE_VALUES.includes(type);
}
