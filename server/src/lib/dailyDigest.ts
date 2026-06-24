/**
 * Digest — haftada-2 tenant özet maili.
 *
 * Akış (scheduler her gün 08:00 TR'de tetikler, gün kapısı burada):
 *   1) tenants.settings.daily_digest_enabled = true olan her aktif tenant için
 *   2) Bugünün TR günü tenant'ın settings.digest_days listesinde mi? (varsayılan [1,4] = Pzt+Per)
 *   3) Bugün için zaten kayıt yoksa: son gönderimden bu yana pencereyi hesapla
 *   4) İçeriği topla ([[digestData.ts]]) → boşsa atla, doluysa şablonu kur ([[digestTemplate.ts]])
 *   5) Alıcılara (tenant'a bağlı aktif mail hesapları) gönder, daily_digest_log'a yaz (idempotent)
 *
 * Test için: previewTenantDigest (gönderimsiz HTML) + sendTenantDigestNow (zorla gönder),
 * admin route'larından çağrılır. Gönderim: [[systemMailer.ts]] (Resend, info@tibexa.com).
 */

import { supabaseAdmin } from './supabase.js';
import { sendSystemEmail, isConfigured as mailerReady } from './systemMailer.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from './logger.js';
import { collectTenantDigest, isDigestEmpty, digestItemCount, type TenantDigestData } from './digest/digestData.js';
import { renderTenantDigest } from './digest/digestTemplate.js';

const log = createLogger('dailyDigest');

const TZ = 'Europe/Istanbul';
const DEFAULT_HOUR = Number(process.env.DAILY_DIGEST_HOUR ?? 8); // tenant digest_hour yoksa varsayılan/dev override
const DEFAULT_DIGEST_DAYS = [1, 4]; // Pazartesi, Perşembe
const DAY_MS = 86_400_000;
const FALLBACK_LOOKBACK_MS = 3.5 * DAY_MS; // ilk gönderimde geriye dönük pencere

// ── Time helpers (TR UTC+3, DST yok) ─────────────────────────────────────────

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

function trDateKey(ms: number): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(ms));
    const m: Record<string, string> = {};
    for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value;
    return `${m.year}-${m.month}-${m.day}`;
}

/** Bir YYYY-MM-DD takvim gününün haftagünü (0=Pazar … 6=Cumartesi). */
function weekdayOf(dateKey: string): number {
    return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

/** Sonraki digest gününün gönderim anı (UTC ISO) — "vadesi gelen" ileri penceresinin sonu. */
function nextDigestBoundaryIso(now: Date, digestDays: number[], sendHour: number): string {
    for (let offset = 1; offset <= 7; offset++) {
        const dateKey = trDateKey(now.getTime() + offset * DAY_MS);
        if (digestDays.includes(weekdayOf(dateKey))) {
            return new Date(`${dateKey}T${pad2(sendHour)}:00:00+03:00`).toISOString();
        }
    }
    return new Date(now.getTime() + FALLBACK_LOOKBACK_MS).toISOString();
}

function parseDigestDays(raw: unknown): number[] {
    if (!Array.isArray(raw)) return DEFAULT_DIGEST_DAYS;
    const days = raw.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6);
    return days.length ? Array.from(new Set(days)) : DEFAULT_DIGEST_DAYS;
}

/** Verilen UTC anının TR yerel saati (0-23). */
function trHour(ms: number): number {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', hour12: false }).formatToParts(new Date(ms));
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    return h === 24 ? 0 : h;
}

function parseDigestHour(raw: unknown, fallback: number): number {
    return (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 23) ? raw : fallback;
}

// ── Tenant + user lookups ────────────────────────────────────────────────────

interface TenantRow {
    id: string;
    name: string;
    settings: Record<string, unknown> | null;
}

async function fetchTenant(tenantId: string): Promise<TenantRow | null> {
    const { data } = await supabaseAdmin
        .from('tenants')
        .select('id, name, settings')
        .eq('id', tenantId)
        .maybeSingle();
    return (data as TenantRow | null) ?? null;
}

/** Tenant'a bağlı aktif mail hesaplarının adresleri (benzersiz). */
async function resolveRecipients(tenantId: string): Promise<string[]> {
    const { data: connections, error } = await supabaseAdmin
        .from('email_connections')
        .select('email_address')
        .eq('tenant_id', tenantId)
        .eq('is_active', true);

    if (error) {
        log.error({ err: error, tenantId }, 'Failed to fetch digest recipients');
        return [];
    }

    const emails: string[] = [];
    const seen = new Set<string>();
    for (const c of connections || []) {
        const email = (c.email_address as string | null)?.trim();
        const key = email?.toLowerCase();
        if (email && key && !seen.has(key)) {
            seen.add(key);
            emails.push(email);
        }
    }
    return emails;
}

