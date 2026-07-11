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
    /** WP7 FAZ 1: crawl the project's website + social links (reading model) -> profile.ai_draft. */
    PROFILE_CRAWL: 'profile:crawl',
    /** ICP Master (B5): generate ICP drafts from the project profile via the strategy model. */
    ICP_GENERATE: 'icp:generate',
    /** WP11: propose 6-digit HS candidates for approved physical products (strategy model),
     *  validated against the live UN Comtrade HS nomenclature before persisting to research_hs_codes. */
    HS_MATCH: 'hs:match',
    /** WP11: rank world importers + seller-country bilateral exports for approved HS codes via
     *  UN Comtrade (no LLM call) -> research_markets. Requires >=1 approved HS code. */
    MARKET_ANALYZE: 'market:analyze',
    /** WP1 calibration: propose an ICP ruleset revision from human good/bad feedback (strategy model). */
    ICP_REVISE: 'icp:revise',
    /** WP2 sub-ICP: instantiate an ICP for one country (local terms/signals/channels/E) into research_geographies. */
    GEO_ANALYZE: 'geo:analyze',
    /** Y1 list-harvest (capped pilot): discover → validate → bill MATCHes for 1 ICP × 1 geo. */
    HARVEST_RUN: 'harvest:run',
    /** Maps-harvest: async maps scrape (Gosom/Google Maps; 2GIS/CIS in M2) → same harvest pipeline. */
    MAPS_HARVEST: 'maps:harvest',
    /** Y2: normalized customs buyers -> unbilled review candidates in the company ledger. */
    TRADE_INGEST: 'trade:ingest',
    /** Y2 explicit Research: imported buyers -> shared validation + MATCH-only billing. */
    TRADE_HARVEST: 'trade:harvest',
    /** WP3 Y1: discover company-list channels for one approved sub-ICP cell (SearXNG + reading role). */
    CHANNELS_DISCOVER: 'channels:discover',
    /** WP3 Y1: harvest one channel's member list -> shared fenced spine (validate + bill). */
    CHANNELS_HARVEST: 'channels:harvest',
    /** WP4: draft 3-5 outreach angles for one approved ICP (strategy role; human-approved cards). */
    OFFER_GENERATE: 'offer:generate',
    /** WP5: pull campaign outcomes (sent/replies/positive/optouts) back onto research aggregates; daily + run-now. */
    FEEDBACK_AGGREGATE: 'feedback:aggregate',
    /** Enrichment: Hunter domain-search contacts for selected companies (strict domain match, once-ever billing). */
    ENRICH_RUN: 'enrich:run',
    /** WP9: conductor for ONE approved icp×geo cell — enqueues + polls channels:discover/harvest
     *  (Y1) and harvest:run (Y3) in sequence until scale_target/credits/full coverage stops it. */
    ORCHESTRATE: 'research:orchestrate',

    // ── TG-LinkedIn (isolated module; rides this same research_jobs queue) ─────
    /** LinkedIn: session liveness + UA/proxy health smoke (/voyager/api/me). Faz 1. */
    LINKEDIN_VALIDATE: 'linkedin:validate',
    /** LinkedIn: send one connection request (§4.1). DRY-RUN default. Faz 2. */
    LINKEDIN_INVITE: 'linkedin:invite',
    /** LinkedIn: send one new-conversation message (§4.2). DRY-RUN default. Faz 2. */
    LINKEDIN_MESSAGE: 'linkedin:message',
    /** LinkedIn: withdraw stale pending invitations (§2 hygiene). DRY-RUN default. Faz 3. */
    LINKEDIN_WITHDRAW: 'linkedin:withdraw',
    /** LinkedIn: advance a tenant's due campaign enrollments one batch (§5). Faz 4. */
    LINKEDIN_SEQUENCE_TICK: 'linkedin:sequence-tick',
    /** LinkedIn: detect invite accepts + replies for one account's enrollments (§5). Faz 4. */
    LINKEDIN_POLL: 'linkedin:poll',
    /** LinkedIn: daily PII retention purge (old audit rows + stale-lead anonymize, §6). Faz 5. */
    LINKEDIN_RETENTION: 'linkedin:retention',
    /** LinkedIn: daily staged reconcile of the static-proxy inventory vs the provider (Proxy P2, §4a). */
    LINKEDIN_PROXY_SYNC: 'linkedin:proxy-sync',
    // RESERVED — do NOT add as constants until each ships a REGISTERED handler.
    // Adding them here would widen isKnownJobType, so the internal POST /api/research/jobs
    // could enqueue a type with no handler → worker fails "No handler registered" and
    // burns retries (critique P1-1).
} as const;

export type ResearchJobType = (typeof RESEARCH_JOB_TYPES)[keyof typeof RESEARCH_JOB_TYPES];

/** All known job types as a plain array (for validation / allowlisting). */
export const RESEARCH_JOB_TYPE_VALUES: readonly string[] = Object.values(RESEARCH_JOB_TYPES);

export function isKnownJobType(type: string): type is ResearchJobType {
    return RESEARCH_JOB_TYPE_VALUES.includes(type);
}
