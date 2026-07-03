/**
 * SearXNG search client (engine, Y1+). Deterministic multi-engine web search — the discovery
 * mechanism that REPLACES Gemini grounding (design: "deterministic tools scan, the LLM only
 * interprets"). One query+geography is paginated across N result pages of whatever general
 * engines the SearXNG instance has enabled (Google, Bing, DuckDuckGo, Yandex, …); every result
 * URL is a candidate firm's site. No LLM, no per-call cost (self-hosted).
 *
 * Reached over Railway's private network at RESEARCH_SEARXNG_URL (http://searxng.railway.internal:8080).
 * Never throws — a failed page yields fewer results, and an all-failed search yields zero
 * candidates (harvest then stops gracefully).
 */
import { createLogger } from '../../logger.js';

const log = createLogger('research:engine:searxng');

export interface SearxResult {
    url: string;
    title: string;
    content: string;
    engine: string | null;
}

export interface SearxOptions {
    /** Result pages to fetch per query (SearXNG paginates ~10 hits/page). */
    pages?: number;
    /** Comma-separated engine list; omit to use the instance's enabled general engines. */
    engines?: string | null;
    language?: string;
    /** Per-page fetch timeout. */
    timeoutMs?: number;
}

const DEFAULT_PAGES = Number(process.env.RESEARCH_SEARXNG_PAGES) || 5;
const DEFAULT_ENGINES = process.env.RESEARCH_SEARXNG_ENGINES || null;
const DEFAULT_TIMEOUT = Number(process.env.RESEARCH_SEARXNG_TIMEOUT_MS) || 15_000;

/** Base URL of the SearXNG instance, or null when unconfigured (caller falls back). */
export function searxngBaseUrl(): string | null {
    const u = process.env.RESEARCH_SEARXNG_URL?.trim();
    return u ? u.replace(/\/+$/, '') : null;
}

interface SearxPageResponse {
    results?: Array<{ url?: unknown; title?: unknown; content?: unknown; engine?: unknown }>;
}

/** A page fetch either succeeded (ok) with N results, or failed (timeout/non-2xx/bad JSON). An
 *  ok page with 0 results means genuine exhaustion; a failed page does NOT — the two must not be
 *  conflated, or a transient error would truncate results AND get cached as if complete. */
interface PageOutcome {
    ok: boolean;
    results: SearxResult[];
}

async function fetchPage(base: string, query: string, pageno: number, opts: SearxOptions): Promise<PageOutcome> {
    const params = new URLSearchParams({
        q: query,
        format: 'json',
        pageno: String(pageno),
        language: opts.language ?? 'en',
        safesearch: '0',
    });
    const engines = opts.engines ?? DEFAULT_ENGINES;
    if (engines) params.set('engines', engines);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT);
    try {
        const resp = await fetch(`${base}/search?${params.toString()}`, {
            headers: { Accept: 'application/json', 'User-Agent': 'tg-research-worker/1.0' },
            signal: ctrl.signal,
        });
        if (!resp.ok) {
            log.warn({ pageno, status: resp.status }, 'searxng page non-ok');
            return { ok: false, results: [] };
        }
        const body = (await resp.json()) as SearxPageResponse;
        const rows = Array.isArray(body.results) ? body.results : [];
        const out: SearxResult[] = [];
        for (const r of rows) {
            if (typeof r.url !== 'string' || !r.url) continue;
            out.push({
                url: r.url,
                title: typeof r.title === 'string' ? r.title : '',
                content: typeof r.content === 'string' ? r.content : '',
                engine: typeof r.engine === 'string' ? r.engine : null,
            });
        }
        return { ok: true, results: out };
    } catch (err) {
        log.warn({ pageno, err: err instanceof Error ? err.message : String(err) }, 'searxng page failed');
        return { ok: false, results: [] };
    } finally {
        clearTimeout(timer);
    }
}

export interface SearxSearchResult {
    results: SearxResult[];
    /** True only when pagination ended cleanly (a genuinely empty page or the page cap with all
     *  pages OK). False when a page failed — the results may be truncated, so the caller must NOT
     *  cache them as a complete answer. */
    complete: boolean;
}

/**
 * Run one query across up to `pages` result pages. Returns the raw results (URL + title + snippet)
 * in engine order plus a `complete` flag; de-duplication by registrable domain and junk-dropping
 * are the caller's job (discovery). Stops early only on a SUCCESSFUL empty page (exhaustion); a
 * failed page ends the loop but marks the result incomplete so it isn't cached long-term.
 */
export async function searxngSearch(query: string, opts: SearxOptions = {}): Promise<SearxSearchResult> {
    const base = searxngBaseUrl();
    if (!base) return { results: [], complete: false };
    const pages = Math.max(1, opts.pages ?? DEFAULT_PAGES);

    const all: SearxResult[] = [];
    for (let pageno = 1; pageno <= pages; pageno++) {
        const { ok, results } = await fetchPage(base, query, pageno, opts);
        if (!ok) return { results: all, complete: false }; // transient failure — possibly truncated
        if (results.length === 0) break; // genuine exhaustion
        all.push(...results);
    }
    return { results: all, complete: true };
}
