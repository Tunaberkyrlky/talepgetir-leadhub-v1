/**
 * Split a delimited string (or normalize an existing array) into a clean list.
 * Used for the `companies.product_services` / `product_portfolio` columns, which
 * are stored as text[]. Inbound data arrives as a single string with mixed
 * separators, e.g. "Body; face; perfumery" or "Skincare, haircare, makeup".
 *
 * Delimiters: ; , | and newlines. NOTE: "/" is intentionally NOT a delimiter —
 * real category terms contain it (e.g. "gearboxes/reducers", "fans/blowers"), and
 * splitting on it would fragment them. Each item is trimmed; empties are dropped;
 * duplicates are removed case-insensitively (the first spelling wins). Returns
 * null when nothing usable remains, so callers can store NULL (not an empty []).
 */
const SPLIT_RE = /[;,|\n]+/;

export function parseList(value: unknown): string[] | null {
    let parts: string[];
    if (Array.isArray(value)) {
        parts = value.flatMap((v) => (typeof v === 'string' ? v.split(SPLIT_RE) : []));
    } else if (typeof value === 'string') {
        parts = value.split(SPLIT_RE);
    } else {
        return null;
    }

    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of parts) {
        const item = raw.trim();
        if (!item) continue;
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out.length ? out : null;
}
