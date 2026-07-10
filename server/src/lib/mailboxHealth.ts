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
 * oran hesaplanamaz → null döner (UI em-dash gösterir). Ayrıca bounce/çıkış takibi task-5
 * ile DOĞDU (BOUNCE_TRACKING_SINCE_MS); pencere o tarihten öncesine uzanıyor ve sayı 0 ise
 * bu "gerçek %0" değil "veri yok"tur → yine null. Böylece takip yayına girmeden önceki
 * gönderimlerde sahte-sağlıklı %0 gösterilmez. Sayı >0 ise gerçek (olası düşük tahminli)
 * oran gösterilir; pozitif bounce/çıkış sinyali gizlenmez. ~30 gün sonra pencere artık
 * takip tarihinden sonra başlar ve bu özel durum kendiliğinden kalkar.
 */
import { supabaseAdmin } from './supabase.js';
import { createLogger } from './logger.js';

const log = createLogger('mailboxHealth');

const DAY_MS = 86_400_000;

// Bounce takibi (outcome='bounced' çevrimi) ve email_suppressions bu dalda task-5 ile
// geldi (commit 3d56247, 2026-07-10 20:40 UTC). Bu andan ÖNCEKİ gönderimlerin bounce/çıkışı
// hiç kaydedilemezdi; o dönemi kapsayan pencerede sayı 0 ise "veri yok"tur, "gerçek %0"
// değil (task-9 em-dash kuralı). Sabit tarih, takip yayına girmeden önceki hiçbir gönderim
// için sahte-sağlıklı %0 gösterilmemesini garanti eder ve ~30 gün sonra etkisiz kalır.
const BOUNCE_TRACKING_SINCE_MS = Date.parse('2026-07-10T20:40:34Z');

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

/** Yanıt oranını [0,1]'e kısar: yanıt kaynağı (email_replies) gönderimden fazla olabilir
 *  (otomatik yanıt / manuel konuşma iş parçacığı), oran >%100 görünmesin. */
function clampRate(r: number | null): number | null {
    return r == null ? null : Math.min(1, r);
}

/**
 * bounce/çıkış oranı, "veri yok" ayrımıyla. denom=0 → null (hiç gönderim). Ayrıca sayı 0
 * ve pencere task-5 (bounce/çıkış takibi) öncesine uzanıyorsa → null: o dönemin olayları
 * kaydedilemezdi, 0 sahte-sağlıklı %0 olmasın (em-dash). Sayı >0 ise gerçek oranı göster.
 */
function trackedRate(num: number, denom: number, windowStartMs: number): number | null {
    if (denom <= 0) return null;
    if (num === 0 && windowStartMs < BOUNCE_TRACKING_SINCE_MS) return null;
    return num / denom;
}

function emptyWindow(): MailboxWindowStats {
    return { sent: 0, bounces: 0, bounceRate: null, replies: 0, replyRate: null, unsubscribes: 0, unsubRate: null };
}

/**
 * Bir kutunun activities sayımı — head-count (satır ÇEKMEZ). PostgREST yanıtı 1000 satırda
 * kesildiği için satır çekmek yüksek hacimli (ramp 50/gün → 30g'de 1500) kutularda sayıyı
 * sessizce keserdi; count/head bu sınırdan etkilenmez. bouncedOnly=false → dispatched
 * (sent+bounced), true → yalnız bounced.
 */
async function countActivities(
    tenantId: string,
    box: string,
    sinceIso: string,
    bouncedOnly: boolean,
): Promise<number> {
    let q = supabaseAdmin
        .from('activities')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('type', 'campaign_email')
        .eq('sending_account', box)
        .gte('occurred_at', sinceIso);
    q = bouncedOnly ? q.eq('outcome', 'bounced') : q.in('outcome', ['sent', 'bounced']);
    const { count, error } = await q;
    if (error) {
        log.warn({ err: error, tenantId, box, sinceIso, bouncedOnly }, 'Mailbox health activity count failed');
        return 0;
    }
    return count ?? 0;
}

/**
 * Bu kutu Gmail (gmail.com/googlemail.com) alıcılarına konuşma başlatmış mı? Postmaster
 * Tools önerisi için ucuz, sınırlı varlık sorgusu (limit 1). thread_account_email = ilk
 * maili atan kutu → yanıt/çıkış atfıyla tutarlı. Pencere-bağımsız: gönderen itibarı alan
 * adı düzeyinde kalıcıdır, kutu Gmail'e geçmişte yazmışsa öneri anlamını korur.
 */
async function detectGmailRecipient(tenantId: string, box: string): Promise<boolean> {
    const { data, error } = await supabaseAdmin
        .from('campaign_enrollments')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('thread_account_email', box)
        .or('email.ilike.%@gmail.com,email.ilike.%@googlemail.com')
        .limit(1);
    if (error) {
        log.warn({ err: error, tenantId, box }, 'Mailbox health gmail-recipient probe failed');
        return false;
    }
    return (data?.length ?? 0) > 0;
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
    const d30Ms = nowMs - 30 * DAY_MS;

    // ── 1) Gönderim + bounce + Gmail tespiti ──────────────────────────────────
    // Satır ÇEKMEK yerine head-count: PostgREST yanıtı 1000 satırda kesilir (kod tabanı
    // başka yerde bunun için sayfalar) ve ramp tavanı 50/gün → 30 günde 1500 satır bu
    // sınırı aşar; ORDER BY'sız kesilen alt küme rastgele olurdu. 4 sayı (dispatched/
    // bounced × 7g/30g) + Gmail varlık sorgusu paralel koşar (N+1 yok).
    const [d30Sent, d30Bounces, d7Sent, d7Bounces, sendsToGmail] = await Promise.all([
        countActivities(tenantId, box, d30Iso, false),
        countActivities(tenantId, box, d30Iso, true),
        countActivities(tenantId, box, d7Iso, false),
        countActivities(tenantId, box, d7Iso, true),
        detectGmailRecipient(tenantId, box),
    ]);
    d30.sent = d30Sent;
    d30.bounces = d30Bounces;
    d7.sent = d7Sent;
    d7.bounces = d7Bounces;
    result.sendsToGmail = sendsToGmail;

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
    // bounce/çıkış: takip-öncesi pencerede sayı 0 ise em-dash (trackedRate). yanıt:
    // email_replies task-5'ten eski → watermark yok, ama gönderimden fazla olabileceği
    // için [0,1]'e kısılır (clampRate).
    d7.bounceRate = trackedRate(d7.bounces, d7.sent, d7Ms);
    d7.replyRate = clampRate(rate(d7.replies, d7.sent));
    d7.unsubRate = trackedRate(d7.unsubscribes, d7.sent, d7Ms);
    d30.bounceRate = trackedRate(d30.bounces, d30.sent, d30Ms);
    d30.replyRate = clampRate(rate(d30.replies, d30.sent));
    d30.unsubRate = trackedRate(d30.unsubscribes, d30.sent, d30Ms);

    result.hasHistory = d30.sent > 0;
    return result;
}
