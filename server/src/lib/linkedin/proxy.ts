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

export function proxyAgentFor(proxySessionId: string): ProxyAgent {
    const cached = agents.get(proxySessionId);
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
    const uri = `${url.protocol}//${url.username}-session-${proxySessionId}:${url.password}@${url.host}`;

    // Bound the cache: close + evict the oldest (insertion order) when at capacity.
    if (agents.size >= MAX_AGENTS) {
        const oldest = agents.keys().next().value;
        if (oldest !== undefined) disposeProxyAgent(oldest);
    }

    const agent = new ProxyAgent(uri);
    agents.set(proxySessionId, agent);
    return agent;
}

/** Remove + close an account's cached agent (call on proxy rotation / account delete). */
export function disposeProxyAgent(proxySessionId: string): void {
    const a = agents.get(proxySessionId);
    if (!a) return;
    agents.delete(proxySessionId);
    Promise.resolve(a.close()).catch(() => { /* best-effort */ });
}

/** Mint a new sticky session id for a freshly captured account. */
export function newProxySessionId(): string {
    return `li_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
