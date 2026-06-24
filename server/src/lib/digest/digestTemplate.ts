/**
 * Digest Template — haftada-2 özet mailinin TR HTML + düz metin gövdesini kurar.
 *
 * Mail ve aktiviteler ÖNEME GÖRE gruplu:
 *   - Önemli yanıtlar (İlgili/Toplantı) tam tablo; diğer etiketler rozet+sayı.
 *   - Önemli aktiviteler (toplantı/takip/sonlandırma) tam tablo; notlar rozet+sayı.
 * Email-safe inline CSS, table-based. Stil kurtarılan [[dailyDigest.ts]] renderDigest'ten.
 */

import { escapeHtml } from '../htmlEscape.js';
import type { TenantDigestData, ActivityItem, ReplyItem, CountBadge } from './digestData.js';

const TZ = 'Europe/Istanbul';
const APP_URL = process.env.CLIENT_URL || '';

const ACTIVITY_TYPE_TR: Record<string, string> = {
    not: 'Not',
    meeting: 'Toplantı',
    follow_up: 'Takip',
    sonlandirma_raporu: 'Sonlandırma',
    campaign_email: 'Kampanya',
    status_change: 'Durum',
};

const REPLY_LABEL_TR: Record<string, string> = {
    INTERESTED: 'İlgili',
    MEETING_BOOKED: 'Toplantı',
    MEETING_CANCELLED: 'Toplantı iptal',
    NOT_INTERESTED: 'İlgisiz',
    OUT_OF_OFFICE: 'Ofis dışı',
    AUTOMATIC_REPLY: 'Otomatik',
    WRONG_PERSON: 'Yanlış kişi',
    DO_NOT_CONTACT: 'İletişim yok',
    CLOSED: 'Kapandı',
    OTHER: 'Etiketsiz',
};

function fmtDate(iso: string): string {
    return new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: '2-digit', month: 'long' }).format(new Date(iso));
}

