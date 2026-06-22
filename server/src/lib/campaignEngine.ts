/**
 * Campaign Engine — Enrollment state machine, scheduling, template resolution
 *
 * Hibrit v2: Enrollment'lar campaign_enrollments'ta, gönderilen email'ler
 * activities'te birer kayıt olarak oluşturulur (timeline'da görünür).
 *
 * Pattern references:
 *   - Batch: importProcessor.ts (cancellation check)
 *   - Rate limit: plusvibeClient.ts (sliding window)
 *   - Stage advance: emailMatcher.ts (advanceCompanyStageOnMatch)
 */

import { supabaseAdmin } from './supabase.js';
import { API_BASE, createTrackingToken, injectTracking } from './mailTracking.js';
import { sendMail } from './mail/router.js';
import { createLogger } from './logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { nextSendableTime, startOfLocalDay, startOfNextLocalDay, type SendingWindow } from './sendingWindow.js';

const log = createLogger('campaignEngine');

// ── Types ──────────────────────────────────────────────────────────────────

interface CampaignStep {
    id: string;
    campaign_id: string;
    step_order: number;
    step_type: 'email' | 'delay' | 'condition';
    subject: string | null;
    body_html: string | null;
    delay_days: number;
    delay_hours: number;
}

interface EnrollContact {
    contact_id: string;
    company_id: string;
    email: string;
}

// ── Template Variables ─────────────────────────────────────────────────────

interface TemplateCtx {
    first_name: string;
    last_name: string;
    email: string;
    title: string;
    company_name: string;
    website: string;
    industry: string;
}

const TEMPLATE_KEYS = ['first_name', 'last_name', 'email', 'title', 'company_name', 'website', 'industry'] as const;

async function resolveTemplate(contactId: string, companyId: string): Promise<TemplateCtx> {
    const [cRes, coRes] = await Promise.all([
        supabaseAdmin.from('contacts').select('first_name, last_name, email, title').eq('id', contactId).single(),
        supabaseAdmin.from('companies').select('name, website, industry').eq('id', companyId).single(),
    ]);
    const c = cRes.data;
    const co = coRes.data;
    return {
        first_name: c?.first_name || '', last_name: c?.last_name || '',
        email: c?.email || '', title: c?.title || '',
        company_name: co?.name || '', website: co?.website || '', industry: co?.industry || '',
    };
}

function applyTemplate(template: string, ctx: TemplateCtx): string {
    let result = template;
    for (const key of TEMPLATE_KEYS) {
        result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi'), ctx[key] || '');
    }
    return result;
}

