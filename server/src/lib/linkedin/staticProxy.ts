/**
 * TG-LinkedIn — static dedicated proxy import (P0).
 *
 * Operator hands a verified `host:port:user:pass` to a SERVER-SIDE internal route (never a
 * client paste — that leaks plaintext creds + enables SSRF; codex §9-P1.18). Here we:
 *   1. SSRF-guard the host: resolve it and reject private/loopback/link-local/metadata targets
 *      so a compromised operator can't point the worker at internal endpoints.
 *   2. Echo-verify the real egress: connect THROUGH the proxy to two independent IP echoes,
 *      require a stable public IP, capture it (+country) — provider metadata is not proof
 *      of what LinkedIn sees (codex §9-P2.24).
 *   3. Refuse a burned exit IP, encrypt the creds, and atomically import+assign via RPC.
 */
import { request } from 'undici';
import dns from 'node:dns/promises';
import net from 'node:net';
import { researchSupabaseAdmin } from '../research/supabase.js';
import { proxyAgentForStatic, disposeProxyAgent } from './proxy.js';
import { encryptProxySecret } from './crypto.js';
import { createLogger } from '../logger.js';

const log = createLogger('linkedin:static-proxy');

const ECHO_URLS = ['https://api.ipify.org', 'https://ifconfig.me/ip'];
const GEO_URL = (ip: string) => `https://ipwho.is/${ip}?fields=country_code,success`;

