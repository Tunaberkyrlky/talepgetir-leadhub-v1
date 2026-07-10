/**
 * Gönderim-öncesi içerik "spam sinyali" denetimi — TAVSİYE amaçlı, engellemez.
 *
 * Saf (yan etkisiz, DB/ağ dokunmayan) fonksiyon: konu + HTML gövdeyi analiz eder,
 * teslim edilebilirliği (inbox placement) düşürebilecek kalıpları bulur. Çıktı
 * yalnızca KOD döndürür; kullanıcıya görünen metin client tarafında (i18n) üretilir.
 *
 * Kapsam (soğuk B2B, düşük hacim):
 *  - Çok fazla link (>3)
 *  - URL kısaltıcılar (bit.ly, tinyurl, t.co ...)
 *  - Konuda aşırı BÜYÜK HARF oranı
 *  - Konuda ünlem yoğunluğu
 *  - Spam-tetikleyici kelimeler (EN + TR kompakt liste)
 *  - Görsel-ağırlıklı / az metin
 *  - Soğuk maile ek dosya iliştirme
 *
 * Not: abonelikten-çıkma linki footer'da otomatik eklendiği için "eksik unsubscribe"
 * denetimi YOKTUR (N/A). Takip pixel'i de gönderim anında eklenir; buradaki gövde
 * müşterinin kendi HTML'idir.
 */

import { htmlToPlainText } from './htmlText.js';

export type LintSeverity = 'warn' | 'info';

export interface LintFinding {
    /** Stabil kod — client i18n ile eşleştirir (prose SERVER'da üretilmez). */
    code: string;
    severity: LintSeverity;
    /** Kelimeye/sayıya göre değişen interpolasyon değerleri (opsiyonel). */
    params?: Record<string, unknown>;
}

export interface LintInput {
    subject?: string | null;
    bodyHtml?: string | null;
    /** Soğuk maile ek dosya uyarısı — UI şu an adımda ek desteklemiyor (varsayılan false). */
    hasAttachment?: boolean;
}

// ── Eşikler ─────────────────────────────────────────────────────────────────
const MAX_LINKS = 3;              // > bu kadar link → uyarı
const CAPS_MIN_LETTERS = 8;       // konu bundan kısa ise büyük-harf oranına bakma
const CAPS_RATIO = 0.6;           // konudaki büyük harf oranı bunu aşarsa → uyarı
const IMG_HEAVY_TEXT_MAX = 100;   // görsel var + düz metin bundan kısa → görsel-ağırlıklı
const MAX_LISTED_WORDS = 10;      // params.words listesinde en fazla kaç kelime döndürülür

// URL kısaltıcı alan adları (soğuk mailde güven düşürür / spam filtresi tetikler).
const SHORTENER_DOMAINS = new Set<string>([
    'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
    'cutt.ly', 'rb.gy', 'rebrand.ly', 'shorturl.at', 'bl.ink', 'lnkd.in',
    'tiny.cc', 'soo.gd', 's.id', 'v.gd', 'trib.al', 'db.tt', 'clck.ru',
]);

// Spam-tetikleyici kelime/ifade listesi (EN + TR, kompakt). Kelime sınırıyla eşleşir
// (Unicode harf/rakam). Çok kelimeli ifadeler ("act now") de desteklenir.
const SPAM_TERMS: string[] = [
    // EN — para / bedava
    'free', 'for free', 'free trial', 'no cost', 'risk free', 'risk-free',
    'money back', '100% free', 'get paid', 'cash bonus', 'best price',
    'lowest price', 'cheap', 'discount', 'save big', 'earn money', 'extra income',
    'double your', 'million dollars',
    // EN — aciliyet / baskı
    'act now', 'urgent', 'limited time', 'expires', 'don\'t miss', 'last chance',
    'apply now', 'buy now', 'order now', 'click here', 'click below', 'sign up free',
    'call now', 'while supplies last', 'once in a lifetime',
    // EN — abartı / kazanç
    'guaranteed', 'guarantee', 'winner', 'you have won', 'congratulations',
    'amazing', 'incredible', 'miracle', 'no obligation', 'no strings attached',
    'this isn\'t spam', 'not spam', 'increase sales', 'boost your',
    // TR — bedava / para
    'bedava', 'ücretsiz', 'ücretsiz deneme', 'para kazan', 'para kazanın',
    'kazanç', 'indirim', 'kampanya', 'en ucuz', 'en uygun fiyat', 'fırsat',
    'bedavaya', 'hediye', 'çekiliş',
    // TR — aciliyet / baskı
    'acele', 'son şans', 'kaçırmayın', 'hemen', 'hemen tıklayın', 'tıklayın',
    'şimdi başvur', 'sınırlı süre', 'süre doluyor', 'fırsatı kaçırma',
    // TR — abartı / kazanç
    'garanti', 'garantili', 'kazandınız', 'tebrikler', 'kazandiniz',
    'inanılmaz', 'mucize', 'risksiz', 'yüzde yüz', '%100', 'spam değil',
];

