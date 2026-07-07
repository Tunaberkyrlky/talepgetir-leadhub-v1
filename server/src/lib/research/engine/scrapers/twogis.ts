/**
 * 2GIS scraper (engine, Y1+ — M2). The maps-discovery backend for the CIS (RU/KZ/UZ/BY/KG/AZ),
 * where 2GIS/Yandex out-cover Google Maps for local firms. A thin config over the shared
 * HTTP-scraper factory (httpScraper.ts) — talks to the self-hosted `twogis` service
 * (RESEARCH_TWOGIS_URL=http://twogis.railway.internal:8080, see infra/twogis/) which exposes the
 * SAME Gosom-compatible REST job contract but is backed by the 2GIS Catalog API (name + website +
 * phone + address). Routed by geography in scrapers/index.ts (CIS → twogis when configured).
 */
import { createHttpMapsScraper } from './httpScraper.js';
import type { ScrapeOptions } from './types.js';

// 2GIS is a Russian/CIS directory — default the listing language to Russian (the twogis service
// still accepts a per-request lang override for KZ/UZ/etc).
const DEFAULT_LANG = process.env.RESEARCH_TWOGIS_LANG || 'ru';

/** Base URL of the 2GIS service, or null when unconfigured (CIS then falls back to Gosom). */
export function twogisBaseUrl(): string | null {
    const u = process.env.RESEARCH_TWOGIS_URL?.trim();
    return u ? u.replace(/\/+$/, '') : null;
}

function buildTwogisBody(keywords: string[], opts: ScrapeOptions): Record<string, unknown> {
    return {
        name: `tg-research ${new Date().toISOString().slice(0, 19)}`,
        keywords,
        lang: opts.lang ?? DEFAULT_LANG,
        // The twogis service reads its own 2GIS Catalog API key + page depth from env; no
        // Google-Maps-specific fields (zoom/radius) apply here.
    };
}

export const twogisScraper = createHttpMapsScraper({
    name: 'twogis',
    baseUrl: twogisBaseUrl,
    buildSubmitBody: buildTwogisBody,
    defaults: {
        pollMs: Number(process.env.RESEARCH_TWOGIS_POLL_MS) || undefined,
        maxWaitMs: Number(process.env.RESEARCH_TWOGIS_MAX_WAIT_MS) || undefined,
        maxResults: Number(process.env.RESEARCH_TWOGIS_MAX_RESULTS) || undefined,
        httpTimeoutMs: Number(process.env.RESEARCH_TWOGIS_HTTP_TIMEOUT_MS) || undefined,
    },
});
