/**
 * Sticky per-account proxy (§3). LinkedIn flags rotating IPs as an obvious
 * automation signal, so each account must always exit from the SAME residential/5G
 * IP. The base credential lives ONLY in the ROTATING_5G_PROXY secret env (never in
 * DB / client / image); the per-account sticky session id is injected into the
 * proxy username so the upstream provider pins one egress IP per session.
 *
 * One ProxyAgent is cached per account for its lifetime so the keep-alive pool
 * (and thus the sticky IP) survives across requests. Pass the returned agent as the
 * `dispatcher` option to native fetch (or `{ dispatcher }` to undici.request) in the
 * Faz-1/2 ServerLinkedInClient.
 *
 * NOTE (VERIFY live at Faz 1): the sticky-session token syntax is provider-specific
 * (`-session-`, `-sessid-`, `-session:`…). Confirm against ONE real 5G provider
 * before the first voyager call.
 */
import { ProxyAgent } from 'undici';

const agents = new Map<string, ProxyAgent>();

export function proxyAgentFor(proxySessionId: string): ProxyAgent {
    const cached = agents.get(proxySessionId);
    if (cached) return cached;

    const base = process.env.ROTATING_5G_PROXY;
    if (!base) throw new Error('ROTATING_5G_PROXY not configured');
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

    const agent = new ProxyAgent(uri);
    agents.set(proxySessionId, agent);
    return agent;
}

/** Mint a new sticky session id for a freshly captured account. */
export function newProxySessionId(): string {
    return `li_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
