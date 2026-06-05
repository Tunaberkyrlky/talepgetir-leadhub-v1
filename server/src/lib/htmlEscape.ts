/**
 * Shared HTML escaping for server-rendered email bodies. Single source of truth
 * so digest mails and attachment cards can't drift in what they escape.
 */

/** Escape the five HTML-significant characters for safe text-node interpolation. */
export function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