/** Bu tenant için en son BAŞARILI digest'in window_end'i (pencere başlangıcı). */
async function lastSentWindowEnd(tenantId: string): Promise<string | null> {
    const { data } = await supabaseAdmin
        .from('daily_digest_log')
        .select('window_end')
        .eq('tenant_id', tenantId)
        .eq('status', 'sent')
        .order('window_end', { ascending: false })
        .limit(1)
        .maybeSingle();
    return (data?.window_end as string | undefined) ?? null;
}

// ── Build (toplama + render) ─────────────────────────────────────────────────

interface BuiltDigest {
    windowStart: string;
    windowEnd: string;
    dueUntil: string;
    data: TenantDigestData;
    subject: string;
    html: string;
    text: string;
    isEmpty: boolean;
}

/** Bir tenant için pencereyi hesaplar, içeriği toplar ve şablonu kurar (gönderimsiz). */
async function buildTenantDigest(tenant: TenantRow, now: Date): Promise<BuiltDigest> {
    const digestDays = parseDigestDays(tenant.settings?.digest_days);
    const digestHour = parseDigestHour(tenant.settings?.digest_hour, DEFAULT_HOUR);
    const windowEnd = now.toISOString();
    const windowStart = (await lastSentWindowEnd(tenant.id)) ?? new Date(now.getTime() - FALLBACK_LOOKBACK_MS).toISOString();
    const dueUntil = nextDigestBoundaryIso(now, digestDays, digestHour);

    const data = await collectTenantDigest(tenant.id, windowStart, windowEnd, dueUntil);
    const { subject, html, text } = renderTenantDigest({ tenantName: tenant.name, data, windowStart, windowEnd });

    return { windowStart, windowEnd, dueUntil, data, subject, html, text, isEmpty: isDigestEmpty(data) };
}

// ── Main run (scheduler) ──────────────────────────────────────────────────────

export interface DigestRunResult {
    tenantsConsidered: number;
    sent: number;
    skippedEmpty: number;
    skippedNotToday: number;
    failed: number;
}

export async function runDailyDigest(now: Date = new Date()): Promise<DigestRunResult> {
    const result: DigestRunResult = { tenantsConsidered: 0, sent: 0, skippedEmpty: 0, skippedNotToday: 0, failed: 0 };

    if (!mailerReady()) {
        log.warn('System mailer not configured — skipping digest run');
        return result;
    }

    const dateKey = trDateKey(now.getTime());
    const todayWeekday = weekdayOf(dateKey);
    const currentHour = trHour(now.getTime());

    const { data: tenants, error: tenantsErr } = await supabaseAdmin
        .from('tenants')
        .select('id, name, settings')
        .eq('is_active', true)
        .filter('settings->>daily_digest_enabled', 'eq', 'true');

    if (tenantsErr) {
        log.error({ err: tenantsErr }, 'Failed to fetch tenants for digest');
        return result;
    }
    if (!tenants?.length) {
        log.info({ dateKey }, 'No tenants opted into digest');
        return result;
    }

    result.tenantsConsidered = tenants.length;
    log.info({ dateKey, weekday: todayWeekday, tenantCount: tenants.length }, 'Running digest');

    for (const tenant of tenants as TenantRow[]) {
        try {
            const digestDays = parseDigestDays(tenant.settings?.digest_days);
            // Bugün bu tenant'ın digest günü mü?
            if (!digestDays.includes(todayWeekday)) {
                result.skippedNotToday++;
                continue;
            }
            // Sadece tenant'ın gönderim saatinde gönder (akşam telafisi yok; kaçarsa o gün atlanır).
            const digestHour = parseDigestHour(tenant.settings?.digest_hour, DEFAULT_HOUR);
            if (currentHour !== digestHour) {
                result.skippedNotToday++;
                continue;
            }

            // Idempotency: bugün için zaten kayıt varsa atla.
            const { data: existing } = await supabaseAdmin
                .from('daily_digest_log')
                .select('id')
                .eq('tenant_id', tenant.id)
                .eq('digest_date', dateKey)
                .maybeSingle();
            if (existing) continue;

            const built = await buildTenantDigest(tenant, now);
            const recipients = await resolveRecipients(tenant.id);

            // İçerik boş ya da alıcı yoksa: skipped_empty olarak işaretle, mail atma.
            if (built.isEmpty || recipients.length === 0) {
                await supabaseAdmin.from('daily_digest_log').insert({
                    tenant_id: tenant.id,
                    digest_date: dateKey,
                    window_start: built.windowStart,
                    window_end: built.windowEnd,
                    recipient_count: recipients.length,
                    item_count: digestItemCount(built.data),
                    status: 'skipped_empty',
                    meta: { empty: built.isEmpty, noRecipients: recipients.length === 0 },
                });
                result.skippedEmpty++;
                continue;
            }

            // Her alıcıya tek tek gönder (alıcılar birbirini görmesin + per-recipient messageId).
            const messageIds: string[] = [];
            let sendFailures = 0;
            for (const to of recipients) {
                try {
                    const res = await sendSystemEmail({
                        to,
                        subject: built.subject,
                        html: built.html,
                        text: built.text,
                        tags: [
                            { name: 'category', value: 'digest' },
                            { name: 'tenant_id', value: tenant.id },
                        ],
                    });
                    messageIds.push(res.messageId);
                } catch (err) {
                    sendFailures++;
                    log.error({ err, tenantId: tenant.id, to }, 'Failed to send digest to recipient');
                }
            }

            const status = messageIds.length > 0 ? 'sent' : 'failed';
            const { error: logErr } = await supabaseAdmin.from('daily_digest_log').insert({
                tenant_id: tenant.id,
                digest_date: dateKey,
                window_start: built.windowStart,
                window_end: built.windowEnd,
                recipient_count: messageIds.length,
                item_count: digestItemCount(built.data),
                message_ids: messageIds,
                status,
                meta: {
                    positiveReplies: built.data.positiveReplies,
                    awaitingReplies: built.data.awaitingReplies,
                    addedActivities: built.data.addedActivities.total,
                    dueItems: built.data.dueItems.length,
                    newCompanies: built.data.newCompanies,
                    newContacts: built.data.newContacts,
                    sendFailures,
                },
            });
            if (logErr) {
                // Muhtemelen paralel tick'ten UNIQUE ihlali — kayıp değil.
                log.warn({ err: logErr, tenantId: tenant.id, dateKey }, 'digest_log insert failed (likely duplicate)');
            }

            if (status === 'sent') {
                result.sent++;
                log.info(
                    { tenantId: tenant.id, recipients: messageIds.length, items: digestItemCount(built.data) },
                    'Digest sent',
                );
            } else {
                result.failed++;
            }
        } catch (err) {
            result.failed++;
            log.error({ err, tenantId: tenant.id }, 'Tenant digest loop failed');
        }
    }

    log.info(result, 'Digest run complete');
    return result;
}

