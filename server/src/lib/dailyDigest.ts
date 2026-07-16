/**
 * Daily Digest — sabah maili: kullanıcıya bugün vadesi gelen
 * follow_up + meeting aktivitelerinin listesi.
 *
 * Akış:
 *   1) tenants.settings.daily_digest_enabled = true olan her tenant için
 *   2) Bugün (TR günü) vadesi gelen follow_up + meeting aktivitelerini topla
 *   3) created_by kullanıcısına göre grupla
 *   4) Her kullanıcıya (idempotent: daily_digest_log) tek mail at
 *
 * Gönderim: [[systemMailer.ts]] (Resend, info@tibexa.com).
 */

import { supabaseAdmin } from './supabase.js';
import { sendSystemEmail, isConfigured as mailerReady } from './systemMailer.js';
import { escapeHtml } from './htmlEscape.js';
import { createLogger } from './logger.js';

const log = createLogger('dailyDigest');

const TZ = 'Europe/Istanbul';

// ── Time helpers ────────────────────────────────────────────────────────────

/**
 * Returns the [start, end) UTC bounds of "today" in Europe/Istanbul,
 * plus the calendar date string (YYYY-MM-DD) used for idempotency keys.
 */
function tzDayBounds(now: Date = new Date()): { startUtc: string; endUtc: string; dateKey: string } {
    // Get TR-local Y/M/D for `now`
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const map: Record<string, string> = {};
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
    const dateKey = `${map.year}-${map.month}-${map.day}`;

    // TR is UTC+3 year-round (no DST). Encode the local midnight as UTC.
    const startUtc = new Date(`${dateKey}T00:00:00+03:00`).toISOString();
    const endUtc = new Date(`${dateKey}T24:00:00+03:00`).toISOString();
    return { startUtc, endUtc, dateKey };
}

