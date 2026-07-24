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
    // ── Graf alanları (Faz 2, migration 057) — hepsi opsiyonel; pointer yoksa
    //    engine step_order zincirine düşer (geriye-uyumlu). ──
    step_kind?: 'email' | 'delay' | 'condition' | 'split' | 'action' | null;
    next_step_id?: string | null;
    condition_type?: string | null;
    condition_wait_hours?: number | null;
    condition_true_step_id?: string | null;
    condition_false_step_id?: string | null;
    config?: Record<string, any> | null;
    is_entry?: boolean | null;
}

// Graf gezinme/koşul değerlendirmesi için enrollment'tan ihtiyaç duyulan alanlar.
interface EnrollmentRef {
    id: string;
    campaign_id: string;
    status?: string | null;
    branch_path?: string | null;
    replied_at?: string | null;
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

export async function resolveTemplate(tenantId: string, contactId: string, companyId: string): Promise<TemplateCtx> {
    const [cRes, coRes] = await Promise.all([
        supabaseAdmin.from('contacts').select('first_name, last_name, email, title').eq('id', contactId).eq('tenant_id', tenantId).single(),
        supabaseAdmin.from('companies').select('name, website, industry').eq('id', companyId).eq('tenant_id', tenantId).single(),
    ]);
    const c = cRes.data;
    const co = coRes.data;
    return {
        first_name: c?.first_name || '', last_name: c?.last_name || '',
        email: c?.email || '', title: c?.title || '',
        company_name: co?.name || '', website: co?.website || '', industry: co?.industry || '',
    };
}

export function applyTemplate(template: string, ctx: TemplateCtx): string {
    let result = template;
    for (const key of TEMPLATE_KEYS) {
        result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi'), ctx[key] || '');
    }
    return result;
}

// Spintax: {{random|A|B|C}} → her gönderimde rastgele bir seçenek. Boş seçenek
// (ör. {{random|please|}}) atlamayı sağlar. Seçenekler {{first_name}} gibi tek
// seviye değişken içerebilir (değişkenler spintax çözüldükten sonra uygulanır).
export function applySpintax(template: string): string {
    return template.replace(/\{\{\s*random\s*\|((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/gi, (_m, group: string) => {
        const opts = group.split('|');
        return (opts[Math.floor(Math.random() * opts.length)] || '').trim();
    });
}

// CSV'den gelen düz metin hazır mesajı e-posta HTML'ine çevirir: HTML escape →
// boş satır(lar) paragraf sınırı, tekil satır sonu <br>. Tracking + unsubscribe
// enjeksiyonu bu çıktı üzerinde değişmeden çalışır.
export function plainTextToHtml(text: string): string {
    const escaped = text
        .replace(/\r\n/g, '\n')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return escaped
        .split(/\n{2,}/)
        .map((p) => `<p style="margin:0 0 1em">${p.replace(/\n/g, '<br>')}</p>`)
        .join('');
}

// Giriş adımı mı? enrollLeads ile aynı kural: is_entry işaretli node, o yoksa en
// küçük step_order'lı adım. Yalnız custom-body'li (CSV importlu) gönderimlerde
// çağrılır — satır bazlı hazır mesaj follow-up adımlarına uygulanmasın diye.
async function isEntryStep(step: CampaignStep): Promise<boolean> {
    if (step.is_entry) return true;
    const { data } = await supabaseAdmin
        .from('campaign_steps')
        .select('id, is_entry, step_order')
        .eq('campaign_id', step.campaign_id)
        .order('step_order');
    if (!data?.length) return false;
    if (data.some((s) => s.is_entry)) return false; // giriş başka bir node
    return data[0].id === step.id;
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

// Graf gezinme: bitirilen node + enrollment'a göre sıradaki node id'sini çözer.
// - condition → olay geçmişine göre true/false dalı (+ branch_path segmenti)
// - email/wait/split/action/lineer → açık next_step_id; pointer yoksa step_order
//   zincirine düşer (eski/lineer kayıtlar için geriye-uyumlu).
async function resolveNextStep(
    step: CampaignStep,
    enrollment: EnrollmentRef,
): Promise<{ nextStepId: string | null; branchSegment?: string }> {
    const kind = step.step_kind || step.step_type;

    if (kind === 'condition') {
        const passed = await evaluateCondition(step, enrollment);
        return {
            nextStepId: (passed ? step.condition_true_step_id : step.condition_false_step_id) || null,
            branchSegment: passed ? 'y' : 'n',
        };
    }

    // email / wait / split / action / lineer: açık pointer öncelikli.
    if (step.next_step_id) return { nextStepId: step.next_step_id };

    // Fallback: pointer set edilmemiş (eski kayıt / legacy save) → step_order zinciri.
    const next = await findNextStep(enrollment.campaign_id, step.step_order);
    return { nextStepId: next?.id || null };
}

// Bir condition node'unun koşulunu BU enrollment için değerlendirir.
// ÖNEMLİ: açılma/tıklama olayları campaign_email_events.enrollment_id'de DOLU DEĞİL
// (tracking yalnız activity_id yazıyor); bu yüzden activities.enrollment_id üzerinden
// join edilir — event satırının enrollment_id'si DOĞRUDAN kullanılmamalı (hep null).
// config.eval_step_order verilmişse yalnız o adımın maili kontrol edilir (yoksa herhangi
// bir mail "açıldı mı" sayılırdı). 'replied' kalıcı replied_at işaretinden okunur —
// status DEĞİL: yanıt gelince enrollment status'u 'replied' olup scheduler havuzundan
// çıktığı için condition'a hiç ulaşamazdı (bkz. cancelEnrollmentOnReply).
async function evaluateCondition(step: CampaignStep, enrollment: EnrollmentRef): Promise<boolean> {
    const ct = step.condition_type || 'opened';
    if (ct === 'replied') return !!enrollment.replied_at;
    if (ct === 'not_replied') return !enrollment.replied_at;

    const wantType = ct.includes('open') ? 'open' : 'click';
    const evalOrder = step.config ? Number((step.config as any).eval_step_order) : NaN;

    let q = supabaseAdmin
        .from('campaign_email_events')
        .select('id, activities!inner(enrollment_id, campaign_step_order)')
        .eq('event_type', wantType)
        .eq('activities.enrollment_id', enrollment.id);
    if (Number.isFinite(evalOrder)) q = q.eq('activities.campaign_step_order', evalOrder);
    const { data } = await q.limit(1);

    const happened = (data?.length || 0) > 0;
    return ct.startsWith('not_') ? !happened : happened;
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

// İnsansı gönderim: baseMs'e 0..jitter_minutes arası rastgele gecikme ekler — saniye
// çözünürlüğünde (dakikaya yuvarlamadan), böylece gönderimler tam dakika sınırına
// oturmaz. Robotik, eşit aralıklı gönderimi kırar. Pencere clamp'inden ÖNCE uygulanır
// ki jitter pencere içinde kalsın. jitter_minutes yoksa/0 ise aynen döner.
function applyJitter(baseMs: number, settings: any): number {
    const j = Number(settings?.jitter_minutes) || 0;
    if (j <= 0) return baseMs;
    // 0..(j*60) saniye arası rastgele → dakika değil saniye düzeyinde dağılım
    const maxSeconds = j * 60;
    return baseMs + Math.floor(Math.random() * maxSeconds) * 1000;
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

// Kampanyanın bugün gönderdiği FOLLOW-UP (intro dışı, step_order>1) mail sayısı —
// rampalı follow-up payı kontrolü için.
async function countFollowupSentToday(campaignId: string, timeZone: string): Promise<number> {
    const dayStart = startOfLocalDay(Date.now(), timeZone);
    const { count } = await supabaseAdmin
        .from('activities')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .eq('type', 'campaign_email')
        .eq('outcome', 'sent')
        .gt('campaign_step_order', 1)
        .gte('occurred_at', new Date(dayStart).toISOString());
    return count || 0;
}

// Hâlâ giriş (intro) adımında bekleyen aktif enrollment sayısı — follow-up cap'i
// yalnız intro'lar tükenene kadar uygulansın diye. Giriş adımı = en küçük step_order'lı
// email adımı (wizard/graf intro'yu step_order 1 kurar).
async function countPendingIntros(campaignId: string): Promise<number> {
    const { data: entry } = await supabaseAdmin
        .from('campaign_steps')
        .select('id')
        .eq('campaign_id', campaignId)
        .eq('step_type', 'email')
        .order('step_order', { ascending: true })
        .limit(1)
        .maybeSingle();
    if (!entry?.id) return 0;
    const { count } = await supabaseAdmin
        .from('campaign_enrollments')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .eq('status', 'active')
        .eq('current_step_id', entry.id);
    return count || 0;
}

// Kampanyanın ilk gönderim gününden bugüne geçen tam gün sayısı (rampa anchor'ı).
// Hiç gönderim yoksa 0.
async function campaignDaysSinceStart(campaignId: string, timeZone: string): Promise<number> {
    const { data } = await supabaseAdmin
        .from('activities')
        .select('occurred_at')
        .eq('campaign_id', campaignId)
        .eq('type', 'campaign_email')
        .eq('outcome', 'sent')
        .order('occurred_at', { ascending: true })
        .limit(1)
        .maybeSingle();
    if (!data?.occurred_at) return 0;
    const firstDay = startOfLocalDay(new Date(data.occurred_at).getTime(), timeZone);
    const today = startOfLocalDay(Date.now(), timeZone);
    return Math.max(0, Math.round((today - firstDay) / 86_400_000));
}

// Bir gönderen kutusunun bugün (yerel gün) gönderdiği mail sayısı — kutu-başı limit
// için. Kampanyalar arası sayar (kutu itibarını korumak tenant geneli olmalı).
async function countSentTodayForAccount(tenantId: string, account: string, timeZone: string): Promise<number> {
    const dayStart = startOfLocalDay(Date.now(), timeZone);
    const { count } = await supabaseAdmin
        .from('activities')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('type', 'campaign_email')
        .eq('outcome', 'sent')
        .eq('sending_account', account)
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

    // Graf giriş node'u (is_entry); yoksa en küçük step_order'lı adım (geriye-uyumlu).
    const firstStep = ((steps as CampaignStep[]).find((s) => s.is_entry) || steps[0]) as CampaignStep;

    // Wait-before-email modeli: her adımın kendi delay'i "bu maili göndermeden
    // önce bekle" demektir. İlk adımın delay'i (genelde 0 = hemen) kayıt anından
    // itibaren sayılır. Gönderim penceresi varsa açılışa clamp'lenir.
    // Legacy 'delay' düğümleri de aynı hesapla doğru çalışır.
    const firstScheduleAt = new Date(scheduleMs(applyJitter(Date.now() + calcDelayMs(firstStep), campaign.settings), campaign.settings)).toISOString();

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

// CSV alıcı importu için: kampanyanın giriş adımı + ilk gönderim zamanı.
// enrollLeads ile birebir aynı kural (is_entry işaretli node, yoksa en küçük
// step_order; jitter + gönderim penceresi clamp'i). Giriş adımı email değilse
// 422 — satır bazlı hazır mesaj giriş mailine uygulanır; hiçbir yazım yapılmadan
// reddedilir ki yarım import oluşmasın.
export async function getEntryStepSchedule(
    campaignId: string,
    tenantId: string,
): Promise<{ entryStepId: string; firstScheduleAt: string; settings: any }> {
    const { data: campaign, error } = await supabaseAdmin
        .from('campaigns')
        .select('id, settings')
        .eq('id', campaignId)
        .eq('tenant_id', tenantId)
        .single();
    if (error || !campaign) throw new AppError('Campaign not found', 404);

    const { data: steps } = await supabaseAdmin
        .from('campaign_steps')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('step_order');
    if (!steps?.length) throw new AppError('Campaign has no steps', 422);

    const entry = ((steps as CampaignStep[]).find((s) => s.is_entry) || steps[0]) as CampaignStep;
    if ((entry.step_kind || entry.step_type) !== 'email') {
        throw new AppError('Campaign entry step must be an email step', 422);
    }

    const firstScheduleAt = new Date(
        scheduleMs(applyJitter(Date.now() + calcDelayMs(entry), campaign.settings), campaign.settings),
    ).toISOString();
    return { entryStepId: entry.id, firstScheduleAt, settings: campaign.settings || {} };
}

// ── Scheduled Email Processing ─────────────────────────────────────────────

export async function processScheduledEmails(): Promise<{ sent: number; failed: number; advanced: number }> {
    // Drip emails go out via Nango (user's own Gmail/Outlook) or a connected SMTP
    // mailbox. Nango yoksa: aktif SMTP bağlantısı olan tenant olabilir — tick'i
    // ancak hiçbir SMTP kutusu da yoksa atla (Nango'lu prod davranışı birebir aynı).
    if (!process.env.NANGO_SECRET_KEY) {
        const { count: smtpCount } = await supabaseAdmin
            .from('email_connections')
            .select('id', { count: 'exact', head: true })
            .eq('provider', 'smtp')
            .eq('is_active', true);
        if (!smtpCount) return { sent: 0, failed: 0, advanced: 0 };
    }

    // Kurtarma (#1): tick ortasında process ölürse (deploy/OOM/restart) claim edilmiş
    // enrollment 'active' + next_scheduled_at=NULL kalır; due sorgusu onu asla seçmez
    // (NULL <= now değil) → sessizce düşer. Bu tür bayat (updated_at eski) kayıtları
    // yeniden zamanla. Eşik 5 dk: tek tick'in makul süresinden uzun, böylece
    // ŞU AN işlenmekte olan (taze updated_at) kayda dokunulmaz.
    await recoverStuckEnrollments();

    const { data: dueEnrollments, error } = await supabaseAdmin
        .from('campaign_enrollments')
        .select(`
            id, tenant_id, campaign_id, contact_id, company_id, email,
            current_step_id, next_scheduled_at, branch_path, status, replied_at,
            custom_subject, custom_body_text, step_messages, excluded_reason
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

                // #2 — Idempotency guard: bu enrollment bu adım için zaten gönderilmiş/
                // denenmiş mi? Önceki tick'te sendMail başarılı olup mark-sent ya da
                // ilerletme yarıda kaldıysa aktivite 'sent'/'sending' kalır — bu tick
                // ASLA resend etmemeli (mükerrer cold mail = spam şikayeti). Varsa
                // göndermeyi atla, yalnız ilerlet.
                const { data: priorSend } = await supabaseAdmin
                    .from('activities')
                    .select('id')
                    .eq('enrollment_id', enrollment.id)
                    .eq('campaign_step_order', currentStep.step_order)
                    .eq('type', 'campaign_email')
                    .in('outcome', ['sent', 'sending'])
                    .limit(1)
                    .maybeSingle();

                if (priorSend) {
                    log.warn({ enrollmentId: enrollment.id, step: currentStep.step_order },
                        'Email already sent for this step — advancing without resend');
                    await advanceEnrollment(currentStep, enrollment, campaign.settings);
                    continue;
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

                    // Follow-up payı (rampalı): follow-up adımları (step_order>1) günlük
                    // limitin en fazla "share%"ini kullanır; intro'lar kalanı doldurur.
                    // Share hafta hafta artar (kampanyanın ilk gönderim gününden itibaren):
                    // erken günler intro-ağırlıklı, sonra follow-up payı açılır. Intro'lar
                    // bu kapıya takılmaz (yalnız genel günlük limit) → boşta kalan follow-up
                    // payını backfill eder.
                    const ramp = settings.followup_ramp as { start_pct?: number; weekly_step_pct?: number; max_pct?: number } | undefined;
                    if (ramp && currentStep.step_order > 1) {
                        // Cap yalnız HÂLÂ gönderilmemiş intro varken uygulanır → intro'lar
                        // bittiğinde follow-up'lar tam günlük limiti kullanır (hiçbir intro
                        // starve olmaz; kalan follow-up'lar da eninde sonunda gider).
                        const pendingIntros = await countPendingIntros(enrollment.campaign_id);
                        if (pendingIntros > 0) {
                            const daysSince = await campaignDaysSinceStart(enrollment.campaign_id, tz);
                            const share = Math.min(ramp.max_pct ?? 100,
                                (ramp.start_pct ?? 25) + Math.floor(daysSince / 7) * (ramp.weekly_step_pct ?? 25));
                            // İntro'lara her zaman en az 1 slot bırak (daily_limit-1) → asla starve olmaz.
                            const followupCap = Math.max(0, Math.min(
                                Math.ceil(settings.daily_limit * Math.max(0, Math.min(100, share)) / 100),
                                settings.daily_limit - 1,
                            ));
                            const fuSentToday = await countFollowupSentToday(enrollment.campaign_id, tz);
                            if (fuSentToday >= followupCap) {
                                // Bugünkü follow-up payı doldu → ertesi güne ertele (intro'lar slotları kullanır).
                                const nextOpen = scheduleMs(startOfNextLocalDay(nowMs, tz), settings);
                                await supabaseAdmin.from('campaign_enrollments')
                                    .update({ next_scheduled_at: new Date(nextOpen).toISOString() })
                                    .eq('id', enrollment.id);
                                continue;
                            }
                        }
                    }
                }

                // Gönderen kutusu (rotasyon/varsayılan) — aktivite kaydı ve gönderim
                // aynı kutuyu kullansın diye burada bir kez çözülür.
                const accountEmail = await resolveAccountEmail(enrollment.tenant_id, campaign.settings, enrollment.id);

                // Kutu-başı günlük limit: seçilen kutu bugünkü tavanını doldurduysa bu
                // kişiyi ertesi günün açılışına ertele (kutu itibarını korur, tenant geneli sayar).
                if (accountEmail && settings.per_inbox_limit && settings.per_inbox_limit > 0) {
                    const accountSentToday = await countSentTodayForAccount(enrollment.tenant_id, accountEmail, tz);
                    if (accountSentToday >= settings.per_inbox_limit) {
                        const nextOpen = scheduleMs(startOfNextLocalDay(nowMs, tz), settings);
                        await supabaseAdmin.from('campaign_enrollments')
                            .update({ next_scheduled_at: new Date(nextOpen).toISOString() })
                            .eq('id', enrollment.id);
                        continue;
                    }
                }

                // Resolve spintax (gönderim başına rastgele) → sonra değişkenler.
                const ctx = await resolveTemplate(enrollment.tenant_id, enrollment.contact_id, enrollment.company_id);
                let subject = applyTemplate(applySpintax(currentStep.subject || ''), ctx);
                let bodyHtml = applyTemplate(applySpintax(currentStep.body_html || ''), ctx);

                // CSV importlu alıcının per-adım hazır mesajı şablonun yerine geçer
                // (final metin; spintax/değişken uygulanmaz). Öncelik: step_messages[stepId]
                // (follow-up dahil her adım), yoksa GİRİŞ adımı için eski tek-kolon
                // (geriye uyum). İkisi de yoksa adım şablonu kalır.
                const stepMsg = (enrollment.step_messages as Record<string, { subject?: string | null; body?: string | null }> | null)?.[currentStep.id];
                let customBody: string | null = null;
                let customSubj: string | null = null;
                if (stepMsg) {
                    customBody = stepMsg.body ?? null;
                    customSubj = stepMsg.subject ?? null;
                } else if (await isEntryStep(currentStep)) {
                    customBody = enrollment.custom_body_text ?? null;
                    customSubj = enrollment.custom_subject ?? null;
                }
                let usedCustomBody = false;
                if (customBody) { bodyHtml = plainTextToHtml(customBody); usedCustomBody = true; }
                if (customSubj) subject = customSubj;

                // Create activity first (we need the ID for tracking)
                const { data: activity, error: actErr } = await supabaseAdmin
                    .from('activities')
                    .insert({
                        tenant_id: enrollment.tenant_id,
                        company_id: enrollment.company_id,
                        contact_id: enrollment.contact_id,
                        type: 'campaign_email',
                        summary: subject,
                        detail: (usedCustomBody ? (customBody || '') : (currentStep.body_html || '')).slice(0, 500), // snippet for timeline
                        outcome: 'sending',
                        campaign_id: enrollment.campaign_id,
                        enrollment_id: enrollment.id,
                        sending_account: accountEmail || null,
                        campaign_step_order: currentStep.step_order, // adım-bazlı analiz için
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

                // Inject tracking (kampanya açılma/tıklama toggle'larına göre) + unsubscribe.
                // tracking tanımsızsa ikisi de açık (geriye dönük uyum).
                const trk = campaign.settings?.tracking;
                bodyHtml = injectTracking(bodyHtml, activity.id, 'activity', {
                    open: trk?.open !== false,
                    click: trk?.click !== false,
                });
                bodyHtml += buildUnsubscribeFooter(enrollment.id);

                // CC: campaign-level override > tenant-level default
                const ccAddresses: string[] = (campaign.settings?.cc
                    || tenantSettings.cc_addresses?.map((a: any) => a.email)
                    || []);
                // Gönderen adı kutuya ait (tüm kampanyalarda ortak); yoksa kampanya from_name'i.
                const senderNames = tenantSettings.sender_names || {};
                const fromName = senderNames[(accountEmail || '').toLowerCase()] || campaign.from_name || undefined;

                // #2 — Gönderimi bookkeeping'den AYIR: sendMail başarılıysa mail GİTMİŞTİR;
                // ondan sonraki hiçbir DB hatası aktiviteyi 'failed' yapmamalı ve resend'e
                // yol açmamalı. Yalnız sendMail'in KENDİSİ başarısızsa +5 dk retry edilir.
                let sendOk = false;
                let sendErrMsg = '';
                let sendBounced = false; // SMTP 5xx = hard bounce (retry etme, enrollment'ı durdur)
                try {
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
                    sendOk = !!result.success;
                    if (!sendOk) sendErrMsg = 'Send failed';
                } catch (sendErr) {
                    sendErrMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
                    sendBounced = !!(sendErr as { permanentBounce?: boolean })?.permanentBounce;
                }

                if (!sendOk) {
                    if (sendBounced) {
                        // Hard bounce (alıcı MX kalıcı reddi) → enrollment 'bounced', retry YOK,
                        // follow-up gönderilmez. Analytics'teki bounce metriği buradan dolar.
                        await supabaseAdmin.from('activities')
                            .update({ outcome: `bounced: ${sendErrMsg.slice(0, 200)}` })
                            .eq('id', activity.id);
                        await supabaseAdmin.from('campaign_enrollments')
                            .update({ status: 'bounced', next_scheduled_at: null })
                            .eq('id', enrollment.id);
                        failed++;
                        log.warn({ enrollmentId: enrollment.id, to: enrollment.email }, 'Hard bounce — enrollment marked bounced');
                        continue;
                    }
                    await supabaseAdmin.from('activities')
                        .update({ outcome: `failed: ${sendErrMsg.slice(0, 200)}` })
                        .eq('id', activity.id);
                    failed++;
                    log.error({ err: sendErrMsg, enrollmentId: enrollment.id }, 'Campaign email send failed');
                    // Geçici hata → adımda kal, sonraki tick'te retry (idempotency guard resend'i engeller).
                    await supabaseAdmin.from('campaign_enrollments')
                        .update({ next_scheduled_at: new Date(Date.now() + 5 * 60_000).toISOString() })
                        .eq('id', enrollment.id);
                    continue;
                }

                // ── SEND SUCCEEDED — bundan sonra resend YOK ──
                sent++;
                // mark-sent best-effort: hata olsa bile mail gitti; aktivite 'sending' kalır
                // ve sonraki tick'te idempotency guard onu yakalayıp mükerrer gönderimi önler.
                const { error: markErr } = await supabaseAdmin.from('activities')
                    .update({ outcome: 'sent' }).eq('id', activity.id);
                if (markErr) log.error({ err: markErr, enrollmentId: enrollment.id }, 'Mark-sent failed (non-fatal; email already delivered)');
                log.info({ enrollmentId: enrollment.id, to: enrollment.email, activityId: activity.id }, 'Campaign email sent');
            } else {
                // email DIŞI node'lar (delay/wait/condition/split/action) mail göndermez —
                // sadece ilerletir. (Aksiyon node yürütmesi Batch 5'te eklenecek.)
                // Condition node burada "beklemesi" zaten doldu; aşağıdaki resolveNextStep
                // koşulu değerlendirip dalı seçer.
                advanced++;
            }

            // ── Sıradaki adıma ilerlet (email gönderimi + email-dışı node ortak yol) ──
            await advanceEnrollment(currentStep, enrollment, campaign.settings);

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

// #1 — Takılı enrollment kurtarma: 'active' + next_scheduled_at=NULL, üstelik
// updated_at 5 dk'dan eski olanları yeniden zamanlar (next_scheduled_at=now).
// Bunlar yalnız claim edilip (next_scheduled_at null'landı) işlenemeden process
// ölen kayıtlardır — normalde active bir kaydın next_scheduled_at'i hep dolu olur.
// Taze updated_at'liler (şu an işlenen claim'ler) eşiğin altında kalır, dokunulmaz.
async function recoverStuckEnrollments(): Promise<number> {
    const staleCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    const { data, error } = await supabaseAdmin
        .from('campaign_enrollments')
        .update({ next_scheduled_at: new Date().toISOString() })
        .eq('status', 'active')
        .is('next_scheduled_at', null)
        .lt('updated_at', staleCutoff)
        .select('id');
    if (error) { log.error({ err: error }, 'Stuck-enrollment recovery failed'); return 0; }
    const n = data?.length || 0;
    if (n > 0) log.warn({ recovered: n }, 'Recovered stuck enrollments (active + next_scheduled_at NULL)');
    return n;
}

// Enrollment'ı sıradaki adıma ilerletir (graf pointer/koşul; yoksa step_order fallback).
// Gönderimden AYRI tutulur (#2): email başarıyla gittikten sonra çağrılır, böylece
// gönderim-sonrası bir DB hatası tick'i patlatsa bile idempotency guard resend'i engeller.
async function advanceEnrollment(currentStep: CampaignStep, enrollment: EnrollmentRef, campaignSettings: any): Promise<void> {
    const { nextStepId, branchSegment } = await resolveNextStep(currentStep, enrollment);
    if (!nextStepId) { await completeEnrollment(enrollment.id); return; }

    const { data: nextRow } = await supabaseAdmin
        .from('campaign_steps').select('*').eq('id', nextStepId).single();
    if (!nextRow) { await completeEnrollment(enrollment.id); return; } // kopuk kenar → güvenli durdur

    const nextStep = nextRow as CampaignStep;
    const nextKind = nextStep.step_kind || nextStep.step_type;
    // Wait-before modeli: sıradaki node'un delay'i kadar bekle. Condition node
    // condition_wait_hours kadar oturur. Gönderim penceresi varsa açılışa clamp'lenir.
    const delayMs = nextKind === 'condition'
        ? (nextStep.condition_wait_hours ?? 72) * 3_600_000
        : calcDelayMs(nextStep);
    const newPath = branchSegment
        ? `${enrollment.branch_path || '/'}${branchSegment}/`
        : (enrollment.branch_path || '/');
    await supabaseAdmin
        .from('campaign_enrollments')
        .update({
            current_step_id: nextStep.id,
            branch_path: newPath,
            next_scheduled_at: new Date(scheduleMs(applyJitter(Date.now() + delayMs, campaignSettings), campaignSettings)).toISOString(),
        })
        .eq('id', enrollment.id);
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
        .is('excluded_reason', null) // invalid/dnc/statü-dışı satırlar toplu resume ile açılmaz
        .select('id');
    const count = data?.length || 0;
    if (count > 0) log.info({ campaignId, count }, 'Resumed paused enrollments');
    return count;
}

// Tek bir kaydı duraklat (yalnız 'active' iken). Sıradaki gönderim iptal olur.
export async function pauseEnrollment(campaignId: string, enrollmentId: string, tenantId: string): Promise<boolean> {
    const { data } = await supabaseAdmin
        .from('campaign_enrollments')
        .update({ status: 'paused', next_scheduled_at: null })
        .eq('id', enrollmentId)
        .eq('campaign_id', campaignId)
        .eq('tenant_id', tenantId)
        .eq('status', 'active')
        .select('id');
    return (data?.length || 0) > 0;
}

// Tek bir kaydı sürdür (yalnız 'paused' iken). Kaldığı adımdan, gönderim
// penceresine göre yeniden zamanlanır. excluded_reason da temizlenir — tekil
// resume, kilitli (invalid/dnc/statü-dışı) satır için bilinçli kullanıcı override'ıdır.
export async function resumeEnrollment(campaignId: string, enrollmentId: string, tenantId: string, settings: any): Promise<boolean> {
    const resumeAt = new Date(scheduleMs(Date.now(), settings)).toISOString();
    const { data } = await supabaseAdmin
        .from('campaign_enrollments')
        .update({ status: 'active', next_scheduled_at: resumeAt, excluded_reason: null })
        .eq('id', enrollmentId)
        .eq('campaign_id', campaignId)
        .eq('tenant_id', tenantId)
        .eq('status', 'paused')
        .select('id');
    return (data?.length || 0) > 0;
}

// Toplu duraklat — yalnız 'active' kayıtlar etkilenir; etkilenen sayısını döner.
export async function bulkPauseEnrollments(campaignId: string, ids: string[], tenantId: string): Promise<number> {
    const { data } = await supabaseAdmin
        .from('campaign_enrollments')
        .update({ status: 'paused', next_scheduled_at: null })
        .in('id', ids)
        .eq('campaign_id', campaignId)
        .eq('tenant_id', tenantId)
        .eq('status', 'active')
        .select('id');
    return data?.length || 0;
}

// Toplu sürdür — yalnız 'paused' kayıtlar; gönderim penceresine göre yeniden zamanlanır.
// Kilitli (excluded_reason dolu) satırlar toplu işlemle açılmaz; yalnız tekil resume açar.
export async function bulkResumeEnrollments(campaignId: string, ids: string[], tenantId: string, settings: any): Promise<number> {
    const resumeAt = new Date(scheduleMs(Date.now(), settings)).toISOString();
    const { data } = await supabaseAdmin
        .from('campaign_enrollments')
        .update({ status: 'active', next_scheduled_at: resumeAt })
        .in('id', ids)
        .eq('campaign_id', campaignId)
        .eq('tenant_id', tenantId)
        .eq('status', 'paused')
        .is('excluded_reason', null)
        .select('id');
    return data?.length || 0;
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

    // Yanıtlayan kişinin aktif/duraklı enrollment'ları.
    const { data: enrollments } = await supabaseAdmin
        .from('campaign_enrollments')
        .select('id, campaign_id')
        .in('status', ['active', 'paused'])
        .eq('tenant_id', tenantId)
        .in('contact_id', contactIds);

    if (!enrollments?.length) return;

    // Yanıt anını her durumda kalıcı işaretle — reply-condition node'ları bunu okur
    // (status='replied' enrollment scheduler'dan düştüğü için condition'a ulaşamazdı).
    await supabaseAdmin
        .from('campaign_enrollments')
        .update({ replied_at: new Date().toISOString() })
        .in('id', enrollments.map((e) => e.id));

    // Reply-condition'ı (replied/not_replied) olan kampanyalardaki enrollment'lar
    // SONLANDIRILMAZ — condition node'una ulaşıp dallanabilsinler. Diğer (lineer)
    // kampanyalarda eski iptal davranışı aynen korunur. Bugün hiçbir kampanyada
    // reply-condition yok → bu dal dormant, mevcut davranış değişmez.
    const campaignIds = [...new Set(enrollments.map((e) => e.campaign_id))];
    const { data: replyCondSteps } = await supabaseAdmin
        .from('campaign_steps')
        .select('campaign_id')
        .in('campaign_id', campaignIds)
        .in('condition_type', ['replied', 'not_replied']);
    const branchingCampaigns = new Set((replyCondSteps || []).map((s) => s.campaign_id));

    const toCancel = enrollments.filter((e) => !branchingCampaigns.has(e.campaign_id)).map((e) => e.id);
    if (toCancel.length) {
        await supabaseAdmin
            .from('campaign_enrollments')
            .update({ status: 'replied', next_scheduled_at: null })
            .in('id', toCancel);
    }

    log.info(
        { senderEmail, total: enrollments.length, cancelled: toCancel.length, kept: enrollments.length - toCancel.length },
        'Reply processed on enrollments',
    );
}

// ── Campaign Stats ─────────────────────────────────────────────────────────

export interface CampaignStats {
    total_enrolled: number;
    active: number;
    completed: number;
    replied: number;
    paused: number;
    bounced: number;
    unsubscribed: number;
    emails_sent: number;
    opens: number;
    clicks: number;
    replies: number;
    open_rate: number;
    click_rate: number;
    reply_rate: number;
    bounce_rate: number;
    by_account: { account: string; sent: number }[];
    daily: { date: string; sent: number; opens: number }[];
    by_step: { step: number; sent: number; opens: number; clicks: number }[];
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
            .select('id, outcome, occurred_at, sending_account, campaign_step_order, campaign_email_events(event_type)')
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
    const byAccount: Record<string, number> = {};       // kutu-başı gönderim
    const dailyMap: Record<string, { sent: number; opens: number }> = {}; // gün-başı (UTC)
    const byStep: Record<number, { sent: number; opens: number; clicks: number }> = {}; // adım-başı

    for (const act of (activityRes.data || []) as any[]) {
        if (act.outcome !== 'sent') continue; // sadece gerçekten gönderilenler → oranlar %100'ü aşmaz
        sentCount++;

        const acct = act.sending_account || '—';
        byAccount[acct] = (byAccount[acct] || 0) + 1;

        const events = act.campaign_email_events || [];
        const hasOpen = events.some((e: any) => e.event_type === 'open');
        const hasClick = events.some((e: any) => e.event_type === 'click');

        const day = (act.occurred_at || '').slice(0, 10); // YYYY-MM-DD (UTC)
        if (day) {
            const d = dailyMap[day] || (dailyMap[day] = { sent: 0, opens: 0 });
            d.sent++;
            if (hasOpen) d.opens++;
        }

        // Adım kırılımı — yalnız step_order bilinen (yeni) kayıtlar.
        if (typeof act.campaign_step_order === 'number') {
            const s = byStep[act.campaign_step_order] || (byStep[act.campaign_step_order] = { sent: 0, opens: 0, clicks: 0 });
            s.sent++;
            if (hasOpen) s.opens++;
            if (hasClick) s.clicks++;
        }

        if (hasOpen) openSet.add(act.id);
        if (hasClick) clickSet.add(act.id);
    }

    const opens = openSet.size;
    const clicks = clickSet.size;
    // Kutu-başı: gönderim sayısına göre azalan
    const by_account = Object.entries(byAccount)
        .map(([account, sent]) => ({ account, sent }))
        .sort((a, b) => b.sent - a.sent);
    // Zaman serisi: son 14 gün (tarihe göre artan)
    const daily = Object.entries(dailyMap)
        .map(([date, v]) => ({ date, sent: v.sent, opens: v.opens }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-14);
    // Adım kırılımı: adım sırasına göre artan
    const by_step = Object.entries(byStep)
        .map(([step, v]) => ({ step: Number(step), sent: v.sent, opens: v.opens, clicks: v.clicks }))
        .sort((a, b) => a.step - b.step);
    // Yanıtlar enrollment durumundan gelir: IMAP/webhook yanıt yakalayınca 'replied'
    // yapıyor. campaign_email_events'e 'reply' yazan bir yol yok, o yüzden esas kaynak
    // durum sayısıdır (kart ile durum çubuğu böylece tutarlı olur).
    const replied = statusCounts['replied'] || 0;
    const bounced = statusCounts['bounced'] || 0;
    // Bounce oranı: gönderim denemelerinin (giden + bounce) yüzde kaçı bounce etti.
    const attempts = sentCount + bounced;

    return {
        total_enrolled: totalEnrolled,
        active: statusCounts['active'] || 0,
        completed: statusCounts['completed'] || 0,
        replied,
        paused: statusCounts['paused'] || 0,
        bounced,
        unsubscribed: statusCounts['unsubscribed'] || 0,
        emails_sent: sentCount,
        opens, clicks, replies: replied,
        open_rate: sentCount > 0 ? opens / sentCount : 0,
        click_rate: sentCount > 0 ? clicks / sentCount : 0,
        reply_rate: sentCount > 0 ? replied / sentCount : 0,
        bounce_rate: attempts > 0 ? bounced / attempts : 0,
        by_account,
        daily,
        by_step,
        // Açılma/tıklama pikseli yalnız API_BASE_URL tanımlıysa enjekte edilir
        // (localhost'ta alıcı erişemez). UI bu sayıların neden boş olduğunu açıklar.
        tracking_enabled: !!API_BASE,
    };
}
