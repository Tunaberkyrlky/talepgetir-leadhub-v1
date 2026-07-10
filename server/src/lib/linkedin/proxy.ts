/**
 * Sticky per-account proxy (§3). LinkedIn flags rotating IPs as an obvious automation
 * signal, so each account must always exit from the SAME residential/5G IP. The base
 * credential lives ONLY in the ROTATING_5G_PROXY secret env (never in DB / client /
 * image); the per-account sticky session id is injected into the proxy username so the
 * upstream provider pins one egress IP per session.
 *
 * One ProxyAgent is cached per account so its keep-alive pool (and thus the sticky IP)
 * survives across requests. The cache is BOUNDED and closes evicted agents — each agent
 * owns a socket pool, so an unbounded map would leak FDs in a long-lived worker.
 */
import { ProxyAgent } from 'undici';

const MAX_AGENTS = 200;
const agents = new Map<string, ProxyAgent>();

// DataImpulse sticky-session TTL in minutes. Docs: sessid pins one IP; the rotation
// interval (sessttl) ranges 1-120 with a 30-min default. We use the MAX (120) so an
// account holds its egress IP as long as the provider allows before an unavoidable
// residential rotation. Verified live: WITHOUT a ttl the same sessid dropped its IP in
// ~4 min (the residential device went offline); the max ttl minimizes that churn.
const SESS_TTL_MIN = 120;

/** Lowercase ISO-3166-1 alpha-2, or null. Free-text geo (e.g. "Germany") is rejected so
 *  we never build a cr.<garbage> that could fail auth — only a clean 2-letter code opts in. */
function normalizeCountry(country?: string | null): string | null {
    if (!country) return null;
    const c = String(country).trim().toLowerCase();
    return /^[a-z]{2}$/.test(c) ? c : null;
}

/**
 * Sticky per-account proxy agent. `proxySessionId` pins one egress IP to this account (never
 * per-request rotation — that is LinkedIn's #1 automation flag). An optional ISO-2 country
 * geo-locks the session so that when the residential IP does rotate it stays IN-country
 * (a Turkish account must never suddenly egress from another country). validate and every
 * send MUST pass the SAME country so they share one IP — else the health probe and the
 * writes would exit from different addresses.
 */
export function proxyAgentFor(proxySessionId: string, country?: string | null): ProxyAgent {
    const cc = normalizeCountry(country);
    // Country is part of the session identity: a different cc yields a different IP, so it
    // must key the cache too (else a geo change would reuse the wrong-country agent).
    const cacheKey = cc ? `${proxySessionId}|${cc}` : proxySessionId;
    const cached = agents.get(cacheKey);
    if (cached) return cached;

    const raw = process.env.ROTATING_5G_PROXY;
    if (!raw) throw new Error('ROTATING_5G_PROXY not configured');
    // Providers commonly hand out the credential as bare USER:PASS@host:port with no
    // scheme; new URL() would then read the first token as the scheme and drop the
    // credentials. Default to http:// when no scheme is present (same as the SearXNG
    // proxy entrypoint), so both forms work.
    const base = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
    // Parse with the URL constructor (robust against ':'/'@' inside the password, which a
    // hand-rolled regex mis-splits). Inject the sticky session into the username so the
    // provider pins one egress IP per account. Form: http(s)://USER:PASS@host:port
    let url: URL;
    try {
        url = new URL(base);
    } catch {
        throw new Error('ROTATING_5G_PROXY must be a valid http://USER:PASS@host:port URL');
    }
    if (!url.username || !url.password || !url.host) {
        throw new Error('ROTATING_5G_PROXY must include USER:PASS@host:port');
    }
    // DataImpulse username params (verified live against the real gateway, 2026-07-09):
    // `login__[cr.<cc>;]sessid.<id>;sessttl.<min>`. sessid → same IP; sessttl.120 → hold it
    // the max window; cr → geo-lock. The Bright-Data-style `-session-<id>` is rejected 407.
    // Keep the id alphanumeric-safe for the `;`/`.` grammar.
    const stickyId = proxySessionId.replace(/[^A-Za-z0-9]/g, '');
    const params = cc ? [`cr.${cc}`] : [];
    params.push(`sessid.${stickyId}`, `sessttl.${SESS_TTL_MIN}`);
    const uri = `${url.protocol}//${url.username}__${params.join(';')}:${url.password}@${url.host}`;

    // Bound the cache: close + evict the oldest (insertion order) when at capacity.
    if (agents.size >= MAX_AGENTS) {
        const oldest = agents.keys().next().value;
        if (oldest !== undefined) disposeProxyAgent(oldest);
    }

    const agent = new ProxyAgent(uri);
    agents.set(cacheKey, agent);
    return agent;
}

/** Remove + close an account's cached agent(s) (call on proxy rotation / account delete).
 *  Accepts either an exact cache key (LRU eviction passes one) OR a bare proxySessionId —
 *  in the latter case it also removes every geo-qualified `sessionId|cc` variant, so a
 *  rotation/delete can't leave a stale agent (with old creds/IP) alive under a country key. */
export function disposeProxyAgent(keyOrSessionId: string): void {
    const prefix = `${keyOrSessionId}|`;
    for (const key of [...agents.keys()]) {
        if (key !== keyOrSessionId && !key.startsWith(prefix)) continue;
        const a = agents.get(key);
        agents.delete(key);
        if (a) Promise.resolve(a.close()).catch(() => { /* best-effort */ });
    }
}

/** Mint a new sticky session id for a freshly captured account. */
export function newProxySessionId(): string {
    return `li_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
