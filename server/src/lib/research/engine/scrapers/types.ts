/**
 * Maps scrapers (engine, Y1+). An ASYNC discovery backend: unlike SearXNG (a synchronous
 * query→URLs call), a maps scraper SUBMITS a scrape job to a self-hosted service, POLLS for
 * minutes, then returns structured business rows (name + website + phone + address). Gosom
 * (Google Maps, the West) and — later — a 2GIS finder (CIS) both implement this contract, so
 * the maps discovery source (see engine/sources.ts) is backend-agnostic and geography-routed.
 *
 * The rows are mapped to the engine's Candidate shape (name + registrable domain) and flow
 * through the SAME downstream spine as web-search candidates (canonicalize → dedup → fetch →
 * validate → persist → bill). A business WITH a website validates+bills exactly like a web hit;
 * one WITHOUT is parked domainless as 'review' (its phone/address are captured for the future
 * enrichment phase). The scrape itself is $0 (self-hosted); spend lives entirely in validation.
 */

/** One business as returned by a maps scraper (already normalized off the source's CSV/JSON). */
export interface MapsBusiness {
    /** Business/firm display name (the map listing title). */
    name: string;
    /** The listing's website, if any (raw — the source may return a full URL or a bare host). */
    website: string | null;
    /** Phone as listed (kept for enrichment; not used by the current billing pipeline). */
    phone: string | null;
    /** Full address string as listed (kept for enrichment). */
    address: string | null;
    /** Map category label (e.g. "Wholesaler", "Manufacturer"). */
    category: string | null;
    /** Any emails the scraper surfaced (Gosom email mode; usually empty — we do our own fetch). */
    emails: string | null;
}

export interface ScrapeOptions {
    /** Progress + lock-refresh callback (safe to call repeatedly through the poll loop). */
    heartbeat?: (progress?: Record<string, unknown>) => Promise<void>;
    /** Hard wall-clock ceiling for submit→ok→download. On timeout the scrape yields []. */
    maxWaitMs?: number;
    /** Delay between status polls. */
    pollMs?: number;
    /** Per-keyword scroll depth (source-specific; bounds how many listings each keyword yields). */
    depth?: number;
    /** UI/listing language hint (e.g. 'en' for Google Maps, 'ru' for 2GIS/CIS). */
    lang?: string;
    /** Cap on total rows returned (bounds memory + the downstream classify queries). */
    maxResults?: number;
}

/**
 * A maps discovery backend. `scrape` takes one or more keywords, runs the source's submit→poll→
 * download cycle, and returns normalized business rows. It NEVER throws — a failed scrape yields
 * an empty array (the discovery contract: no candidates → harvest stops gracefully), exactly like
 * searxngSearch swallows page errors.
 */
export interface MapsScraper {
    /** Stable backend id, surfaced in the job summary (e.g. 'gosom', 'twogis'). */
    readonly name: string;
    /** Run the scrape for these keywords and return normalized business rows (never throws). */
    scrape(keywords: string[], opts?: ScrapeOptions): Promise<MapsBusiness[]>;
}
