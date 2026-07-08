/**
 * Page fetch with cache (engine, Y1+). Fetches a candidate's homepage/about text for the
 * validator. Uses research_page_cache (060) — cross-tenant like research_search_cache, since it
 * holds only raw public-web content (no tenant data, D12). A URL fetched once is never re-fetched
 * while the cache entry is fresh.
 *
 * Primary path: Jina Reader (https://r.jina.ai/<url>) returns clean, JS-rendered markdown — far
 * better signal-per-token than raw HTML, and it fetches on Jina's infra (so it is NOT an SSRF
 * vector into our network). Fallback: a guarded direct fetch (raw HTML, crudely de-tagged) when
 * Jina errors.
 *
 * SSRF: the candidate "domain" is LLM-extracted from untrusted web content, so the DIRECT-fetch
 * path resolves DNS and refuses private/reserved/loopback/link-local/metadata addresses, follows
 * redirects MANUALLY and re-validates every hop, and streams the body under a hard byte cap so a
 * hostile/huge response can't exhaust memory.
 */
import { createHash } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { researchSupabaseAdmin } from '../supabase.js';
import { createLogger } from '../../logger.js';

const log = createLogger('research:engine:fetch');

const CACHE_TTL_DAYS = Number(process.env.RESEARCH_PAGE_CACHE_TTL_DAYS ?? 30);
const MAX_CONTENT_CHARS = Number(process.env.RESEARCH_PAGE_MAX_CHARS ?? 12_000);
const MAX_DOWNLOAD_BYTES = Number(process.env.RESEARCH_PAGE_MAX_BYTES ?? 2_000_000); // 2 MB hard cap
const FETCH_TIMEOUT_MS = Number(process.env.RESEARCH_FETCH_TIMEOUT_MS ?? 20_000);
const MAX_REDIRECTS = 4;

export type FetchMethod = 'cache' | 'jina' | 'fetch' | 'error';

export interface PageResult {
    url: string;
    content: string;
    status: number;
    method: FetchMethod;
    cacheHit: boolean;
    /** True when a real network call was made (false for a cache hit) — drives cap accounting. */
    networkCall: boolean;
}

function sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

/**
 * Normalize a raw domain/URL to the canonical fetch URL. The page-cache key is sha256(pageUrl(x)),
 * so fetchPage and cachedPageContent MUST derive it the same way — keep this the single source.
 */
function pageUrl(rawUrl: string): string {
    return rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
}

// Store/return split (WP3): the CACHE keeps up to STORE_MAX_CHARS so long list pages
// (directory/member lists — the Y1 channel harvest input) survive intact, while every
// caller still RECEIVES the tight default budget unless it explicitly asks for more.
// Validation reads are unchanged: default return clip = MAX_CONTENT_CHARS as before.
const STORE_MAX_CHARS = Number(process.env.RESEARCH_PAGE_STORE_MAX_CHARS ?? 48_000);

function clip(s: string, max = MAX_CONTENT_CHARS): string {
    return s.length > max ? s.slice(0, max) : s;
}

function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Reject loopback / private / link-local / CGNAT / unspecified / IPv6-ULA + mapped equivalents. */
function isPrivateIp(ip: string): boolean {
    const v = isIP(ip);
    if (v === 4) {
        const p = ip.split('.').map(Number);
        if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
        const [a, b] = p;
        if (a === 10) return true;
        if (a === 127) return true; // loopback
        if (a === 0) return true; // unspecified
        if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254.169.254
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
        if (a >= 224) return true; // multicast/reserved
        return false;
    }
    if (v === 6) {
        const ip6 = ip.toLowerCase();
        if (ip6 === '::1' || ip6 === '::') return true;
        if (ip6.startsWith('fe80') || ip6.startsWith('fc') || ip6.startsWith('fd')) return true; // link-local + ULA
        const mapped = ip6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
        if (mapped) return isPrivateIp(mapped[1]);
        return false;
    }
    return true; // not a parseable IP → refuse
}

/** Resolve every A/AAAA for the host and refuse if ANY is private/reserved (anti-DNS-rebinding). */
async function assertPublicHost(hostname: string): Promise<void> {
    if (isIP(hostname)) {
        if (isPrivateIp(hostname)) throw new Error(`blocked private/reserved address ${hostname}`);
        return;
    }
    const addrs = await lookup(hostname, { all: true });
    if (addrs.length === 0) throw new Error(`no DNS records for ${hostname}`);
    for (const a of addrs) {
        if (isPrivateIp(a.address)) throw new Error(`host ${hostname} resolves to private address ${a.address}`);
    }
}

/** Read a response body as text, aborting once MAX_DOWNLOAD_BYTES is exceeded (bounded memory). */
async function readCapped(resp: Response): Promise<string> {
    const body = resp.body;
    if (!body) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                total += value.length;
                chunks.push(value);
                if (total >= MAX_DOWNLOAD_BYTES) break;
            }
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

async function fromCache(urlHash: string): Promise<PageResult | null> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_page_cache')
        .select('url, content, status, expires_at')
        .eq('url_hash', urlHash)
        .maybeSingle();
    if (error) {
        log.warn({ err: error }, 'page cache read failed (non-fatal)');
        return null;
    }
    if (!data || !data.content) return null;
    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return null;
    return { url: data.url, content: data.content, status: data.status ?? 200, method: 'cache', cacheHit: true, networkCall: false };
}

