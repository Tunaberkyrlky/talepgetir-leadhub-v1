/**
 * HTTP maps-scraper factory (engine, Y1+). Both maps backends — Gosom (Google Maps, West) and the
 * 2GIS finder (CIS) — expose the SAME async REST job contract, so the submit→poll→download→parse
 * mechanics live here ONCE and each backend is a thin config (base URL + submit body). Contract:
 *   • POST {base}/api/v1/jobs               {keywords[], …}  → { id }
 *   • GET  {base}/api/v1/jobs/{id}          → { status ∈ pending|working|ok|failed }
 *   • GET  {base}/api/v1/jobs/{id}/download → text/csv (columns incl. title, website, phone, address)
 *
 * A scrape runs for seconds-to-minutes: submit once, poll until ok/failed/timeout (heartbeating so
 * the worker's lease stays fresh), then download + parse. NEVER throws — any failure (unset URL,
 * submit error, poll timeout, failed job, bad CSV) yields [] so discovery stops gracefully.
 */
import Papa from 'papaparse';
import { createLogger } from '../../../logger.js';
import type { MapsBusiness, MapsScraper, ScrapeOptions } from './types.js';

// Shared fallbacks; a backend overrides via config.defaults (e.g. RESEARCH_GOSOM_POLL_MS).
const FALLBACK_POLL_MS = 5_000;
const FALLBACK_MAX_WAIT_MS = 8 * 60_000;
const FALLBACK_MAX_RESULTS = 200;
const FALLBACK_HTTP_TIMEOUT_MS = 30_000;

export interface HttpScraperDefaults {
    pollMs?: number;
    maxWaitMs?: number;
    maxResults?: number;
    httpTimeoutMs?: number;
    maxResponseBytes?: number;
}

export interface HttpScraperConfig {
    /** Stable backend id, surfaced in the job summary (e.g. 'gosom', 'twogis'). */
    name: string;
    /** Base URL resolver — null when the backend's URL env is unset (scrape yields []). */
    baseUrl: () => string | null;
    /** Build the POST /api/v1/jobs body for this backend from the keywords + options. */
    buildSubmitBody: (keywords: string[], opts: ScrapeOptions) => Record<string, unknown>;
    /** Optional per-keyword bodies for APIs that accept one keyword per job (Gosom /scrape). */
    buildSubmitBodies?: (keywords: string[], opts: ScrapeOptions) => Record<string, unknown>[];
    /** Submit endpoint path. Defaults to the 2GIS-compatible /api/v1/jobs contract. */
    submitPath?: string;
    /** Whether completed rows are returned inline by GET job status (Gosom), not as CSV download. */
    resultsInStatus?: boolean;
    /** Per-backend timing/size defaults (else the shared fallbacks above). */
    defaults?: HttpScraperDefaults;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

const EMPTY_LISTING_VALUES = new Set(['n/a', 'na', 'none', 'null', 'unknown', 'not specified']);

export class MapsHeartbeatError extends Error {
    constructor(readonly cause: unknown) { super('maps scraper heartbeat failed'); }
}

async function responseTextBounded(resp: Response, maxBytes: number): Promise<string> {
    const declared = Number(resp.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new Error(`maps response exceeds ${maxBytes} bytes`);
    if (!resp.body) return '';
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw new Error(`maps response exceeds ${maxBytes} bytes`); }
        chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(merged);
}

/** Read one bounded, normalized listing-metadata string without coercing objects to junk text. */
function listingText(
    row: Record<string, unknown>,
    keys: string[],
    maxLength: number,
    rejectStructuredJson = false
): string | null {
    for (const key of keys) {
        const raw = row[key];
        if (typeof raw !== 'string') continue;
        const value = raw.replace(/\s+/g, ' ').trim();
        if (!value || EMPTY_LISTING_VALUES.has(value.toLowerCase())) continue;
        // Gosom's `about` CSV column is a JSON array of amenities (accessibility, payments, etc.),
        // not a prose business description. Never feed that structured blob to the validator.
        if (rejectStructuredJson && /^[\[{]/.test(value)) {
            try {
                const parsed = JSON.parse(value) as unknown;
                if (parsed !== null && typeof parsed === 'object') continue;
            } catch {
                // A prose value that merely starts with a bracket is still usable listing text.
            }
        }
        return value.slice(0, maxLength);
    }
    return null;
}

/** Download + parse the result CSV into normalized business rows (shared column mapping). */
function parseCsv(csv: string, maxResults: number): MapsBusiness[] {
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: 'greedy' });
    const rows = Array.isArray(parsed.data) ? parsed.data : [];
    const out: MapsBusiness[] = [];
    for (const r of rows) {
        const name = (r.title ?? '').trim();
        if (!name) continue; // header-only or malformed row
        out.push({
            name,
            website: (r.website ?? r.web_site ?? r.site ?? '').trim() || null,
            phone: (r.phone ?? '').trim() || null,
            address: (r.address ?? '').trim() || null,
            category: listingText(r, ['category', 'type', 'main_category', 'business_category'], 255),
            description: listingText(r, ['descriptions', 'description', 'business_description', 'businessDescription', 'place_description', 'about_text', 'about'], 4_000, true),
            emails: (r.emails ?? '').trim() || null,
        });
        if (out.length >= maxResults) break;
    }
    return out;
}

function parseResultObjects(rows: unknown, maxResults: number): MapsBusiness[] {
    if (!Array.isArray(rows)) return [];
    const out: MapsBusiness[] = [];
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const name = String(r.title ?? r.name ?? '').trim();
        if (!name) continue;
        out.push({
            name,
            website: String(r.website ?? r.web_site ?? r.site ?? '').trim() || null,
            phone: String(r.phone ?? r.phone_number ?? '').trim() || null,
            address: String(r.address ?? r.full_address ?? '').trim() || null,
            category: listingText(r, ['category', 'type', 'main_category', 'business_category'], 255),
            description: listingText(r, ['descriptions', 'description', 'business_description', 'businessDescription', 'place_description', 'about_text', 'about'], 4_000, true),
            emails: Array.isArray(r.emails) ? r.emails.join(',') : String(r.emails ?? '').trim() || null,
        });
        if (out.length >= maxResults) break;
    }
    return out;
}