/** True for IPs we must never let the worker dial (SSRF / metadata protection). */
function isForbiddenIp(ip: string): boolean {
    const v = net.isIP(ip);
    if (v === 4) {
        const p = ip.split('.').map(Number);
        if (p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
        const [a, b] = p;
        if (a === 10 || a === 127 || a === 0) return true;                 // private / loopback / this-host
        if (a === 169 && b === 254) return true;                           // link-local + cloud metadata 169.254.169.254
        if (a === 172 && b >= 16 && b <= 31) return true;                  // private
        if (a === 192 && b === 168) return true;                           // private
        if (a === 100 && b >= 64 && b <= 127) return true;                 // CGNAT
        if (a >= 224) return true;                                         // multicast / reserved
        return false;
    }
    if (v === 6) {
        const lo = ip.toLowerCase();
        if (lo === '::1' || lo === '::') return true;                      // loopback / unspecified
        if (lo.startsWith('fe80')) return true;                            // link-local
        if (lo.startsWith('fc') || lo.startsWith('fd')) return true;       // unique-local
        if (lo.startsWith('ff')) return true;                             // multicast
        if (lo.startsWith('::ffff:')) return isForbiddenIp(lo.slice(7));   // v4-mapped
        return false;
    }
    return true; // not a valid IP literal
}

/** Resolve the host and reject if it (or any resolved address) is a forbidden target. */
async function assertPublicHost(host: string): Promise<void> {
    const h = host.trim();
    if (!h || h.length > 253) throw new Error('invalid_proxy_host');
    if (net.isIP(h)) {
        if (isForbiddenIp(h)) throw new Error('forbidden_proxy_host');
        return;
    }
    // hostname → resolve every A/AAAA and reject if any is private (DNS-rebinding-resistant enough
    // for an operator-only route; the echo step re-confirms a public egress afterwards).
    let addrs: { address: string }[];
    try {
        addrs = await dns.lookup(h, { all: true });
    } catch {
        throw new Error('proxy_host_unresolvable');
    }
    if (!addrs.length) throw new Error('proxy_host_unresolvable');
    for (const a of addrs) if (isForbiddenIp(a.address)) throw new Error('forbidden_proxy_host');
}

async function echoOnce(agentKey: string, host: string, port: number, user: string, pass: string, url: string): Promise<string> {
    const agent = proxyAgentForStatic(agentKey, host, port, user, pass);
    const res = await request(url, {
        method: 'GET', dispatcher: agent,
        headersTimeout: 15_000, bodyTimeout: 15_000, signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.body.text()).trim();
    if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`echo_${res.statusCode}`);
    if (!net.isIP(body)) throw new Error('echo_non_ip');
    return body;
}

export interface ProxyVerify {
    exitIp: string;
    country: string | null;
}

/**
 * Connect THROUGH the proxy to two independent echoes; require the same public IP from both
 * (a real sticky egress) and look up its country. The agent is disposed after so a failed
 * import never leaves a cached agent behind.
 */
export async function verifyProxyEgress(
    host: string, port: number, username: string, password: string,
): Promise<ProxyVerify> {
    await assertPublicHost(host);
    const agentKey = `verify:${host}:${port}:${Math.floor(Date.now() / 1000)}`;
    try {
        const ips: string[] = [];
        for (const url of ECHO_URLS) {
            // eslint-disable-next-line no-await-in-loop
            ips.push(await echoOnce(agentKey, host, port, username, password, url));
        }
        if (ips[0] !== ips[1]) throw new Error('unstable_exit_ip');
        const exitIp = ips[0];
        if (isForbiddenIp(exitIp)) throw new Error('forbidden_exit_ip');
        let country: string | null = null;
        try {
            const geo = await request(GEO_URL(exitIp), { headersTimeout: 10_000, bodyTimeout: 10_000, signal: AbortSignal.timeout(12_000) });
            const j = (await geo.body.json()) as { success?: boolean; country_code?: string };
            if (j?.success && typeof j.country_code === 'string') country = j.country_code.toLowerCase();
        } catch {
            country = null; // advisory — country lookup best-effort
        }
        return { exitIp, country };
    } finally {
        disposeProxyAgent(`static:${agentKey}`);
    }
}

export interface ImportProxyInput {
    tenantId: string;
    accountId: string;
    host: string;
    port: number;
    username: string;
    password: string;
    expectedCountry: string;      // ISO-2 the operator asserts (e.g. 'tr')
    provider?: string;
    extId?: string | null;
    planId?: string | null;
}

export interface ImportProxyResult {
    ok: boolean;
    error?: string;
    proxyId?: string;
    endpointGeneration?: number;
    exitIp?: string;
    country?: string | null;
    countryMismatch?: boolean;
}

/** SSRF-guard + echo-verify + burned-check + encrypt + atomic import/assign via RPC. */
export async function importAndAssignProxy(input: ImportProxyInput): Promise<ImportProxyResult> {
    const provider = input.provider ?? 'iproyal';
    const expected = input.expectedCountry.trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(expected)) return { ok: false, error: 'bad_country' };

    let verify: ProxyVerify;
    try {
        verify = await verifyProxyEgress(input.host, input.port, input.username, input.password);
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'verify_failed';
        log.warn({ err: msg, host: input.host }, 'proxy egress verify failed');
        return { ok: false, error: msg };
    }

    const countryMismatch = verify.country !== null && verify.country !== expected;
    if (countryMismatch) {
        // Geo must match where the account logs in — a TR account must egress from TR.
        return { ok: false, error: 'country_mismatch', exitIp: verify.exitIp, country: verify.country, countryMismatch: true };
    }

    const extId = input.extId ?? `manual:${input.host}:${input.port}`;
    const { data, error } = await researchSupabaseAdmin.rpc('linkedin_import_and_assign_proxy', {
        p_tenant: input.tenantId,
        p_account: input.accountId,
        p_provider: provider,
        p_ext_id: extId,
        p_proxy_address: input.host,
        p_exit_ip: verify.exitIp,
        p_host: input.host,
        p_port: input.port,
        p_username_enc: encryptProxySecret(input.username),
        p_password_enc: encryptProxySecret(input.password),
        p_country: expected,
        p_plan_id: input.planId ?? null,
    });
    if (error) {
        log.error({ err: error.message }, 'import_and_assign_proxy rpc failed');
        return { ok: false, error: 'rpc_failed' };
    }
    const r = data as { ok: boolean; error?: string; proxy_id?: string; endpoint_generation?: number };
    if (!r.ok) return { ok: false, error: r.error, exitIp: verify.exitIp, country: verify.country };
    return {
        ok: true, proxyId: r.proxy_id, endpointGeneration: r.endpoint_generation,
        exitIp: verify.exitIp, country: verify.country,
    };
}