async function writeCache(url: string, urlHash: string, content: string, status: number, method: FetchMethod): Promise<void> {
    const expires = new Date(Date.now() + CACHE_TTL_DAYS * 86_400_000).toISOString();
    const { error } = await researchSupabaseAdmin
        .from('research_page_cache')
        .upsert(
            {
                url_hash: urlHash,
                url,
                status,
                fetch_method: method,
                content,
                content_hash: sha256(content),
                fetched_at: new Date().toISOString(),
                expires_at: expires,
            },
            { onConflict: 'url_hash' }
        );
    if (error) log.warn({ err: error, url }, 'page cache write failed (non-fatal)');
}

/** SSRF-guarded direct fetch with manual redirects. Returns null on any block/failure. */
async function guardedDirectFetch(startUrl: string): Promise<{ content: string; status: number } | null> {
    let current = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let u: URL;
        try {
            u = new URL(current);
        } catch {
            return null;
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        try {
            await assertPublicHost(u.hostname);
        } catch (err) {
            log.warn({ url: current, err: err instanceof Error ? err.message : String(err) }, 'SSRF guard blocked host');
            return null;
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        let resp: Response;
        try {
            resp = await fetch(current, {
                redirect: 'manual',
                signal: ctrl.signal,
                headers: { 'User-Agent': 'Mozilla/5.0 (TG-Research/1.0)' },
            });
        } catch {
            clearTimeout(timer);
            return null;
        }
        clearTimeout(timer);

        if (resp.status >= 300 && resp.status < 400) {
            const loc = resp.headers.get('location');
            if (!loc) return null;
            current = new URL(loc, current).toString(); // re-validated next loop iteration
            continue;
        }
        if (resp.status < 200 || resp.status >= 300) {
            return { content: '', status: resp.status }; // non-2xx → no usable content
        }
        const text = clip(htmlToText(await readCapped(resp)), STORE_MAX_CHARS);
        return { content: text, status: resp.status };
    }
    return null; // too many redirects
}

/**
 * Fetch a page's text, cache-first. Never throws — on any failure returns method='error' with
 * empty content (the caller records 'review' WITHOUT spending an LLM call).
 * opts.maxChars raises the RETURN budget (bounded by STORE_MAX_CHARS) for callers that need a
 * long list page (Y1 channel harvest); the default stays the tight validation budget. The cache
 * stores the long text either way, so a later long-budget read of a page first fetched for
 * validation may still be short — acceptable staleness (TTL bounds it).
 */
export async function fetchPage(rawUrl: string, opts?: { maxChars?: number }): Promise<PageResult> {
    const budget = Math.min(Math.max(1, opts?.maxChars ?? MAX_CONTENT_CHARS), STORE_MAX_CHARS);
    const url = pageUrl(rawUrl);
    const urlHash = sha256(url);

    const cached = await fromCache(urlHash);
    if (cached) {
        // A long-budget read of a row cached under the OLD short clip (pre-split, or first
        // fetched for validation) would silently hand the caller a quarter of the page for the
        // whole TTL — refetch instead when the row is plausibly a short-stored copy. Genuinely
        // short pages re-fetch once per long-budget read (rare, explicit harvests) — acceptable.
        const shortStored = budget > MAX_CONTENT_CHARS && cached.content.length <= MAX_CONTENT_CHARS;
        if (!shortStored) return { ...cached, content: clip(cached.content, budget) };
    }

    // Primary: Jina Reader (clean markdown; fetches on Jina's infra — not an SSRF vector for us).
    try {
        const headers: Record<string, string> = { 'X-Return-Format': 'markdown' };
        if (process.env.JINA_KEY) headers.Authorization = `Bearer ${process.env.JINA_KEY}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        const resp = await fetch(`https://r.jina.ai/${url}`, { headers, signal: ctrl.signal }).finally(() => clearTimeout(timer));
        if (resp.ok) {
            const text = clip((await readCapped(resp)).trim(), STORE_MAX_CHARS);
            if (text) {
                await writeCache(url, urlHash, text, resp.status, 'jina');
                return { url, content: clip(text, budget), status: resp.status, method: 'jina', cacheHit: false, networkCall: true };
            }
        } else {
            log.warn({ url, status: resp.status }, 'jina reader non-ok; falling back to guarded direct fetch');
        }
    } catch (err) {
        log.warn({ url, err: err instanceof Error ? err.message : String(err) }, 'jina reader failed; falling back');
    }

    // Fallback: SSRF-guarded direct fetch.
    const direct = await guardedDirectFetch(url);
    if (direct && direct.content) {
        await writeCache(url, urlHash, direct.content, direct.status, 'fetch');
        return { url, content: clip(direct.content, budget), status: direct.status, method: 'fetch', cacheHit: false, networkCall: true };
    }
    return { url, content: '', status: direct?.status ?? 0, method: 'error', cacheHit: false, networkCall: true };
}

/**
 * Read cached page text for a domain WITHOUT any network call (cross-ICP re-score path). Returns the
 * fresh cached content, or null when there is no fresh entry (expired/evicted/never fetched). Uses
 * the SAME url normalization + hash as fetchPage, so a page fetched during any prior discovery is
 * found here — re-scoring an existing firm under a new ICP costs zero fetch (only a validate call).
 */
export async function cachedPageContent(domain: string): Promise<string | null> {
    const cached = await fromCache(sha256(pageUrl(domain)));
    const content = cached?.content?.trim() || null;
    // Same return budget as a default fetchPage read — the cache may hold the longer stored copy.
    return content ? clip(content) : null;
}
