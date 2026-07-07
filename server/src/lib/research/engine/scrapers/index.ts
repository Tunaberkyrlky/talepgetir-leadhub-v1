/**
 * Maps-scraper registry + geography routing (engine, Y1+).
 *
 * A maps scrape is routed to a backend by geography: Google Maps (Gosom) for the West, and 2GIS for
 * the CIS (RU/KZ/UZ/BY/KG/AZ), where 2GIS/Yandex out-cover Google Maps for local firms. Both speak
 * the same Gosom-compatible REST contract (httpScraper.ts), so routing is a one-line pick. Every
 * backend self-guards on its own URL env, so a pick for an unconfigured backend yields no candidates
 * (never throws), and CIS falls back to Gosom until the 2GIS service is deployed.
 */
import { gosomScraper, gosomBaseUrl } from './gosom.js';
import { twogisScraper, twogisBaseUrl } from './twogis.js';
import type { MapsScraper } from './types.js';

export type { MapsBusiness, MapsScraper, ScrapeOptions } from './types.js';
export { gosomScraper, gosomBaseUrl, twogisScraper, twogisBaseUrl };

// CIS geographies where 2GIS/Yandex beat Google Maps for local-firm coverage. Matched
// case-insensitively against the free-text geography by COUNTRY NAME (EN + Cyrillic). Bare ISO-2
// codes (az/by/am/kg…) are deliberately NOT matched — they collide with US state codes
// ("Phoenix, AZ") and common English words ("by", "am"), which would misroute a Western geography
// to 2GIS. Routes these to the 2GIS backend when it is configured.
const CIS_PATTERNS: RegExp[] = [
    /\brussia\b/i, /\bросси/i, /\bkazakh/i, /\bказах/i, /\buzbek/i, /\bузбек/i,
    /\bbelarus\b/i, /\bбелар/i, /\bkyrgyz/i, /\bкыргыз/i, /\bkyrgyzstan\b/i, /\bazerbaijan\b/i, /\bазербай/i,
    /\btajik/i, /\bturkmen/i, /\barmenia\b/i, /\bмосква\b/i, /\bmoscow\b/i,
];

/** True when the geography reads as a CIS country/region (best-effort; used for 2GIS routing). */
export function isCisGeography(geography: string): boolean {
    const g = geography.trim();
    return g.length > 0 && CIS_PATTERNS.some((re) => re.test(g));
}

/**
 * Pick the maps backend for a geography. CIS → 2GIS when the `twogis` service is configured
 * (RESEARCH_TWOGIS_URL set); otherwise Gosom/Google Maps (which still has partial CIS coverage, so
 * a CIS run without the 2GIS service degrades rather than yielding nothing). Every backend
 * self-guards on its own URL env.
 */
export function pickMapsBackend(geography: string): MapsScraper {
    if (isCisGeography(geography) && twogisBaseUrl()) return twogisScraper;
    return gosomScraper;
}
