/**
 * Kutu sağlık istatistikleri — deliverability (task-9).
 *
 * Bir gönderen kutunun (email_connection.email_address) son 7 ve 30 günlük teslim
 * sinyallerini toplar: gönderim, kalıcı (hard) bounce oranı, yanıt oranı, abonelikten
 * çıkma oranı. Bu sinyaller kutu itibarının erken uyarı göstergeleridir; yüksek bounce
 * veya abonelikten-çıkma spam klasörüne düşmenin habercisidir.
 *
 * Veri kaynakları (hepsi mevcut tablolar — bu modül yalnız OKUR, yazmaz):
 *   • gönderim + bounce → activities (type='campaign_email', sending_account=kutu).
 *       Bir mail çıktığında outcome='sent'; sonradan DSN/senkron kalıcı ret gelince
 *       aynı satır 'bounced'e çevrilir (campaignEngine). Yani "gönderilen" = sent+bounced,
 *       bounce oranı = bounced / (sent+bounced).
 *   • yanıt → email_replies (direction='IN', account_email=kutu). account_email, yanıtın
 *       düştüğü BİZİM kutumuzdur → kutu-başı yanıt doğal olarak buradan gelir. Benzersiz
 *       yanıtlayan (sender_email) sayılır ki tek kişinin çok yanıtı oranı şişirmesin.
 *   • abonelikten çıkma → email_suppressions (reason='unsubscribe'). Bastırma satırında
 *       kutu bilgisi YOK; bu yüzden konuşmayı BAŞLATAN kutuya (enrollment.thread_account_email)
 *       (email, campaign_id) üzerinden eşlenir — yanıt atfıyla (account_email = thread sahibi
 *       kutu) tutarlı tek atıf. thread_account_email boş olan enrollment'ta (ör. threadsiz
 *       eski kayıt) atıf yapılamaz → o çıkış sayılmaz (kabul edilebilir bozulma; çıkışlar
 *       nadirdir ve bu panel tavsiye niteliğindedir).
 *
 * "Veri yok" ile "sıfır" ayrımı (task-9): pencerede hiç gönderim yoksa (dispatched=0)
 * oran hesaplanamaz → null döner (UI em-dash gösterir). Gönderim varken olayın olmaması
 * gerçek %0'dır. task-5 (bastırma/bounce) bu daldan önce YOKtu; ≤30 günlük pencerede
 * gönderim varsa bounce/çıkış takibi zaten aktifti, dolayısıyla dispatched>0 iken oranlar
 * gerçektir.
 */
import { supabaseAdmin } from './supabase.js';
import { createLogger } from './logger.js';

const log = createLogger('mailboxHealth');

// Gmail alıcı alan adları (kişisel). Google Workspace kurumsal alanları MX bakışı
// gerektirdiği için (pahalı) burada kapsanmaz — Postmaster Tools önerisi için bu
// ucuz, kesin sinyal yeterlidir.
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

const DAY_MS = 86_400_000;

export interface MailboxWindowStats {
    /** Gönderilen kampanya maili (bounce dahil = dispatched). */
    sent: number;
    /** Kalıcı (hard) bounce sayısı. */
    bounces: number;
    /** bounces / sent; sent=0 iken null (veri yok → em-dash). */
    bounceRate: number | null;
    /** Yanıt veren benzersiz alıcı sayısı. */
    replies: number;
    /** replies / sent; sent=0 iken null. */
    replyRate: number | null;
    /** Abonelikten çıkan benzersiz alıcı sayısı (bu kutuya atfedilen). */
    unsubscribes: number;
    /** unsubscribes / sent; sent=0 iken null. */
    unsubRate: number | null;
}

export interface MailboxHealthStats {
    d7: MailboxWindowStats;
    d30: MailboxWindowStats;
    /** Bu kutu Gmail (gmail.com/googlemail.com) alıcılarına gönderiyor mu? */
    sendsToGmail: boolean;
    /** 30 günde hiç gönderim var mı? false ise UI sağlık satırını gizler. */
    hasHistory: boolean;
}

function rate(num: number, denom: number): number | null {
    return denom > 0 ? num / denom : null;
}

