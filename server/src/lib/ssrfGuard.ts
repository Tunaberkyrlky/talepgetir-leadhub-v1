/**
 * SSRF guard for user-supplied outbound connection targets (SMTP/IMAP hosts).
 *
 * A tenant can type any host into the SMTP/IMAP connection form, and the server
 * opens an outbound TCP connection to verify it. Without this guard a tenant
 * could point us at internal addresses (127.0.0.1, 10.x, 169.254.169.254 cloud
 * metadata, …) and use connect success/failure as an internal port scanner.
 *
 * We resolve the host and reject any address that falls in a private, loopback,
 * link-local, or otherwise non-public range. Every resolved address is checked
 * (a hostname can resolve to several A/AAAA records).
 */

import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { AppError } from '../middleware/errorHandler.js';

function isBlockedIPv4(ip: string): boolean {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0) return true;                       // 0.0.0.0/8 "this host"
    if (a === 10) return true;                      // private
    if (a === 127) return true;                     // loopback
    if (a === 169 && b === 254) return true;        // link-local (incl. 169.254.169.254 metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;        // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true;                       // multicast + reserved
    return false;
}

function isBlockedIPv6(ip: string): boolean {
    const addr = ip.toLowerCase();
    if (addr === '::1' || addr === '::') return true;       // loopback / unspecified
    if (addr.startsWith('fe80')) return true;               // link-local
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique-local fc00::/7
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (mapped) return isBlockedIPv4(mapped[1]);
    return false;
}

function isBlockedIp(ip: string): boolean {
    const version = isIP(ip);
    if (version === 4) return isBlockedIPv4(ip);
    if (version === 6) return isBlockedIPv6(ip);
    return true; // not a parseable IP → refuse
}

export interface PinnedHost {
    /**
     * Validated public IP literal to dial. Connect to THIS, not the hostname,
     * so DNS cannot be re-resolved to an internal address after the check
     * (closes the DNS-rebinding / TOCTOU window between check and connect).
     */
    address: string;
    /** Original hostname, kept for TLS SNI / certificate validation. */
    servername: string;
}

/**
 * Resolve `host`, reject it if ANY resolved address is internal/non-public, and
 * return a public IP to connect to (pinned) plus the original hostname for SNI.
 * Accepts a literal IP or a hostname.
 */
export async function resolvePublicHost(host: string): Promise<PinnedHost> {
    if (isIP(host)) {
        if (isBlockedIp(host)) throw new AppError('Host is not allowed', 400);
        return { address: host, servername: host };
    }

    let addresses: { address: string }[];
    try {
        addresses = await lookup(host, { all: true });
    } catch {
        throw new AppError('Host could not be resolved', 400);
    }
    if (!addresses.length) throw new AppError('Host could not be resolved', 400);

    for (const { address } of addresses) {
        if (isBlockedIp(address)) throw new AppError('Host is not allowed', 400);
    }
    // Every resolved address is public — pin the first one as the dial target.
    return { address: addresses[0].address, servername: host };
}

/**
 * Throw if `host` is an internal/non-public address (or cannot be resolved).
 * Accepts a literal IP or a hostname; hostnames are resolved to all addresses.
 */
export async function assertPublicHost(host: string): Promise<void> {
    await resolvePublicHost(host);
}