// Küçük-harfe indirger; Türkçe İ/I ayrımını da normalize etmeye çalışır.
function toLowerTr(s: string): string {
    return s.replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase();
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Kelime sınırı Unicode harf/rakam ile; Türkçe harflerde de doğru çalışır.
function buildTermRegex(term: string): RegExp {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'iu');
}
const SPAM_REGEXES: Array<{ term: string; re: RegExp }> = SPAM_TERMS.map((term) => ({
    term,
    re: buildTermRegex(toLowerTr(term)),
}));

// http(s) URL — hem href="..." hem düz metindeki çıplak URL'leri yakalar.
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;

function extractDomain(url: string): string | null {
    const m = url.match(/^https?:\/\/([^/?#:]+)/i);
    if (!m) return null;
    return m[1].toLowerCase().replace(/^www\./, '');
}

/**
 * Konu + HTML gövdeyi denetler; bulunan sinyalleri kod listesi olarak döndürür.
 * Saf fonksiyon — girdi dışında hiçbir şeye dokunmaz.
 */
export function lintEmailContent(input: LintInput): LintFinding[] {
    const subject = (input.subject || '').toString();
    const html = (input.bodyHtml || '').toString();
    const findings: LintFinding[] = [];

    const plainBody = htmlToPlainText(html);
    const haystack = toLowerTr(`${subject} ${plainBody}`);

    // ── 1) Link sayısı + kısaltıcılar ────────────────────────────────────────
    // Çıpalı (<a href>) linkler + gövdede çıpasız çıplak URL'ler ayrı sayılır ki
    // href="url">url</a> kalıbı iki kez sayılmasın.
    const anchorHrefs: string[] = [];
    const anchorRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let am: RegExpExecArray | null;
    while ((am = anchorRe.exec(html)) !== null) {
        if (/^https?:\/\//i.test(am[1].trim())) anchorHrefs.push(am[1].trim());
    }
    // <a>...</a> ve <img> bloklarını çıkardıktan sonra kalan çıplak URL'ler.
    const withoutAnchors = html
        .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, ' ')
        .replace(/<img\b[^>]*>/gi, ' ');
    const bareUrls = withoutAnchors.match(URL_RE) || [];

    const allUrls = [...anchorHrefs, ...bareUrls];
    const linkCount = allUrls.length;
    if (linkCount > MAX_LINKS) {
        findings.push({ code: 'too_many_links', severity: 'warn', params: { count: linkCount, max: MAX_LINKS } });
    }

    const shortenerDomains = Array.from(
        new Set(
            allUrls
                .map(extractDomain)
                .filter((d): d is string => !!d && SHORTENER_DOMAINS.has(d)),
        ),
    );
    if (shortenerDomains.length > 0) {
        findings.push({ code: 'url_shortener', severity: 'warn', params: { domains: shortenerDomains } });
    }

    // ── 2) Konu — BÜYÜK HARF oranı ───────────────────────────────────────────
    const letters = subject.match(/\p{L}/gu) || [];
    if (letters.length >= CAPS_MIN_LETTERS) {
        const upper = letters.filter((ch) => ch !== ch.toLowerCase() && ch === ch.toUpperCase()).length;
        const ratio = upper / letters.length;
        if (ratio > CAPS_RATIO) {
            findings.push({ code: 'subject_all_caps', severity: 'warn', params: { ratioPct: Math.round(ratio * 100) } });
        }
    }

    // ── 3) Konu — ünlem yoğunluğu ────────────────────────────────────────────
    const exclamations = (subject.match(/!/g) || []).length;
    if (exclamations >= 2) {
        findings.push({ code: 'subject_exclamation', severity: 'warn', params: { count: exclamations } });
    } else if (exclamations === 1) {
        findings.push({ code: 'subject_exclamation', severity: 'info', params: { count: exclamations } });
    }

    // ── 4) Spam-tetikleyici kelimeler ────────────────────────────────────────
    const matched: string[] = [];
    const seen = new Set<string>();
    for (const { term, re } of SPAM_REGEXES) {
        if (re.test(haystack) && !seen.has(term)) {
            seen.add(term);
            matched.push(term);
        }
    }
    if (matched.length > 0) {
        findings.push({
            code: 'spam_words',
            severity: 'warn',
            params: { words: matched.slice(0, MAX_LISTED_WORDS), count: matched.length },
        });
    }

    // ── 5) Görsel-ağırlıklı / az metin ───────────────────────────────────────
    const imgCount = (html.match(/<img\b[^>]*>/gi) || []).length;
    const textLen = plainBody.length;
    if (imgCount >= 1 && textLen < IMG_HEAVY_TEXT_MAX) {
        findings.push({ code: 'image_heavy', severity: 'warn', params: { images: imgCount, textLength: textLen } });
    }

    // ── 6) Ek dosya (soğuk mail) ─────────────────────────────────────────────
    if (input.hasAttachment) {
        findings.push({ code: 'attachment', severity: 'info' });
    }

    return findings;
}
