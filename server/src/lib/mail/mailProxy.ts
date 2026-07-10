/**
 * Mail proxy selection.
 *
 * Yandex refuses SMTP/IMAP connections from many datacenter IP ranges (incl.
 * Railway) — the connection times out at CONNECT (ETIMEDOUT, command CONN).
 * Routing Yandex traffic through an external SOCKS5 proxy on a clean-IP VPS
 * bypasses this. See plans/MAIL_ARCHITECTURE.md.
 *
 * Config: MAIL_PROXY_URL, e.g. socks5://user:pass@host:port. Applied ONLY to
 * Yandex hosts (smtp/imap.yandex.com/.ru), so every other provider stays direct.
 * When MAIL_PROXY_URL is unset, this returns undefined everywhere → behaviour is
 * exactly as before (zero risk).
 */
export function proxyUrlForHost(host: string | null | undefined): string | undefined {
    const url = process.env.MAIL_PROXY_URL?.trim();
    if (!url || !host) return undefined;
    return host.toLowerCase().includes('yandex') ? url : undefined;
}
