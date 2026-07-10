/**
 * Bounce (DSN) tespiti — deliverability (task-5).
 *
 * Müşteri kendi kutusundan gönderdiğinde bir alıcı geçersizse posta sunucusu bir
 * "Delivery Status Notification" (RFC 3464) geri döndürür; bu mail IMAP kutusuna
 * mailer-daemon/postmaster'dan düşer. Burada onu tanır, BAŞARISIZ alıcıyı çıkarır
 * ve KALICI (hard, 5.x.x) mı GEÇİCİ (soft, 4.x.x) mı olduğunu sınıflarız.
 *
 * Yalnız KALICI bounce bastırma listesine yazılır — geçici (kutu dolu, sunucu
 * meşgul) durumlar bir daha denenebilir, o adresi ölü sayamayız.
 *
 * Yanlış-pozitif koruması: sadece "mailer-daemon/postmaster'dan geldi" YETMEZ;
 * gerçek bir DSN sinyali (multipart/report; report-type=delivery-status VEYA
 * Final-Recipient/Status/Diagnostic-Code alanları) de aranır. Böylece bir bounce'u
 * ALINTILAYAN normal bir yanıt yanlışlıkla bounce sanılmaz.
 */
import type { ParsedMail } from 'mailparser';
import { extractEmailAddress } from './types.js';

export interface BounceResult {
    isBounce: boolean;
    /** true → kalıcı (5.x.x); false → geçici/soft veya belirsiz. */
    hard: boolean;
    /** Başarısız (bounce eden) alıcı adresi, küçük harf; bulunamazsa null. */
    recipient: string | null;
}

const NO_BOUNCE: BounceResult = { isBounce: false, hard: false, recipient: null };

// mailer-daemon@ / postmaster@ / MAILER-DAEMON gibi gönderen yerel-parçaları.
const DAEMON_LOCALPARTS = /^(mailer-daemon|postmaster|mail-daemon|maildaemon)\b/i;

function senderLooksLikeDaemon(parsed: ParsedMail): boolean {
    const from = (parsed.from?.value?.[0]?.address || extractEmailAddress(parsed.from?.text) || '').toLowerCase();
    if (!from) {
        // Boş/null return-path (<>) da DSN işaretidir; from tamamen boşsa daemon varsay.
        return true;
    }
    const local = from.split('@')[0] || '';
    return DAEMON_LOCALPARTS.test(local);
}

/**
 * Ham MIME kaynağından başarısız alıcıyı çıkarır. Öncelik:
 *   1) X-Failed-Recipients header (Gmail/Google Workspace bunu verir)
 *   2) Final-Recipient: rfc822; <email>  (RFC 3464 delivery-status parçası)
 *   3) Original-Recipient: rfc822; <email>
 */
function extractFailedRecipient(raw: string): string | null {
    const xFailed = raw.match(/^X-Failed-Recipients:\s*(.+)$/im);
    if (xFailed) {
        const first = (xFailed[1].split(',')[0] || '').trim();
        const addr = extractEmailAddress(first);
        if (addr) return addr.toLowerCase();
    }
    const finalRcpt = raw.match(/^Final-Recipient:\s*[^;]*;\s*(.+)$/im);
    if (finalRcpt) {
        const addr = extractEmailAddress(finalRcpt[1].trim());
        if (addr) return addr.toLowerCase();
    }
    const origRcpt = raw.match(/^Original-Recipient:\s*[^;]*;\s*(.+)$/im);
    if (origRcpt) {
        const addr = extractEmailAddress(origRcpt[1].trim());
        if (addr) return addr.toLowerCase();
    }
    return null;
}

/**
 * KALICI mı? RFC 3463 gelişmiş durum kodu 5.x.x veya klasik SMTP 5xx (550/551/
 * 553/554) → kalıcı. 4.x.x / 421 / 450 vb. → geçici. "Action: failed" kalıcıya,
 * "Action: delayed" geçiciye işaret eder. Belirsizse (kod yok) geçici sayarız —
 * yanlışlıkla iyi bir adresi bastırmaktansa bir kez daha denemek yeğdir.
 */
function isPermanent(raw: string): boolean {
    // "Action: delayed" açıkça geçici → asla kalıcı sayma.
    if (/^Action:\s*delayed/im.test(raw)) return false;

    // Gelişmiş durum kodu (Status: 5.x.x).
    const status = raw.match(/^Status:\s*([245])\.\d+\.\d+/im);
    if (status) return status[1] === '5';

    // Klasik kalıcı SMTP kodları (satır başında ya da diagnostic-code içinde).
    if (/\b(550|551|553|554)\b/.test(raw)) return true;
    // Klasik geçici kodlar → geçici.
    if (/\b(421|450|451|452)\b/.test(raw)) return false;

    // Metinsel kalıcı imzalar (kod dönmeyen sunucular için, dar tutuldu).
    if (/(user unknown|no such user|does not exist|address rejected|recipient rejected|mailbox unavailable|account.* disabled|no mailbox)/i.test(raw)) {
        return true;
    }
    return false;
}

/**
 * Bir gelen mail bounce mı? Ham kaynağı (source) ve ayrıştırılmış hâlini alır.
 * source, DSN'in delivery-status parçalarını içerdiği için asıl kaynaktır; parsed
 * gönderen/başlık sinyalleri için kullanılır.
 */
export function detectBounce(parsed: ParsedMail, source: Buffer): BounceResult {
    const raw = source.toString('utf8');

    // Güçlü DSN sinyali — ÜST-DÜZEY başlığa demirlenir (task-5 review). Ham kaynakta
    // aramak, bir bounce'u EK olarak taşıyan iletiyi (mesela bir prospect'in "mailin geri
    // döndü" diye ilettiği mail: üst tip multipart/mixed, içteki parça multipart/report)
    // yanlışlıkla bounce sanır ve gerçek insan yanıtını sessizce düşürürdü. mailparser'ın
    // ayrıştırdığı üst Content-Type'ı okuyup yalnız iletinin KENDİSİ bir delivery-status
    // raporuysa güçlü sinyal sayarız.
    const topCT = parsed.headers?.get('content-type') as { value?: string; params?: Record<string, string> } | undefined;
    const isReportDSN =
        /multipart\/report/i.test(topCT?.value || '') &&
        /delivery-status/i.test(topCT?.params?.['report-type'] || '');
    const hasDeliveryStatusPart = /Content-Type:\s*message\/delivery-status/i.test(raw);
    const hasFinalRecipient = /^Final-Recipient:/im.test(raw);
    const hasXFailed = /^X-Failed-Recipients:/im.test(raw);

    const daemon = senderLooksLikeDaemon(parsed);

    // Bounce sayılması için: RFC-uyumlu üst-düzey rapor DSN'i (en güçlü sinyal), VEYA
    // daemon/boş-return-path'ten gelip bir DSN alanı (delivery-status parçası /
    // Final-Recipient / X-Failed) taşıyan mail. delivery-status parçası TEK BAŞINA
    // yeterli sayılmaz — gerçek bir kişinin ALINTILADIĞI bir bounce yanlışlıkla bounce
    // sanılmasın diye daemon göndericiyle desteklenmesi istenir.
    const looksLikeBounce =
        isReportDSN ||
        (daemon && (hasDeliveryStatusPart || hasFinalRecipient || hasXFailed));

    if (!looksLikeBounce) return NO_BOUNCE;

    const recipient = extractFailedRecipient(raw);
    return {
        isBounce: true,
        hard: isPermanent(raw),
        recipient,
    };
}