/** Build a MapsScraper for any backend that speaks the Gosom-compatible REST job contract. */
export function createHttpMapsScraper(config: HttpScraperConfig): MapsScraper {
    const log = createLogger(`research:engine:${config.name}`);
    const d = config.defaults ?? {};
    const httpTimeout = d.httpTimeoutMs ?? FALLBACK_HTTP_TIMEOUT_MS;
    const maxResponseBytes = d.maxResponseBytes ?? 5 * 1024 * 1024;

    async function submitJob(base: string, body: Record<string, unknown>): Promise<string | null> {
        const resp = await fetchWithTimeout(
            `${base}${config.submitPath ?? '/api/v1/jobs'}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) },
            httpTimeout
        );
        if (!resp.ok) {
            log.warn({ status: resp.status }, `${config.name} submit non-ok`);
            return null;
        }
        const job = JSON.parse(await responseTextBounded(resp, maxResponseBytes)) as { id?: unknown; job_id?: unknown };
        const id = typeof job.id === 'string' ? job.id : typeof job.job_id === 'string' ? job.job_id : null;
        if (!id) log.warn({ job }, `${config.name} submit response missing id`);
        return id;
    }

    async function jobStatus(base: string, id: string): Promise<{ status: string | null; results: MapsBusiness[] | null }> {
        const resp = await fetchWithTimeout(`${base}/api/v1/jobs/${id}`, { headers: { Accept: 'application/json' } }, httpTimeout);
        if (!resp.ok) {
            log.warn({ id, status: resp.status }, `${config.name} status non-ok`);
            return { status: null, results: null };
        }
        const job = JSON.parse(await responseTextBounded(resp, maxResponseBytes)) as { status?: unknown; Status?: unknown; results?: unknown };
        const status = typeof job.status === 'string' ? job.status : typeof job.Status === 'string' ? job.Status : null;
        return {
            status: status?.toLowerCase() ?? null,
            results: config.resultsInStatus ? parseResultObjects(job.results, FALLBACK_MAX_RESULTS) : null,
        };
    }

    async function downloadResults(base: string, id: string, maxResults: number): Promise<MapsBusiness[]> {
        const resp = await fetchWithTimeout(`${base}/api/v1/jobs/${id}/download`, { headers: { Accept: 'text/csv' } }, httpTimeout);
        if (!resp.ok) {
            log.warn({ id, status: resp.status }, `${config.name} download non-ok`);
            return [];
        }
        return parseCsv(await responseTextBounded(resp, maxResponseBytes), maxResults);
    }

    async function cleanupJob(base: string, id: string): Promise<void> {
        try {
            await fetchWithTimeout(`${base}/api/v1/jobs/${id}`, { method: 'DELETE' }, httpTimeout);
        } catch (err) {
            log.warn({ id, err: err instanceof Error ? err.message : String(err) }, `${config.name} cleanup failed`);
        }
    }

    async function heartbeat(opts: ScrapeOptions, progress: Record<string, unknown>): Promise<void> {
        try { await opts.heartbeat?.(progress); } catch (err) { throw new MapsHeartbeatError(err); }
    }

    return {
        name: config.name,
        async scrape(keywords: string[], opts: ScrapeOptions = {}): Promise<MapsBusiness[]> {
            const base = config.baseUrl();
            if (!base) {
                log.warn(`${config.name} scrape requested but its URL env is unset — no candidates`);
                return [];
            }
            const kw = keywords.map((k) => k.trim()).filter(Boolean);
            if (kw.length === 0) return [];

            const pollMs = opts.pollMs ?? d.pollMs ?? FALLBACK_POLL_MS;
            const maxWaitMs = opts.maxWaitMs ?? d.maxWaitMs ?? FALLBACK_MAX_WAIT_MS;
            const maxResults = opts.maxResults ?? d.maxResults ?? FALLBACK_MAX_RESULTS;
            const deadline = Date.now() + maxWaitMs;

            try {
                const bodies = config.buildSubmitBodies?.(kw, opts) ?? [config.buildSubmitBody(kw, opts)];
                const allBusinesses: MapsBusiness[] = [];
                for (const body of bodies) {
                    const id = await submitJob(base, body);
                    if (!id) continue;
                    try {
                        await heartbeat(opts, { stage: 'maps_submitted', backend: config.name, keywords: kw.length });
                        // Poll until ok/completed/failed/timeout. A transient status error doesn't abort.
                        let polls = 0;
                        while (true) {
                            const remaining = deadline - Date.now();
                            if (remaining <= 0) break;
                            await sleep(Math.min(pollMs, remaining));
                            polls++;
                            const { status, results } = await jobStatus(base, id);
                            if (status === 'ok' || status === 'completed') {
                                const businesses = results ?? await downloadResults(base, id, Math.max(0, maxResults - allBusinesses.length));
                                log.info({ id, polls, businesses: businesses.length }, `${config.name} scrape complete`);
                                allBusinesses.push(...businesses);
                                break;
                            }
                            if (status === 'failed') { log.warn({ id, polls }, `${config.name} job failed`); break; }
                            await heartbeat(opts, { stage: 'maps_polling', backend: config.name, polls, status: status ?? 'unknown' });
                        }
                    } finally {
                        await cleanupJob(base, id);
                    }
                    if (allBusinesses.length >= maxResults || Date.now() >= deadline) break;
                }
                if (allBusinesses.length === 0 && Date.now() >= deadline) {
                    log.warn({ maxWaitMs }, `${config.name} scrape timed out — yielding no candidates`);
                }
                return allBusinesses.slice(0, maxResults);
            } catch (err) {
                if (err instanceof MapsHeartbeatError) throw err.cause;
                log.warn({ err: err instanceof Error ? err.message : String(err) }, `${config.name} scrape failed (non-fatal)`);
                return [];
            }
        },
    };
}
