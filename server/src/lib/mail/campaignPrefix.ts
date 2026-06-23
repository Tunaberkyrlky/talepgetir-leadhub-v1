/**
 * Campaign → tenant assignment by name prefix.
 *
 * Assignment is fully prefix-driven: a campaign belongs to the tenant whose
 * configured prefix the campaign name starts with (e.g. "NTR - Asia" → the tenant
 * that owns "NTR"). Pure helpers only — DB access lives in replyImport.ts.
 */

export interface PrefixRule {
    tenant_id: string;
    prefix: string;
}

/** Leading alphanumeric run of a name, uppercased. "NT-GOOGLE-1" → "NT", "NTR - x" → "NTR". */
export function leadingPrefix(name: string | null | undefined): string {
    const m = (name ?? '').trim().toUpperCase().match(/^[A-Z0-9]+/);
    return m ? m[0] : '';
}

/** A char that can't be part of a prefix token (separator or end). */
function isBoundary(ch: string | undefined): boolean {
    return ch === undefined || !/[A-Z0-9]/.test(ch);
}

/**
 * Resolve which tenant a campaign name maps to, given the rule set.
 * A rule matches when the (uppercased) name starts with its prefix AND the next
 * char is a separator/end (so "NT" matches "NT-GOOGLE" but not "NTR-…"). The
 * longest matching prefix wins, so a specific "NTR" rule beats a generic "NT" one.
 * Returns null when nothing matches (campaign stays unassigned).
 */
export function matchTenant(name: string | null | undefined, rules: PrefixRule[]): string | null {
    const n = (name ?? '').trim().toUpperCase();
    if (!n) return null;
    let best: PrefixRule | null = null;
    let bestLen = -1;
    for (const r of rules) {
        const p = r.prefix.trim().toUpperCase();
        if (!p) continue;
        if (n.startsWith(p) && isBoundary(n[p.length]) && p.length > bestLen) {
            best = r;
            bestLen = p.length;
        }
    }
    return best?.tenant_id ?? null;
}
