/**
 * Canonical company identity (engine, Y1+).
 *
 * canonical_key is THE dedup + billing unit (migration 060): one charge per unique
 * canonical company per tenant, ever. The DB only enforces uniqueness; the key itself is
 * computed here, in Node, where a real public-suffix list (tldts, offline) is available.
 *
 *   • with a domain  → registrable domain (eTLD+1), lowercased, no "www."
 *                      (so www / sub.acme.com / acme.com all collapse to "acme.com";
 *                       multi-level suffixes like .com.tr / .co.uk resolve correctly —
 *                       critical for Turkish exporters' buyers)
 *   • domainless     → "name:" + normalized(name) + "|" + normalized(country) + "|" + city
 *
 * NOTE (intentional domainless lossiness, per 060): two genuinely different domainless
 * firms that share a normalized name + country + city collapse to one key (deduped + billed
 * once). Folding city in reduces — but cannot eliminate — false merges; that is accepted.
 */
import { parse } from 'tldts';

// Ligatures / special letters that NFKD does NOT decompose (ß has no canonical decomposition).
// Without this, "Großhändler" and "Grosshändler" — the same firm — would yield DIFFERENT keys
// and dedup/bill twice. Applied before the diacritic strip.
const TRANSLIT: Record<string, string> = {
    ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', þ: 'th', ł: 'l', ı: 'i',
};

/** Lowercase, transliterate ligatures, strip diacritics, drop punctuation → single-spaced
 *  tokens. Stable + locale-free: the SAME firm spelled with or without accents/ligatures maps
 *  to ONE key. */
export function normalizeText(input: string | null | undefined): string {
    if (!input) return '';
    return input
        .toLowerCase()
        .replace(/[ßæœøđðþłı]/g, (c) => TRANSLIT[c] ?? c)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '') // strip combining accents
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/**
 * Registrable domain (eTLD+1), lowercased, no "www.". Accepts a bare domain, a host, or a
 * full URL. Returns null when there is no valid ICANN registrable domain (e.g. an IP, a
 * localhost, or junk) — the caller then falls back to the domainless key.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
    if (!input) return null;
    const raw = input.trim().toLowerCase();
    if (!raw) return null;
    // tldts parses hosts or URLs; allowPrivateDomains=false keeps us on the ICANN boundary
    // (so e.g. *.github.io collapses to github.io, not the user subdomain — fine for firms).
    const r = parse(raw, { allowPrivateDomains: false });
    if (!r.domain || !r.isIcann) return null;
    return r.domain;
}

export interface CanonicalInput {
    domain?: string | null;
    website?: string | null;
    name?: string | null;
    country?: string | null;
    city?: string | null;
}

/**
 * Compute the canonical_key for a company candidate. Prefers the registrable domain; falls
 * back to a name|country|city identity for domainless map/list hits. Throws if neither a
 * usable domain nor a name is available (a candidate with no identity can't be deduped/billed
 * and must be dropped upstream).
 */
export function canonicalKey(input: CanonicalInput): string {
    const domain = normalizeDomain(input.domain) ?? normalizeDomain(input.website);
    if (domain) return domain;

    const name = normalizeText(input.name);
    if (!name) {
        throw new Error('canonicalKey: candidate has neither a resolvable domain nor a name');
    }
    const country = normalizeText(input.country);
    const city = normalizeText(input.city);
    return `name:${name}|${country}|${city}`;
}

/** True when this candidate resolves to a real registrable domain (vs a domainless key). */
export function hasDomain(input: CanonicalInput): boolean {
    return (normalizeDomain(input.domain) ?? normalizeDomain(input.website)) !== null;
}
