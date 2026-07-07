/**
 * Gosom Google-Maps scraper (engine, Y1+). The maps-discovery backend for the West. A thin config
 * over the shared HTTP-scraper factory (httpScraper.ts) — talks to a self-hosted
 * `gosom/google-maps-scraper` in `-web` mode over Railway private DNS
 * (RESEARCH_GOSOM_URL=http://gosom.railway.internal:8080).
 */
import { createHttpMapsScraper } from './httpScraper.js';
import type { ScrapeOptions } from './types.js';

const DEFAULT_DEPTH = Number(process.env.RESEARCH_GOSOM_DEPTH) || 10;
const DEFAULT_ZOOM = Number(process.env.RESEARCH_GOSOM_ZOOM) || 15;
const DEFAULT_LANG = process.env.RESEARCH_GOSOM_LANG || 'en';
// The OpenAPI spec marks max_time optional, but the deployed v1.16.0 web API returns
// 422 "missing max time" without it. The API accepts 1-300 seconds.
const MAX_TIME_SEC = Math.min(300, Math.max(1, Number(process.env.RESEARCH_GOSOM_MAX_TIME_SEC) || 300));
const PROXIES = (process.env.RESEARCH_GOSOM_PROXIES || '').split(',').map((p) => p.trim()).filter(Boolean);

/** Base URL of the Gosom instance, or null when unconfigured (scrape yields no candidates). */
export function gosomBaseUrl(): string | null {
    const u = process.env.RESEARCH_GOSOM_URL?.trim();
    return u ? u.replace(/\/+$/, '') : null;
}

function buildGosomBody(keyword: string, opts: ScrapeOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
        keyword,
        lang: opts.lang ?? DEFAULT_LANG,
        zoom: DEFAULT_ZOOM,
        max_depth: opts.depth ?? DEFAULT_DEPTH,
        timeout: MAX_TIME_SEC,
        fast_mode: false, // fast_mode skips detail extraction (website/phone) — we NEED those
        email: false, // we run our own fetch+validate; Gosom email-mode visits every site (slow)
    };
    if (PROXIES.length > 0) body.proxies = PROXIES;
    return body;
}

export const gosomScraper = createHttpMapsScraper({
    name: 'gosom',
    baseUrl: gosomBaseUrl,
    buildSubmitBody: (keywords, opts) => buildGosomBody(keywords[0] ?? '', opts),
    buildSubmitBodies: (keywords, opts) => keywords.map((keyword) => buildGosomBody(keyword, opts)),
    submitPath: '/api/v1/scrape',
    resultsInStatus: true,
    defaults: {
        pollMs: Number(process.env.RESEARCH_GOSOM_POLL_MS) || undefined,
        maxWaitMs: Number(process.env.RESEARCH_GOSOM_MAX_WAIT_MS) || undefined,
        maxResults: Number(process.env.RESEARCH_GOSOM_MAX_RESULTS) || undefined,
        httpTimeoutMs: Number(process.env.RESEARCH_GOSOM_HTTP_TIMEOUT_MS) || undefined,
    },
});
