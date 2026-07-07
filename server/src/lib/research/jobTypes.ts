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
    /** ICP Master (B5): generate ICP drafts from the project profile via the strategy model. */
    ICP_GENERATE: 'icp:generate',
    /** Y1 list-harvest (capped pilot): discover → validate → bill MATCHes for 1 ICP × 1 geo. */
    HARVEST_RUN: 'harvest:run',
    /** Maps-harvest: async maps scrape (Gosom/Google Maps; 2GIS/CIS in M2) → same harvest pipeline. */
    MAPS_HARVEST: 'maps:harvest',
    /** Y2: normalized customs buyers -> unbilled review candidates in the company ledger. */
    TRADE_INGEST: 'trade:ingest',
    /** Y2 explicit Research: imported buyers -> shared validation + MATCH-only billing. */
    TRADE_HARVEST: 'trade:harvest',
} as const;

export type ResearchJobType = (typeof RESEARCH_JOB_TYPES)[keyof typeof RESEARCH_JOB_TYPES];

/** All known job types as a plain array (for validation / allowlisting). */
export const RESEARCH_JOB_TYPE_VALUES: readonly string[] = Object.values(RESEARCH_JOB_TYPES);

export function isKnownJobType(type: string): type is ResearchJobType {
    return RESEARCH_JOB_TYPE_VALUES.includes(type);
}