function emptyWindow(): MailboxWindowStats {
    return { sent: 0, bounces: 0, bounceRate: null, replies: 0, replyRate: null, unsubscribes: 0, unsubRate: null };
}

function gmailFromEmail(email: string | null | undefined): boolean {
    const domain = (email || '').split('@')[1]?.toLowerCase().trim();
    return !!domain && GMAIL_DOMAINS.has(domain);
}

/**
 * Bir gönderen kutu (accountEmail) için 7g/30g sağlık istatistiklerini hesaplar.
 * Sınırlı sayıda (N+1 yok) sorgu: activities, email_replies, email_suppressions ve
 * yalnız çıkış varsa enrollment atıf sorgusu. Tümü tenant + kutu ile daraltılıdır.
 */
export async function getMailboxHealthStats(
    tenantId: string,
    accountEmail: string,
    nowMs: number = Date.now(),
): Promise<MailboxHealthStats> {
    const box = (accountEmail || '').trim();
    const d7 = emptyWindow();
    const d30 = emptyWindow();
    const result: MailboxHealthStats = { d7, d30, sendsToGmail: false, hasHistory: false };
    if (!tenantId || !box) return result;

    const d7Iso = new Date(nowMs - 7 * DAY_MS).toISOString();
    const d30Iso = new Date(nowMs - 30 * DAY_MS).toISOString();
    const d7Ms = nowMs - 7 * DAY_MS;

    // ── 1) Gönderim + bounce + Gmail tespiti (activities) ─────────────────────
    // enrollment.email embed'i yalnız Gmail alıcı tespiti için; her satır PK join'i
    // (ucuz). outcome IN (sent,bounced) → dispatched. occurred_at ile pencere ayrımı.
    // Embed başarısız olursa (beklenmeyen), çekirdek gönderim/bounce sayımı KAYBOLMASIN
    // diye embed'siz yeniden çekeriz — yalnız Gmail önerisi düşer, sağlık satırı kalır.
    const baseSelect = 'outcome, occurred_at';
    let acts: Array<{
        outcome: string | null;
        occurred_at: string | null;
        campaign_enrollments?: { email?: string | null } | { email?: string | null }[] | null;
    }> = [];
    const embedRes = await supabaseAdmin
        .from('activities')
        .select(`${baseSelect}, campaign_enrollments!enrollment_id(email)`)
        .eq('tenant_id', tenantId)
        .eq('type', 'campaign_email')
        .eq('sending_account', box)
        .in('outcome', ['sent', 'bounced'])
        .gte('occurred_at', d30Iso);
    if (embedRes.error) {
        log.warn({ err: embedRes.error, tenantId, box }, 'Mailbox health activities embed query failed; retrying without embed');
        const plainRes = await supabaseAdmin
            .from('activities')
            .select(baseSelect)
            .eq('tenant_id', tenantId)
            .eq('type', 'campaign_email')
            .eq('sending_account', box)
            .in('outcome', ['sent', 'bounced'])
            .gte('occurred_at', d30Iso);
        if (plainRes.error) {
            // Fail-soft: sağlık paneli tavsiye niteliğinde; sorgu patlarsa boş döneriz.
            log.warn({ err: plainRes.error, tenantId, box }, 'Mailbox health activities query failed');
        }
        acts = (plainRes.data || []) as typeof acts;
    } else {
        acts = (embedRes.data || []) as typeof acts;
    }

    for (const a of acts) {
        const ts = a.occurred_at ? Date.parse(a.occurred_at) : NaN;
        if (!Number.isFinite(ts)) continue;
        const isBounced = a.outcome === 'bounced';
        d30.sent++;
        if (isBounced) d30.bounces++;
        if (ts >= d7Ms) {
            d7.sent++;
            if (isBounced) d7.bounces++;
        }
        // Gmail tespiti (30g penceresi): alıcı adresi gmail.com/googlemail.com mı?
        if (!result.sendsToGmail) {
            const enr = a.campaign_enrollments;
            const email = Array.isArray(enr) ? enr[0]?.email : enr?.email;
            if (gmailFromEmail(email)) result.sendsToGmail = true;
        }
    }

    // ── 2) Yanıt (email_replies) — benzersiz yanıtlayan ───────────────────────
    const { data: replies, error: repErr } = await supabaseAdmin
        .from('email_replies')
        .select('sender_email, replied_at')
        .eq('tenant_id', tenantId)
        .eq('direction', 'IN')
        .eq('account_email', box)
        .gte('replied_at', d30Iso);

    if (repErr) {
        log.warn({ err: repErr, tenantId, box }, 'Mailbox health replies query failed');
    }

    const repliers7 = new Set<string>();
    const repliers30 = new Set<string>();
    for (const r of (replies || []) as Array<{ sender_email: string | null; replied_at: string | null }>) {
        const ts = r.replied_at ? Date.parse(r.replied_at) : NaN;
        if (!Number.isFinite(ts)) continue;
        const who = (r.sender_email || '').toLowerCase().trim();
        if (!who) continue;
        repliers30.add(who);
        if (ts >= d7Ms) repliers7.add(who);
    }
    d30.replies = repliers30.size;
    d7.replies = repliers7.size;

    // ── 3) Abonelikten çıkma (email_suppressions → enrollment thread sahibi) ──
    const { data: sup, error: supErr } = await supabaseAdmin
        .from('email_suppressions')
        .select('email, source_campaign_id, created_at')
        .eq('tenant_id', tenantId)
        .eq('reason', 'unsubscribe')
        .gte('created_at', d30Iso);

    if (supErr) {
        log.warn({ err: supErr, tenantId, box }, 'Mailbox health suppressions query failed');
    }

    const supRows = (sup || []) as Array<{ email: string | null; source_campaign_id: string | null; created_at: string | null }>;
    if (supRows.length > 0) {
        const unsubEmails = Array.from(
            new Set(supRows.map((s) => (s.email || '').toLowerCase().trim()).filter(Boolean)),
        );
        // Bu kutunun sahibi olduğu (konuşmayı başlattığı) enrollment'lar. thread_account_email
        // = ilk maili atan kutu; yanıt atfıyla (account_email) tutarlı tek atıf.
        const { data: enrollments, error: enrErr } = await supabaseAdmin
            .from('campaign_enrollments')
            .select('email, campaign_id')
            .eq('tenant_id', tenantId)
            .eq('thread_account_email', box)
            .in('email', unsubEmails);

        if (enrErr) {
            log.warn({ err: enrErr, tenantId, box }, 'Mailbox health enrollment attribution query failed');
        }

        // Atıf kümeleri: (email|campaign_id) birincil eşleşme; source_campaign_id boşsa
        // yalnız email ile eşle (bu kutu o alıcıya konuşma başlatmışsa).
        const ownedPairs = new Set<string>();
        const ownedEmails = new Set<string>();
        for (const e of (enrollments || []) as Array<{ email: string | null; campaign_id: string | null }>) {
            const em = (e.email || '').toLowerCase().trim();
            if (!em) continue;
            ownedEmails.add(em);
            if (e.campaign_id) ownedPairs.add(`${em}|${e.campaign_id}`);
        }

        const unsub7 = new Set<string>();
        const unsub30 = new Set<string>();
        for (const s of supRows) {
            const em = (s.email || '').toLowerCase().trim();
            if (!em) continue;
            const attributed = s.source_campaign_id
                ? ownedPairs.has(`${em}|${s.source_campaign_id}`)
                : ownedEmails.has(em);
            if (!attributed) continue;
            const ts = s.created_at ? Date.parse(s.created_at) : NaN;
            if (!Number.isFinite(ts)) continue;
            unsub30.add(em);
            if (ts >= d7Ms) unsub7.add(em);
        }
        d30.unsubscribes = unsub30.size;
        d7.unsubscribes = unsub7.size;
    }

    // ── Oranlar (dispatched paydası) ──────────────────────────────────────────
    d7.bounceRate = rate(d7.bounces, d7.sent);
    d7.replyRate = rate(d7.replies, d7.sent);
    d7.unsubRate = rate(d7.unsubscribes, d7.sent);
    d30.bounceRate = rate(d30.bounces, d30.sent);
    d30.replyRate = rate(d30.replies, d30.sent);
    d30.unsubRate = rate(d30.unsubscribes, d30.sent);

    result.hasHistory = d30.sent > 0;
    return result;
}
