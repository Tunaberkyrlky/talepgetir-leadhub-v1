/**
 * Builds email-safe HTML attachment cards (inline CSS, table-based).
 * Compatible with Gmail, Outlook, Apple Mail.
 */

interface AttachmentTemplate {
    label: string;
    file_type: string;
    file_url: string;
    file_size: string;
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";

function buildCard(t: AttachmentTemplate): string {
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 8px;">
  <tr><td>
    <a href="${escapeAttr(t.file_url)}" target="_blank" style="display: block; text-decoration: none; border: 1px solid #e8e8f0; border-radius: 10px; padding: 14px 16px; background: #fafafe;">
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

export function buildAttachmentCardsHtml(templates: AttachmentTemplate[]): string {
    if (!templates.length) return '';

    const header = `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 20px;">
  <tr><td style="font-family: ${FONT}; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #999999; padding-bottom: 10px;">Ekler</td></tr>
</table>`;

    return header + templates.map(buildCard).join('');
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeAttr(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
