/**
 * Shared HTML → plain-text conversion.
 *
 * Used wherever a stored/exported email body needs to be flattened to readable
 * text (campaign-send hydration, statistics export). Decodes numeric and common
 * named HTML entities; turns block-level tags into newlines; collapses runs of
 * whitespace.
 */

/**
 * Resolve a numeric HTML entity to a character. Returns '' for NUL (Postgres TEXT
 * columns reject it) and for out-of-range/invalid code points (String.fromCodePoint
 * throws RangeError above 0x10FFFF) so a malformed entity can never crash the parse.
 */
function safeCodePoint(code: number): string {
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
    try {
        return String.fromCodePoint(code);
    } catch {
        return '';
    }
}

/** Decode the HTML entities that show up in email bodies (numeric + common named). */
export function decodeHtmlEntities(s: string): string {
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
        .replace(/&nbsp;/gi, ' ')
        .replace(/&mdash;/gi, '—')
        .replace(/&ndash;/gi, '–')
        .replace(/&hellip;/gi, '…')
        .replace(/&lsquo;/gi, '‘')
        .replace(/&rsquo;/gi, '’')
        .replace(/&ldquo;/gi, '“')
        .replace(/&rdquo;/gi, '”')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&'); // amp last to avoid double-decoding
}

/** Best-effort HTML → plain text. Returns '' for empty/nullish input. */
export function htmlToPlainText(html: string | null | undefined): string {
    if (!html) return '';
    return decodeHtmlEntities(
        html
            .replace(/\r\n/g, '\n')
            .replace(/<\s*br\s*\/?>/gi, '\n')
            .replace(/<\s*\/\s*(p|div|tr|li|h[1-6])\s*>/gi, '\n')
            .replace(/<[^>]+>/g, ''),
    )
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}