function formatLocalTime(iso: string): string {
    return new Intl.DateTimeFormat('tr-TR', {
        timeZone: TZ,
        hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
}

// ── Types ───────────────────────────────────────────────────────────────────

interface DueActivity {
    id: string;
    tenant_id: string;
    company_id: string;
    contact_id: string | null;
    type: 'follow_up' | 'meeting';
    summary: string;
    detail: string | null;
    occurred_at: string;
    created_by: string | null;
    companies?: { name: string } | null;
}

interface TenantRow {
    id: string;
    name: string;
    settings: Record<string, unknown> | null;
}

// ── Email rendering ─────────────────────────────────────────────────────────

const APP_URL = process.env.CLIENT_URL || '';

function renderDigest(params: {
    tenantName: string;
    userName: string | null;
    dateKey: string;
    items: DueActivity[];
}): { subject: string; html: string; text: string } {
    const dateLabel = new Intl.DateTimeFormat('tr-TR', {
        timeZone: TZ, day: '2-digit', month: 'long', year: 'numeric', weekday: 'long',
    }).format(new Date(`${params.dateKey}T12:00:00+03:00`));

    const meetingCount = params.items.filter(i => i.type === 'meeting').length;
    const followCount = params.items.filter(i => i.type === 'follow_up').length;

    const greeting = params.userName ? `Merhaba ${escapeHtml(params.userName.split(' ')[0])},` : 'Merhaba,';
    const subject = `Bugünkü ajandan — ${params.items.length} öğe (${dateLabel})`;

    const rows = params.items
        .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
        .map(it => {
            const time = formatLocalTime(it.occurred_at);
            const typeLabel = it.type === 'meeting' ? '📅 Toplantı' : '📞 Takip';
            const company = escapeHtml(it.companies?.name || '—');
            const summary = escapeHtml(it.summary);
            const link = APP_URL ? `${APP_URL}/companies/${it.company_id}` : '';
            const companyCell = link
                ? `<a href="${link}" style="color:#2563eb;text-decoration:none;">${company}</a>`
                : company;
            return `
              <tr>
                <td style="padding:10px 12px;border-bottom:1px solid #eef0f3;font-family:monospace;color:#475569;white-space:nowrap;">${time}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #eef0f3;white-space:nowrap;">${typeLabel}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #eef0f3;font-weight:500;">${companyCell}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #eef0f3;color:#334155;">${summary}</td>
              </tr>`;
        })
        .join('');

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
    <h1 style="font-size:20px;font-weight:600;margin:0 0 4px;">${greeting}</h1>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;">${escapeHtml(dateLabel)} için ajandanda <strong>${params.items.length}</strong> öğe var (${meetingCount} toplantı, ${followCount} takip).</p>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:#f1f5f9;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;">
          <th style="padding:10px 12px;">Saat</th>
          <th style="padding:10px 12px;">Tip</th>
          <th style="padding:10px 12px;">Şirket</th>
          <th style="padding:10px 12px;">Özet</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p style="margin:24px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;">
      Bu mail ${escapeHtml(params.tenantName)} için günlük özet ayarı açık olduğu için gönderildi.<br>
      ${APP_URL ? `Uygulamaya git: <a href="${APP_URL}" style="color:#2563eb;">${APP_URL}</a>` : ''}
    </p>
  </div>
</body></html>`;

    const text = [
        greeting,
        `${dateLabel} için ${params.items.length} öğe (${meetingCount} toplantı, ${followCount} takip):`,
        '',
        ...params.items
            .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
            .map(it => `${formatLocalTime(it.occurred_at)} — ${it.type === 'meeting' ? 'Toplantı' : 'Takip'} — ${it.companies?.name || '—'} — ${it.summary}`),
    ].join('\n');

    return { subject, html, text };
}

// ── User email lookup ───────────────────────────────────────────────────────

interface UserInfo { email: string; name?: string }

async function fetchUserInfo(userId: string): Promise<UserInfo | null> {
    try {
        const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
        if (error || !data.user?.email) return null;
        return {
            email: data.user.email,
            name: (data.user.user_metadata?.full_name as string) || (data.user.user_metadata?.name as string),
        };
    } catch {
        return null;
    }
}

// ── Main run ────────────────────────────────────────────────────────────────

export interface DigestRunResult {
    tenantsConsidered: number;
    usersSent: number;
    usersSkipped: number;
    failed: number;
}

export async function runDailyDigest(now: Date = new Date()): Promise<DigestRunResult> {
    const result: DigestRunResult = { tenantsConsidered: 0, usersSent: 0, usersSkipped: 0, failed: 0 };

    if (!mailerReady()) {
        log.warn('System mailer not configured — skipping daily digest run');
        return result;
    }

    const { startUtc, endUtc, dateKey } = tzDayBounds(now);

    // Tenants with daily_digest_enabled = true
    const { data: tenants, error: tenantsErr } = await supabaseAdmin
        .from('tenants')
        .select('id, name, settings')
        .eq('is_active', true)
        .filter('settings->>daily_digest_enabled', 'eq', 'true');

    if (tenantsErr) {
        result.failed++;
        log.error({ err: tenantsErr }, 'Failed to fetch tenants for digest');
        return result;
    }
    if (!tenants?.length) {
        log.info({ dateKey }, 'No tenants opted into daily digest');
        return result;
    }

    result.tenantsConsidered = tenants.length;
    log.info({ dateKey, tenantCount: tenants.length }, 'Running daily digest');

    for (const tenant of tenants as TenantRow[]) {
        try {
            // Today's scheduled follow_up / meeting activities for this tenant.
            // occurred_at doubles as the planned time — the form's DateTimePicker
            // sets it to future dates for forthcoming work.
            const { data: activities, error: actErr } = await supabaseAdmin
                .from('activities')
                .select('id, tenant_id, company_id, contact_id, type, summary, detail, occurred_at, created_by, companies(name)')
                .eq('tenant_id', tenant.id)
                .in('type', ['follow_up', 'meeting'])
                .gte('occurred_at', startUtc)
                .lt('occurred_at', endUtc)
                .not('created_by', 'is', null)
                .order('occurred_at', { ascending: true });

            if (actErr) {
                log.error({ err: actErr, tenantId: tenant.id }, 'Failed to fetch due activities');
                result.failed++;
                continue;
            }
            if (!activities?.length) continue;

            // Group by created_by
            const byUser = new Map<string, DueActivity[]>();
            for (const a of activities as unknown as DueActivity[]) {
                if (!a.created_by) continue;
                const list = byUser.get(a.created_by) ?? [];
                list.push(a);
                byUser.set(a.created_by, list);
            }

            // Only active members of this tenant may receive its activity data.
            const userIds = [...byUser.keys()];
            const { data: memberships, error: membershipsErr } = await supabaseAdmin
                .from('memberships')
                .select('user_id')
                .eq('tenant_id', tenant.id)
                .eq('is_active', true)
                .in('user_id', userIds);
            if (membershipsErr) {
                result.failed++;
                log.error({ err: membershipsErr, tenantId: tenant.id }, 'Failed to scope digest recipients');
                continue;
            }
            const activeMemberIds = new Set((memberships || []).map(row => row.user_id as string));

            // Idempotency: pull every (tenant, user, today) already-sent row in one query
            // instead of one SELECT per user.
            const { data: sentRows, error: sentRowsErr } = await supabaseAdmin
                .from('daily_digest_log')
                .select('user_id')
                .eq('tenant_id', tenant.id)
                .eq('digest_date', dateKey)
                .in('user_id', userIds);
            if (sentRowsErr) {
                result.failed++;
                log.error({ err: sentRowsErr, tenantId: tenant.id }, 'Failed to read digest idempotency log');
                continue;
            }
            const alreadySent = new Set((sentRows || []).map(r => r.user_id as string));

            for (const [userId, items] of byUser) {
                try {
                    if (alreadySent.has(userId)) {
                        result.usersSkipped++;
                        continue;
                    }
                    if (!activeMemberIds.has(userId)) {
                        log.warn({ tenantId: tenant.id, userId }, 'Digest recipient is not an active tenant member — skipping');
                        result.usersSkipped++;
                        continue;
                    }

                    const user = await fetchUserInfo(userId);
                    if (!user) {
                        log.warn({ userId }, 'Could not resolve user email — skipping digest');
                        result.usersSkipped++;
                        continue;
                    }

                    const { subject, html, text } = renderDigest({
                        tenantName: tenant.name,
                        userName: user.name ?? null,
                        dateKey,
                        items,
                    });

                    // Claim before sending. The tenant-scoped UNIQUE constraint prevents
                    // two API instances from emailing the same user concurrently.
                    const { error: claimErr } = await supabaseAdmin
                        .from('daily_digest_log')
                        .insert({
                            tenant_id: tenant.id,
                            user_id: userId,
                            digest_date: dateKey,
                            item_count: items.length,
                        });
                    if (claimErr) {
                        if (claimErr.code === '23505') {
                            result.usersSkipped++;
                            continue;
                        }
                        throw claimErr;
                    }

                    let sendResult;
                    try {
                        sendResult = await sendSystemEmail({
                            to: user.email,
                            subject,
                            html,
                            text,
                            tags: [
                                { name: 'category', value: 'daily_digest' },
                                { name: 'tenant_id', value: tenant.id },
                            ],
                        });
                    } catch (err) {
                        // Release the claim so the next scheduler tick can retry.
                        const { error: releaseErr } = await supabaseAdmin
                            .from('daily_digest_log')
                            .delete()
                            .eq('tenant_id', tenant.id)
                            .eq('user_id', userId)
                            .eq('digest_date', dateKey);
                        if (releaseErr) log.error({ err: releaseErr, tenantId: tenant.id, userId }, 'Failed to release digest claim');
                        throw err;
                    }

                    const { error: logErr } = await supabaseAdmin
                        .from('daily_digest_log')
                        .update({
                            message_id: sendResult.messageId,
                        })
                        .eq('tenant_id', tenant.id)
                        .eq('user_id', userId)
                        .eq('digest_date', dateKey);

                    if (logErr) {
                        // The claim remains intentionally: the email was sent, so retrying
                        // would be worse than missing only its provider message id.
                        log.warn({ err: logErr, userId, dateKey }, 'Failed to attach message id to digest log');
                    }

                    result.usersSent++;
                    log.info(
                        { tenantId: tenant.id, userId, itemCount: items.length, messageId: sendResult.messageId },
                        'Daily digest sent',
                    );
                } catch (err) {
                    result.failed++;
                    log.error({ err, tenantId: tenant.id, userId }, 'Failed to send daily digest to user');
                }
            }
        } catch (err) {
            result.failed++;
            log.error({ err, tenantId: tenant.id }, 'Tenant digest loop failed');
        }
    }

    log.info(result, 'Daily digest run complete');
    return result;
}
