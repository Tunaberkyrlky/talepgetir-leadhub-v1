/**
 * Builds email-safe HTML attachment cards (inline CSS, table-based).
 * Compatible with Gmail, Outlook, Apple Mail.
 */

import { escapeHtml } from './htmlEscape.js';

interface AttachmentTemplate {
    label: string;
    file_type: string;
    file_url: string;
    file_size: string;
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";

function isSafeUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
}

function buildCard(t: AttachmentTemplate): string {
    const safeUrl = isSafeUrl(t.file_url) ? t.file_url : '#';
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 8px;">
  <tr><td>
    <a href="${escapeHtml(safeUrl)}" target="_blank" style="display: block; text-decoration: none; border: 1px solid #e8e8f0; border-radius: 10px; padding: 14px 16px; background: #fafafe;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td valign="middle" style="font-family: ${FONT};">
            <p style="margin: 0; font-size: 14px; font-weight: 600; color: #252540;">${escapeHtml(t.label)}</p>
            <p style="margin: 2px 0 0; font-size: 12px; color: #999999;">${escapeHtml(t.file_type.toUpperCase())}${t.file_size ? ` &bull; ${escapeHtml(t.file_size)}` : ''}</p>
          </td>
          <td width="80" valign="middle" align="right">
            <span style="font-family: ${FONT}; font-size: 12px; font-weight: 600; color: #7c3aed; background: #f5f3ff; border: 1px solid #ede9fe; border-radius: 6px; padding: 4px 10px; display: inline-block;">G&ouml;r&uuml;nt&uuml;le</span>
          </td>
        </tr>
      </table>
    </a>
  </td></tr>
</table>`;
}

/**
 * Convert a plain-text body into simple one-<p>-per-line HTML, fully escaping
 * each line (incl. &). Single source of truth for reply/forward/compose bodies.
 * Bare http(s) URLs become real <a> links so click tracking can wrap them.
 */
export function plainTextToParagraphs(text: string): string {
    return text
        .split('\n')
        .map((line) => `<p>${linkify(escapeHtml(line))}</p>`)
        .join('');
}

// Runs AFTER escapeHtml: the line contains no raw < > " ' characters, and
// &amp;/&#39; inside a URL are valid entities in an href attribute value.
function linkify(escapedLine: string): string {
    return escapedLine.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
        // Peel trailing sentence punctuation and *unbalanced* closing brackets so
        // "(see http://x.com)." doesn't swallow ")." into the href, while a
        // balanced URL like ".../Foo_(bar)" keeps its parens.
        let url = match;
        let trailing = '';
        for (;;) {
            const ch = url[url.length - 1];
            if (ch === ')' || ch === ']' || ch === '}') {
                const open = ch === ')' ? '(' : ch === ']' ? '[' : '{';
                if (url.split(open).length >= url.split(ch).length) break; // balanced → keep
            } else if (!'.,;:!?'.includes(ch)) {
                break;
            }
            url = url.slice(0, -1);
            trailing = ch + trailing;
        }
        return `<a href="${url}" target="_blank">${url}</a>${trailing}`;
    });
}

export function buildAttachmentCardsHtml(templates: AttachmentTemplate[]): string {
    if (!templates.length) return '';

    const header = `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 20px;">
  <tr><td style="font-family: ${FONT}; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #999999; padding-bottom: 10px;">Ekler</td></tr>
</table>`;

    return header + templates.map(buildCard).join('');
}