// ── Test/inceleme yardımcıları (admin route'larından) ─────────────────────────

export interface DigestPreview {
    tenantName: string;
    recipients: string[];
    windowStart: string;
    windowEnd: string;
    dueUntil: string;
    isEmpty: boolean;
    data: TenantDigestData;
    subject: string;
    html: string;
    text: string;
}

/** Gönderimsiz önizleme — Resend yapılandırılmamış olsa da çalışır (sadece render). */
export async function previewTenantDigest(tenantId: string, now: Date = new Date()): Promise<DigestPreview> {
    const tenant = await fetchTenant(tenantId);
    if (!tenant) throw new AppError('Tenant not found', 404);
    const built = await buildTenantDigest(tenant, now);
    const recipients = await resolveRecipients(tenantId);
    return { tenantName: tenant.name, recipients, ...built };
}

export interface DigestSendNowResult {
    tenantName: string;
    recipients: string[];
    messageIds: string[];
    subject: string;
    isEmpty: boolean;
}

/**
 * Zorla gönder (digest_days / enabled / idempotency kapılarını atlar) — test için.
 * daily_digest_log'a YAZMAZ; planlı çalışmayı etkilemez. Resend gerektirir.
 * overrideTo verilirse tenant alıcıları yerine yalnızca o adrese gönderir (deliverability testi).
 */
export async function sendTenantDigestNow(tenantId: string, now: Date = new Date(), overrideTo?: string): Promise<DigestSendNowResult> {
    if (!mailerReady()) throw new AppError('RESEND_API_KEY/RESEND_FROM_EMAIL not configured', 400);
    const tenant = await fetchTenant(tenantId);
    if (!tenant) throw new AppError('Tenant not found', 404);

    const built = await buildTenantDigest(tenant, now);
    const recipients = overrideTo ? [overrideTo] : await resolveRecipients(tenantId);
    if (recipients.length === 0) {
        throw new AppError('No active connected mailboxes for this tenant', 400);
    }

    const messageIds: string[] = [];
    for (const to of recipients) {
        const res = await sendSystemEmail({
            to,
            subject: built.subject,
            html: built.html,
            text: built.text,
            tags: [
                { name: 'category', value: 'digest_test' },
                { name: 'tenant_id', value: tenantId },
            ],
        });
        messageIds.push(res.messageId);
    }

    log.info({ tenantId, recipients: messageIds.length }, 'Digest test send complete');
    return { tenantName: tenant.name, recipients, messageIds, subject: built.subject, isEmpty: built.isEmpty };
}
