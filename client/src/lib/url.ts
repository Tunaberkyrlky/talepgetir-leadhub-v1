/**
 * Normalises a user-supplied URL string to a safe, absolute https URL.
 *
 * - Prepends "https://" when no scheme is present
 * - Rejects non-http(s) schemes (javascript:, data:, etc.)
 * - Returns null for invalid or empty input
 *
 * Use this before rendering any user-supplied URL as an <a href>.
 */
export function safeUrl(input: string | null | undefined): string | null {
    if (!input || !input.trim()) return null;
    try {
        const raw = input.trim();
        const urlStr = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        const parsed = new URL(urlStr);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return parsed.toString();
    } catch {
        return null;
    }
}