function fmtDateTime(iso: string): string {
    return new Intl.DateTimeFormat('tr-TR', {
        timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
}

function truncate(s: string, n = 90): string {
    const t = (s || '').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const TH = 'padding:10px 12px;';
const TD = 'padding:10px 12px;border-bottom:1px solid #eef0f3;';

function tableWrap(heading: string, headCols: string[], bodyRows: string): string {
    if (!bodyRows) return '';
    const ths = headCols.map((c) => `<th style="${TH}">${c}</th>`).join('');
    return `
      <h2 style="font-size:15px;font-weight:600;margin:24px 0 8px;color:#0f172a;">${heading}</h2>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f1f5f9;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;">${ths}</tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>`;
}

function companyCellHtml(companyId: string | null | undefined, name: string | null | undefined): string {
    const label = escapeHtml(name || '—');
    if (companyId && APP_URL) {
        return `<a href="${APP_URL}/companies/${companyId}" style="color:#2563eb;text-decoration:none;">${label}</a>`;
    }
    return label;
}

function chip(text: string, count: number, accent = false): string {
    const bg = accent ? 'background:#dcfce7;color:#166534;' : 'background:#f1f5f9;color:#475569;';
    return `<span style="display:inline-block;font-size:12px;padding:3px 9px;border-radius:999px;${bg}margin:0 6px 6px 0;">${escapeHtml(text)} <strong>${count}</strong></span>`;
}

function badgesHtml(label: string, badges: CountBadge[], trMap: Record<string, string>): string {
    if (!badges.length) return '';
    const chips = badges.map((b) => chip(trMap[b.key] || b.key, b.count)).join('');
    return `<p style="margin:0 0 4px;color:#94a3b8;font-size:12px;">${escapeHtml(label)}</p><p style="margin:0 0 8px;">${chips}</p>`;
}

interface RenderParams {
    tenantName: string;
    data: TenantDigestData;
    windowStart: string;
    windowEnd: string;
}

export function renderTenantDigest(params: RenderParams): { subject: string; html: string; text: string } {
    const { tenantName, data } = params;
    const rangeLabel = `${fmtDate(params.windowStart)} – ${fmtDate(params.windowEnd)}`;

    const subject = `${tenantName} özeti — ${data.addedActivities.total} aktivite, ${data.positiveReplies} pozitif yanıt (${fmtDate(params.windowEnd)})`;

    // ── Stat kartları ──
    const stat = (value: number, label: string, accent: string) => `
        <td style="padding:14px 12px;text-align:center;border:1px solid #e2e8f0;border-radius:8px;background:#ffffff;">
          <div style="font-size:24px;font-weight:700;color:${accent};line-height:1;">${value}</div>
          <div style="margin-top:4px;font-size:12px;color:#64748b;">${label}</div>
        </td>`;
    const statsRow = `
      <table cellpadding="0" cellspacing="8" border="0" width="100%" style="margin:0 0 16px;border-collapse:separate;">
        <tr>
          ${stat(data.positiveReplies, 'Pozitif yanıt', '#16a34a')}
          ${stat(data.awaitingReplies, 'Yanıt bekleyen', '#d97706')}
          ${stat(data.addedActivities.total, 'Eklenen aktivite', '#2563eb')}
          ${stat(data.dueItems.length, 'Vadesi gelen', '#7c3aed')}
        </tr>
      </table>`;

    // ── Önemli yanıtlar (İlgili + Toplantı) ──
    const replyRows = data.replies.important.map((r: ReplyItem) => {
        const when = fmtDateTime(r.replied_at);
        const from = escapeHtml(r.companies?.name || r.sender_email || '—');
        const labelTr = r.label ? (REPLY_LABEL_TR[r.label] || r.label) : '';
        const isPositive = r.label === 'INTERESTED';
        const badge = labelTr
            ? `<span style="display:inline-block;font-size:11px;padding:1px 6px;border-radius:4px;margin-right:6px;${isPositive ? 'background:#dcfce7;color:#166534;' : 'background:#dbeafe;color:#1e40af;'}">${escapeHtml(labelTr)}</span>`
            : '';
        const subj = escapeHtml(truncate(r.subject || '(konu yok)'));
        return `
              <tr>
                <td style="${TD}font-family:monospace;color:#475569;white-space:nowrap;">${when}</td>
                <td style="${TD}font-weight:500;">${from}</td>
                <td style="${TD}color:#334155;">${badge}${subj}</td>
              </tr>`;
    }).join('');
    const repliesBlock = tableWrap('Önemli yanıtlar', ['Tarih', 'Kimden', 'Konu'], replyRows);
    const replyBadges = badgesHtml('Diğer gelen yanıtlar', data.replies.otherBadges, REPLY_LABEL_TR);

    // ── Önemli aktiviteler (toplantı/takip/sonlandırma) ──
    const activityRows = data.addedActivities.important.map((a: ActivityItem) => {
        const when = fmtDateTime(a.created_at);
        const typeLabel = ACTIVITY_TYPE_TR[a.type] || a.type;
        const company = companyCellHtml(a.company_id, a.companies?.name);
        const summary = escapeHtml(truncate(a.summary));
        return `
              <tr>
                <td style="${TD}font-family:monospace;color:#475569;white-space:nowrap;">${when}</td>
                <td style="${TD}white-space:nowrap;">${escapeHtml(typeLabel)}</td>
                <td style="${TD}font-weight:500;">${company}</td>
                <td style="${TD}color:#334155;">${summary}</td>
              </tr>`;
    }).join('');
    const activitiesBlock = tableWrap('Eklenen aktiviteler', ['Tarih', 'Tip', 'Şirket', 'Özet'], activityRows);
    const activityBadges = badgesHtml('Diğer eklenenler', data.addedActivities.otherBadges, ACTIVITY_TYPE_TR);

    // ── Pipeline durumu (count>0) ──
    const pipelineRows = data.pipeline
        .filter((s) => s.count > 0)
        .map((s) => `
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #eef0f3;color:#334155;">${escapeHtml(s.label)}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #eef0f3;text-align:right;font-weight:600;color:#0f172a;">${s.count}</td>
              </tr>`)
        .join('');
    const pipelineBlock = pipelineRows
        ? `
      <h2 style="font-size:15px;font-weight:600;margin:24px 0 8px;color:#0f172a;">Pipeline durumu</h2>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <tbody>${pipelineRows}</tbody>
      </table>`
        : '';

    // ── Vadesi gelen toplantı/takip ──
    const dueRows = data.dueItems.map((it) => {
        const when = fmtDateTime(it.occurred_at);
        const typeLabel = it.type === 'meeting' ? '📅 Toplantı' : '📞 Takip';
        const company = companyCellHtml(it.company_id, it.companies?.name);
        const summary = escapeHtml(truncate(it.summary));
        return `
              <tr>
                <td style="${TD}font-family:monospace;color:#475569;white-space:nowrap;">${when}</td>
                <td style="${TD}white-space:nowrap;">${typeLabel}</td>
                <td style="${TD}font-weight:500;">${company}</td>
                <td style="${TD}color:#334155;">${summary}</td>
              </tr>`;
    }).join('');
    const dueBlock = tableWrap('Vadesi gelen toplantı &amp; takipler', ['Tarih', 'Tip', 'Şirket', 'Özet'], dueRows);

    // ── Yeni şirket/kişi ──
    const newLine = (data.newCompanies || data.newContacts)
        ? `<p style="margin:24px 0 0;color:#334155;font-size:14px;">Bu dönemde <strong>${data.newCompanies}</strong> yeni şirket ve <strong>${data.newContacts}</strong> yeni kişi eklendi.</p>`
        : '';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
    <h1 style="font-size:20px;font-weight:600;margin:0 0 4px;">Merhaba ${escapeHtml(tenantName)} ekibi,</h1>
    <p style="margin:0 0 20px;color:#64748b;font-size:14px;">${escapeHtml(rangeLabel)} dönemine ait özetiniz.</p>

    ${statsRow}
    ${repliesBlock}
    ${replyBadges}
    ${activitiesBlock}
    ${activityBadges}
    ${pipelineBlock}
    ${dueBlock}
    ${newLine}

    <p style="margin:28px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;">
      Bu özet, ${escapeHtml(tenantName)} için özet maili ayarı açık olduğu için gönderildi.<br>
      ${APP_URL ? `Uygulamaya git: <a href="${APP_URL}" style="color:#2563eb;">${APP_URL}</a>` : ''}
    </p>
  </div>
</body></html>`;

    // ── Düz metin ──
    const badgesText = (badges: CountBadge[], trMap: Record<string, string>) =>
        badges.map((b) => `${trMap[b.key] || b.key} ${b.count}`).join(', ');

    const textLines: string[] = [
        `Merhaba ${tenantName} ekibi,`,
        `${rangeLabel} dönemine ait özetiniz.`,
        '',
        `Pozitif yanıt: ${data.positiveReplies}`,
        `Yanıt bekleyen: ${data.awaitingReplies}`,
        `Eklenen aktivite: ${data.addedActivities.total}`,
        `Vadesi gelen: ${data.dueItems.length}`,
    ];
    if (data.newCompanies || data.newContacts) {
        textLines.push(`Yeni şirket: ${data.newCompanies}, yeni kişi: ${data.newContacts}`);
    }
    if (data.replies.important.length) {
        textLines.push('', 'Önemli yanıtlar:');
        for (const r of data.replies.important) {
            const labelTr = r.label ? (REPLY_LABEL_TR[r.label] || r.label) : '';
            textLines.push(`  ${fmtDateTime(r.replied_at)} — ${r.companies?.name || r.sender_email}${labelTr ? ` [${labelTr}]` : ''} — ${truncate(r.subject || '(konu yok)')}`);
        }
    }
    if (data.replies.otherBadges.length) {
        textLines.push(`Diğer yanıtlar: ${badgesText(data.replies.otherBadges, REPLY_LABEL_TR)}`);
    }
    if (data.addedActivities.important.length) {
        textLines.push('', 'Eklenen aktiviteler:');
        for (const a of data.addedActivities.important) {
            textLines.push(`  ${fmtDateTime(a.created_at)} — ${ACTIVITY_TYPE_TR[a.type] || a.type} — ${a.companies?.name || '—'} — ${truncate(a.summary)}`);
        }
    }
    if (data.addedActivities.otherBadges.length) {
        textLines.push(`Diğer eklenenler: ${badgesText(data.addedActivities.otherBadges, ACTIVITY_TYPE_TR)}`);
    }
    if (data.pipeline.some((s) => s.count > 0)) {
        textLines.push('', 'Pipeline:');
        for (const s of data.pipeline.filter((x) => x.count > 0)) textLines.push(`  ${s.label}: ${s.count}`);
    }
    if (data.dueItems.length) {
        textLines.push('', 'Vadesi gelen toplantı & takipler:');
        for (const it of data.dueItems) {
            textLines.push(`  ${fmtDateTime(it.occurred_at)} — ${it.type === 'meeting' ? 'Toplantı' : 'Takip'} — ${it.companies?.name || '—'} — ${truncate(it.summary)}`);
        }
    }
    const text = textLines.join('\n');

    return { subject, html, text };
}