// Spintax: {{random|A|B|C}} → her gönderimde rastgele bir seçenek. Boş seçenek
// (ör. {{random|please|}}) atlamayı sağlar. Seçenekler {{first_name}} gibi tek
// seviye değişken içerebilir (değişkenler spintax çözüldükten sonra uygulanır).
function applySpintax(template: string): string {
    return template.replace(/\{\{\s*random\s*\|((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/gi, (_m, group: string) => {
        const opts = group.split('|');
        return (opts[Math.floor(Math.random() * opts.length)] || '').trim();
    });
}

// Inbox rotasyonu: enrollment id'sine göre deterministik mailbox seçimi. Aynı kişiye
// hep aynı kutudan gidilir (thread tutarlılığı), kişiler kutulara dağılır.
function hashStr(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
}

// Gönderilecek mailbox: rotasyon ayarı varsa onu, yoksa tenant'ın varsayılan
// (yoksa ilk aktif) bağlantısını döner. Router provider'ı bu adrese göre seçer
// (smtp/Nango), böylece app-password Gmail (SMTP) kutuları da çalışır.
//
// Önemli: rotasyon havuzu yalnız HÂLÂ aktif olan bağlantılardan kurulur. Ayarlarda
// seçili bir kutu sonradan silinmiş/pasif olduysa o kişiye gönderim patlamadan
// varsayılana düşer (sessiz hata önlenir). Havuz sırası korunduğu için hiçbir kutu
// kaldırılmadığında aynı enrollment hep aynı kutuya gider (thread tutarlılığı).
async function resolveAccountEmail(tenantId: string, settings: any, enrollmentId: string): Promise<string | undefined> {
    const { data } = await supabaseAdmin
        .from('email_connections')
        .select('email_address')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .order('is_default', { ascending: false });

    const active = (data || []) as Array<{ email_address: string }>;
    if (active.length === 0) return undefined;

    const byLower = new Map(active.map((c) => [c.email_address.toLowerCase(), c.email_address]));
    const configured = (settings?.sending_accounts as string[] | undefined) || [];

    // Rotasyon havuzu = ayarlardaki sıra korunarak, hâlâ aktif olan kutular
    const pool = configured
        .map((e) => byLower.get((e || '').toLowerCase()))
        .filter((e): e is string => !!e);

    if (pool.length > 0) {
        return pool[hashStr(enrollmentId) % pool.length];
    }

    if (configured.length > 0) {
        // Tüm rotasyon kutuları kaldırılmış → varsayılana düşüyoruz, görünür kalsın
        log.warn({ tenantId, configured: configured.length }, 'Rotation accounts no longer active, falling back to default mailbox');
    }
    return active[0].email_address; // varsayılan (is_default) veya ilk aktif kutu
}

// Test gönderimi: bir adımın konu/gövdesini örnek verilerle bir adrese yollar.
export async function sendTestEmail(
    tenantId: string, to: string, subject: string, bodyHtml: string, fromName?: string | null,
): Promise<void> {
    const ctx: TemplateCtx = {
        first_name: 'Ahmet', last_name: 'Yılmaz', email: to,
        title: 'Satın Alma Müdürü', company_name: 'Acme A.Ş.', website: 'acme.com', industry: 'Teknoloji',
    };
    const finalSubject = applyTemplate(applySpintax(subject || ''), ctx);
    const finalBody = applyTemplate(applySpintax(bodyHtml || ''), ctx);
    const accountEmail = await resolveAccountEmail(tenantId, {}, '');
    // Gönderen adı kutuya ait; yoksa çağıranın verdiği fallback.
    const { data: tenant } = await supabaseAdmin.from('tenants').select('settings').eq('id', tenantId).single();
    const senderNames = (tenant?.settings as any)?.sender_names || {};
    const resolvedName = senderNames[(accountEmail || '').toLowerCase()] || fromName || undefined;
    await sendMail({
        channel: 'campaign', tenantId, to,
        subject: `[Test] ${finalSubject}`, bodyHtml: finalBody,
        fromName: resolvedName, accountEmail,
    });
}

// ── Tracking ───────────────────────────────────────────────────────────────
// Token üretimi/doğrulama ve injectTracking lib/mailTracking.ts'e taşındı.

function buildUnsubscribeFooter(enrollmentId: string): string {
    if (!API_BASE) return '';
    const token = createTrackingToken(enrollmentId);
    return `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;text-align:center;">
        <a href="${API_BASE}/api/unsubscribe/${token}" style="color:#999;font-size:11px;text-decoration:underline;">Unsubscribe</a>
    </div>`;
}

// ── Step Navigation ────────────────────────────────────────────────────────

async function findNextStep(campaignId: string, currentStepOrder: number): Promise<CampaignStep | null> {
    const { data } = await supabaseAdmin
        .from('campaign_steps')
        .select('*')
        .eq('campaign_id', campaignId)
        .gt('step_order', currentStepOrder)
        .order('step_order')
        .limit(1);
    return (data?.[0] as CampaignStep) || null;
}

function calcDelayMs(step: CampaignStep): number {
    return (step.delay_days * 86_400_000) + (step.delay_hours * 3_600_000);
}

const DEFAULT_TZ = 'Europe/Istanbul';

// Gönderim penceresi varsa baseMs'i bir sonraki açılışa clamp'ler; yoksa aynen döner.
function scheduleMs(baseMs: number, settings: any): number {
    const win = settings?.sending_window as SendingWindow | undefined;
    if (!win) return baseMs;
    return nextSendableTime(baseMs, settings?.timezone || DEFAULT_TZ, win);
}

// Kampanyanın bugün (yerel gün) gönderdiği mail sayısı — günlük limit kontrolü için.
async function countSentToday(campaignId: string, timeZone: string): Promise<number> {
    const dayStart = startOfLocalDay(Date.now(), timeZone);
    const { count } = await supabaseAdmin
        .from('activities')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .eq('type', 'campaign_email')
        .eq('outcome', 'sent')
        .gte('occurred_at', new Date(dayStart).toISOString());
    return count || 0;
}

// ── Enrollment ─────────────────────────────────────────────────────────────

export async function enrollLeads(
    campaignId: string,
    tenantId: string,
    userId: string,
    contacts: EnrollContact[],
): Promise<{ enrolled: number; skipped: number }> {
    // Fetch campaign + first step
    const { data: campaign, error: campErr } = await supabaseAdmin
        .from('campaigns')
        .select('id, status, total_enrolled, settings')
        .eq('id', campaignId)
        .eq('tenant_id', tenantId)
        .single();

    if (campErr || !campaign) throw new AppError('Campaign not found', 404);

    const { data: steps } = await supabaseAdmin
        .from('campaign_steps')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('step_order');

    if (!steps?.length) throw new AppError('Campaign has no steps', 422);

    const firstStep = steps[0] as CampaignStep;

    // Wait-before-email modeli: her adımın kendi delay'i "bu maili göndermeden
    // önce bekle" demektir. İlk adımın delay'i (genelde 0 = hemen) kayıt anından
    // itibaren sayılır. Gönderim penceresi varsa açılışa clamp'lenir.
    // Legacy 'delay' düğümleri de aynı hesapla doğru çalışır.
    const firstScheduleAt = new Date(scheduleMs(Date.now() + calcDelayMs(firstStep), campaign.settings)).toISOString();

    // Batch insert enrollments — single DB call, duplicates ignored via ON CONFLICT
    const rows = contacts.map((c) => ({
        tenant_id: tenantId,
        campaign_id: campaignId,
        contact_id: c.contact_id,
        company_id: c.company_id,
        email: c.email.toLowerCase(),
        status: 'active',
        current_step_id: firstStep.id,
        next_scheduled_at: firstScheduleAt,
    }));

    let enrolled = 0;
    let skipped = 0;

    // Try batch insert first; fall back to individual on conflict
    const { data: inserted, error: batchErr } = await supabaseAdmin
        .from('campaign_enrollments')
        .insert(rows)
        .select('id');

    if (batchErr) {
        if (batchErr.code === '23505') {
            // Batch had duplicates — fall back to individual inserts
            for (const row of rows) {
                const { error } = await supabaseAdmin
                    .from('campaign_enrollments')
                    .insert(row);
                if (error) { skipped++; } else { enrolled++; }
            }
        } else {
            log.error({ err: batchErr }, 'Batch enrollment insert failed');
            throw new AppError('Failed to enroll leads', 500);
        }
    } else {
        enrolled = inserted?.length || 0;
        skipped = contacts.length - enrolled;
    }

    // Update denormalized counter (derive from actual count to avoid race conditions)
    if (enrolled > 0) {
        const { count } = await supabaseAdmin
            .from('campaign_enrollments')
            .select('id', { count: 'exact', head: true })
            .eq('campaign_id', campaignId);
        await supabaseAdmin
            .from('campaigns')
            .update({ total_enrolled: count || 0 })
            .eq('id', campaignId);
    }

    log.info({ campaignId, enrolled, skipped }, 'Leads enrolled');
    return { enrolled, skipped };
}

// ── Scheduled Email Processing ─────────────────────────────────────────────

export async function processScheduledEmails(): Promise<{ sent: number; failed: number; advanced: number }> {
    // Drip emails go out via Nango (user's own Gmail/Outlook), not Resend.
    // If Nango is not configured, no tenant can have an active connection — skip the tick.
    if (!process.env.NANGO_SECRET_KEY) return { sent: 0, failed: 0, advanced: 0 };

    const { data: dueEnrollments, error } = await supabaseAdmin
        .from('campaign_enrollments')
        .select(`
            id, tenant_id, campaign_id, contact_id, company_id, email,
            current_step_id, next_scheduled_at, branch_path
        `)
        .eq('status', 'active')
        .lte('next_scheduled_at', new Date().toISOString())
        .order('next_scheduled_at')
        .limit(50);

    if (error) {
        log.error({ err: error }, 'Failed to fetch due enrollments');
        return { sent: 0, failed: 0, advanced: 0 };
    }
    if (!dueEnrollments?.length) return { sent: 0, failed: 0, advanced: 0 };

    log.info({ count: dueEnrollments.length }, 'Processing due enrollments');

    let sent = 0, failed = 0, advanced = 0;

    for (const enrollment of dueEnrollments) {
        try {
            // Optimistic lock: claim this enrollment so concurrent ticks can't double-process it.
            // If another process already claimed it, the update returns 0 rows and we skip.
            const { data: locked } = await supabaseAdmin
                .from('campaign_enrollments')
                .update({ next_scheduled_at: null })
                .eq('id', enrollment.id)
                .eq('status', 'active')
                .not('next_scheduled_at', 'is', null)
                .select('id')
                .single();

            if (!locked) continue; // already claimed by another tick or status changed

            // Fetch campaign status + tenant CC settings
            const [campaignRes, tenantRes] = await Promise.all([
                supabaseAdmin.from('campaigns').select('status, from_name, settings')
                    .eq('id', enrollment.campaign_id).single(),
                supabaseAdmin.from('tenants').select('settings')
                    .eq('id', enrollment.tenant_id).single(),
            ]);
            const campaign = campaignRes.data;
            const tenantSettings = tenantRes.data?.settings || {};

            if (!campaign || campaign.status !== 'active') {
                // Campaign no longer active — pause enrollment
                await supabaseAdmin
                    .from('campaign_enrollments')
                    .update({ status: 'paused' })
                    .eq('id', enrollment.id);
                continue;
            }

            // Fetch current step
            const { data: step } = await supabaseAdmin
                .from('campaign_steps')
                .select('*')
                .eq('id', enrollment.current_step_id)
                .single();

            if (!step) {
                log.warn({ enrollmentId: enrollment.id }, 'Current step not found — completing enrollment');
                await completeEnrollment(enrollment.id);
                continue;
            }

            const currentStep = step as CampaignStep;

            if (currentStep.step_type === 'email') {
                // ── Send email ─────────────────────────────────────────
                if (!enrollment.contact_id || !enrollment.company_id) {
                    await markEnrollmentFailed(enrollment.id, 'Missing contact or company');
                    failed++; continue;
                }

                // ── Gönderim penceresi + günlük limit kapıları ──────────
                const settings = campaign.settings || {};
                const tz = settings.timezone || DEFAULT_TZ;
                const nowMs = Date.now();

                if (settings.sending_window) {
                    const sendable = nextSendableTime(nowMs, tz, settings.sending_window);
                    if (sendable > nowMs) {
                        // Pencere dışı → açılışa ertele, gönderme.
                        await supabaseAdmin.from('campaign_enrollments')
                            .update({ next_scheduled_at: new Date(sendable).toISOString() })
                            .eq('id', enrollment.id);
                        continue;
                    }
                }

                if (settings.daily_limit && settings.daily_limit > 0) {
                    const sentToday = await countSentToday(enrollment.campaign_id, tz);
                    if (sentToday >= settings.daily_limit) {
                        // Günlük limit doldu → ertesi günün açılışına ertele.
                        const nextOpen = scheduleMs(startOfNextLocalDay(nowMs, tz), settings);
                        await supabaseAdmin.from('campaign_enrollments')
                            .update({ next_scheduled_at: new Date(nextOpen).toISOString() })
                            .eq('id', enrollment.id);
                        continue;
                    }
                }

                // Resolve spintax (gönderim başına rastgele) → sonra değişkenler.
                const ctx = await resolveTemplate(enrollment.contact_id, enrollment.company_id);
                const subject = applyTemplate(applySpintax(currentStep.subject || ''), ctx);
                let bodyHtml = applyTemplate(applySpintax(currentStep.body_html || ''), ctx);

                // Create activity first (we need the ID for tracking)
                const { data: activity, error: actErr } = await supabaseAdmin
                    .from('activities')
                    .insert({
                        tenant_id: enrollment.tenant_id,
                        company_id: enrollment.company_id,
                        contact_id: enrollment.contact_id,
                        type: 'campaign_email',
                        summary: subject,
                        detail: (currentStep.body_html || '').slice(0, 500), // snippet for timeline
                        outcome: 'sending',
                        campaign_id: enrollment.campaign_id,
                        enrollment_id: enrollment.id,
                        visibility: 'internal',
                        occurred_at: new Date().toISOString(),
                        created_by: null, // system-generated
                    })
                    .select('id')
                    .single();

                if (actErr || !activity) {
                    log.error({ err: actErr }, 'Failed to create campaign activity');
                    failed++;
                    // Optimistic lock next_scheduled_at'i null'ladı; geri yazmazsak
                    // enrollment kalıcı olarak takılır → +5 dk sonra tekrar dene.
                    await supabaseAdmin.from('campaign_enrollments')
                        .update({ next_scheduled_at: new Date(Date.now() + 5 * 60_000).toISOString() })
                        .eq('id', enrollment.id);
                    continue;
                }

                // Inject tracking + unsubscribe
                bodyHtml = injectTracking(bodyHtml, activity.id);
                bodyHtml += buildUnsubscribeFooter(enrollment.id);

                try {
                    // CC: campaign-level override > tenant-level default
                    const ccAddresses: string[] = (campaign.settings?.cc
                        || tenantSettings.cc_addresses?.map((a: any) => a.email)
                        || []);

                    const accountEmail = await resolveAccountEmail(enrollment.tenant_id, campaign.settings, enrollment.id);
                    // Gönderen adı kutuya ait (tüm kampanyalarda ortak); yoksa kampanya from_name'i.
                    const senderNames = tenantSettings.sender_names || {};
                    const fromName = senderNames[(accountEmail || '').toLowerCase()] || campaign.from_name || undefined;
                    const result = await sendMail({
                        channel: 'campaign',
                        tenantId: enrollment.tenant_id,
                        to: enrollment.email,
                        subject,
                        bodyHtml,
                        fromName,
                        cc: ccAddresses.length > 0 ? ccAddresses : undefined,
                        accountEmail,
                        campaignId: enrollment.campaign_id,
                    });
                    if (!result.success) throw new Error('Send failed');

                    // Mark activity as sent
                    await supabaseAdmin
                        .from('activities')
                        .update({ outcome: 'sent' })
                        .eq('id', activity.id);

                    sent++;
                    log.info({ enrollmentId: enrollment.id, to: enrollment.email, activityId: activity.id }, 'Campaign email sent');
                } catch (sendErr) {
                    const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
                    await supabaseAdmin
                        .from('activities')
                        .update({ outcome: `failed: ${msg.slice(0, 200)}` })
                        .eq('id', activity.id);
                    failed++;
                    log.error({ err: sendErr, enrollmentId: enrollment.id }, 'Campaign email send failed');
                    // Keep enrollment on current step — retry on next scheduler tick
                    await supabaseAdmin.from('campaign_enrollments')
                        .update({ next_scheduled_at: new Date(Date.now() + 5 * 60_000).toISOString() })
                        .eq('id', enrollment.id);
                    continue;
                }
            } else if (currentStep.step_type === 'delay') {
                // Delay step — time has elapsed, just advance
                advanced++;
            }
            // condition step handling will be added in FUP phase

            // ── Advance to next step ───────────────────────────────────
            const nextStep = await findNextStep(enrollment.campaign_id, currentStep.step_order);

            if (!nextStep) {
                await completeEnrollment(enrollment.id);
            } else {
                // Wait-before modeli: sıradaki adımın kendi delay'i kadar bekleyip
                // işle. Email adımı (delay 0) → hemen; bekleme taşıyan adım → delay
                // sonra. Gönderim penceresi varsa açılışa clamp'lenir.
                await supabaseAdmin
                    .from('campaign_enrollments')
                    .update({
                        current_step_id: nextStep.id,
                        next_scheduled_at: new Date(scheduleMs(Date.now() + calcDelayMs(nextStep), campaign.settings)).toISOString(),
                    })
                    .eq('id', enrollment.id);
            }

        } catch (err) {
            log.error({ err, enrollmentId: enrollment.id }, 'Enrollment processing error');
            // Restore next_scheduled_at so enrollment isn't stuck forever
            try {
                await supabaseAdmin.from('campaign_enrollments')
                    .update({ next_scheduled_at: new Date(Date.now() + 5 * 60_000).toISOString() })
                    .eq('id', enrollment.id);
            } catch (retryErr) {
                log.error({ err: retryErr }, 'Failed to restore enrollment schedule');
            }
            failed++;
        }
    }

    if (sent > 0 || failed > 0 || advanced > 0) {
        log.info({ sent, failed, advanced }, 'Scheduler tick complete');
    }
    return { sent, failed, advanced };
}

async function completeEnrollment(enrollmentId: string): Promise<void> {
    await supabaseAdmin
        .from('campaign_enrollments')
        .update({ status: 'completed', completed_at: new Date().toISOString(), next_scheduled_at: null })
        .eq('id', enrollmentId);
}

async function markEnrollmentFailed(enrollmentId: string, reason: string): Promise<void> {
    await supabaseAdmin
        .from('campaign_enrollments')
        .update({ status: 'paused', next_scheduled_at: null })
        .eq('id', enrollmentId);
    log.warn({ enrollmentId, reason }, 'Enrollment paused due to error');
}

// Kampanya yeniden aktifleştirilince duraklamış (paused) kayıtları kaldıkları adımdan
// sürdürür: status → active, next_scheduled_at = şimdi (gönderim penceresine clamp'li).
// current_step_id korunur — kayıt baştan başlamaz, bulunduğu adımdan devam eder.
// Döndürdüğü: sürdürülen kayıt sayısı.
export async function resumePausedEnrollments(campaignId: string, tenantId: string, settings: any): Promise<number> {
    const resumeAt = new Date(scheduleMs(Date.now(), settings)).toISOString();
    const { data } = await supabaseAdmin
        .from('campaign_enrollments')
        .update({ status: 'active', next_scheduled_at: resumeAt })
        .eq('campaign_id', campaignId)
        .eq('tenant_id', tenantId)
        .eq('status', 'paused')
        .select('id');
    const count = data?.length || 0;
    if (count > 0) log.info({ campaignId, count }, 'Resumed paused enrollments');
    return count;
}

// Tek bir kaydı duraklat (yalnız 'active' iken). Sıradaki gönderim iptal olur.
export async function pauseEnrollment(enrollmentId: string, tenantId: string): Promise<boolean> {
    const { data } = await supabaseAdmin
        .from('campaign_enrollments')
        .update({ status: 'paused', next_scheduled_at: null })
        .eq('id', enrollmentId)
        .eq('tenant_id', tenantId)
        .eq('status', 'active')
        .select('id');
    return (data?.length || 0) > 0;
}

// Tek bir kaydı sürdür (yalnız 'paused' iken). Kaldığı adımdan, gönderim
// penceresine göre yeniden zamanlanır.
export async function resumeEnrollment(enrollmentId: string, tenantId: string, settings: any): Promise<boolean> {
    const resumeAt = new Date(scheduleMs(Date.now(), settings)).toISOString();
    const { data } = await supabaseAdmin
        .from('campaign_enrollments')
        .update({ status: 'active', next_scheduled_at: resumeAt })
        .eq('id', enrollmentId)
        .eq('tenant_id', tenantId)
        .eq('status', 'paused')
        .select('id');
    return (data?.length || 0) > 0;
}

// ── Reply Detection ────────────────────────────────────────────────────────

export async function cancelEnrollmentOnReply(senderEmail: string, tenantId: string): Promise<void> {
    const { data: contacts } = await supabaseAdmin
        .from('contacts')
        .select('id')
        .eq('tenant_id', tenantId)
        .ilike('email', senderEmail);

    if (!contacts?.length) return;

    const contactIds = contacts.map((c) => c.id);

    const { data: cancelled } = await supabaseAdmin
        .from('campaign_enrollments')
        .update({ status: 'replied', next_scheduled_at: null })
        .eq('status', 'active')
        .eq('tenant_id', tenantId)
        .in('contact_id', contactIds)
        .select('id, campaign_id');

    if (cancelled?.length) {
        log.info({ senderEmail, count: cancelled.length }, 'Enrollments cancelled on reply');
    }
}

// ── Campaign Stats ─────────────────────────────────────────────────────────

export interface CampaignStats {
    total_enrolled: number;
    active: number;
    completed: number;
    replied: number;
    paused: number;
    emails_sent: number;
    opens: number;
    clicks: number;
    replies: number;
    open_rate: number;
    click_rate: number;
    reply_rate: number;
    tracking_enabled: boolean;
}

export async function getCampaignStats(campaignId: string, tenantId: string): Promise<CampaignStats> {
    // Run enrollment counts + activity/event data in parallel (2 queries instead of 4)
    const [enrollmentRes, activityRes] = await Promise.all([
        supabaseAdmin
            .from('campaign_enrollments')
            .select('status')
            .eq('campaign_id', campaignId)
            .eq('tenant_id', tenantId),
        supabaseAdmin
            .from('activities')
            .select('id, outcome, campaign_email_events(event_type)')
            .eq('campaign_id', campaignId)
            .eq('tenant_id', tenantId)
            .eq('type', 'campaign_email'),
    ]);

    // Enrollment status counts
    const statusCounts: Record<string, number> = {};
    for (const e of enrollmentRes.data || []) {
        statusCounts[e.status] = (statusCounts[e.status] || 0) + 1;
    }
    const totalEnrolled = enrollmentRes.data?.length || 0;

    // Activity + event counts (single join query)
    let sentCount = 0;
    const openSet = new Set<string>();
    const clickSet = new Set<string>();

    for (const act of (activityRes.data || []) as any[]) {
        if (act.outcome !== 'sent') continue; // sadece gerçekten gönderilenler → oranlar %100'ü aşmaz
        sentCount++;
        for (const evt of act.campaign_email_events || []) {
            if (evt.event_type === 'open') openSet.add(act.id);
            if (evt.event_type === 'click') clickSet.add(act.id);
        }
    }

    const opens = openSet.size;
    const clicks = clickSet.size;
    // Yanıtlar enrollment durumundan gelir: IMAP/webhook yanıt yakalayınca 'replied'
    // yapıyor. campaign_email_events'e 'reply' yazan bir yol yok, o yüzden esas kaynak
    // durum sayısıdır (kart ile durum çubuğu böylece tutarlı olur).
    const replied = statusCounts['replied'] || 0;

    return {
        total_enrolled: totalEnrolled,
        active: statusCounts['active'] || 0,
        completed: statusCounts['completed'] || 0,
        replied,
        paused: statusCounts['paused'] || 0,
        emails_sent: sentCount,
        opens, clicks, replies: replied,
        open_rate: sentCount > 0 ? opens / sentCount : 0,
        click_rate: sentCount > 0 ? clicks / sentCount : 0,
        reply_rate: sentCount > 0 ? replied / sentCount : 0,
        // Açılma/tıklama pikseli yalnız API_BASE_URL tanımlıysa enjekte edilir
        // (localhost'ta alıcı erişemez). UI bu sayıların neden boş olduğunu açıklar.
        tracking_enabled: !!API_BASE,
    };
}
