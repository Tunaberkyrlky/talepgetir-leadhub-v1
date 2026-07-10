/**
 * E-posta liste doğrulama (task-4, deliverability) — gönderim öncesi sözdizimi +
 * MX + tek-kullanımlık (disposable) + rol-adresi kontrolü. Amaç: sabit-hata
 * (hard bounce) oranını sağlayıcıların ~%2 eşiğinin altında tutmak; geçersiz
 * kutuları listeden ELEMEK, sağlıklı kutu itibarını korumak.
 *
 * MX araması domainHealth.ts'teki cache'li resolver'ı (checkMxDeliverability)
 * YENİDEN KULLANIR — kopya yok. DNS hatası/timeout = 'unknown' → ENGELLEME YOK
 * (fail-open): yalnız KESİN geçersiz/uygunsuz kutular elenir, şüpheli olanlar
 * geçer (gönderim-anı ikinci kontrol emniyet supabı).
 *
 * Sınıflandırma:
 *   - 'invalid' → bozuk sözdizimi | MX yok/NXDOMAIN | disposable alan → kaydetme.
 *   - 'unknown' → DNS belirsiz → fail-open (geçer).
 *   - 'valid'   → teslim edilebilir.
 * Rol adresleri (info@, sales@, ...) yalnız İŞARETLENİR, bloklamaz.
 */

import { checkMxDeliverability, domainFromEmail, type MxDeliverability } from './domainHealth.js';

// ── Tipler ───────────────────────────────────────────────────────────────────

export type EmailValidity = 'valid' | 'invalid' | 'unknown';
export type InvalidReason = 'syntax' | 'no_mx' | 'disposable';

export interface EmailValidation {
    email: string;
    validity: EmailValidity;
    reason: InvalidReason | null; // yalnız validity === 'invalid' iken dolu
    role: boolean;                // rol adresi (info@, sales@, ...) — bloklamaz
    disposable: boolean;          // tek-kullanımlık alan
}

// ── Sözdizimi (pragmatik RFC 5322 alt kümesi) ────────────────────────────────
// Tam RFC değil (yorum, quoted-string, IP-literal gibi nadir/istismar edilen
// formlar dışarıda) ama gerçek B2B adreslerini kapsar: tek @, geçerli local-part,
// noktalı alan ve en az iki harfli TLD.
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

export function isValidSyntax(email: string): boolean {
    const e = (email || '').trim();
    if (!e || e.length > 254) return false;   // RFC 5321: toplam uzunluk 254
    const at = e.lastIndexOf('@');
    if (at <= 0) return false;
    if (e.slice(0, at).length > 64) return false; // RFC 5321: local-part 64
    if (e.includes('..')) return false;            // ardışık nokta (label/local) geçersiz
    return EMAIL_RE.test(e);
}

// ── Disposable (tek-kullanımlık) alanlar ─────────────────────────────────────
// Yaygın ~50 atılabilir-mail sağlayıcısı. Bunlar genelde geçerli MX taşır (MX
// kontrolü yakalamaz) ama kutular kısa ömürlüdür → bounce/spam-trap riski. B2B
// soğuk mailde değersiz olduklarından KAYDETMEYİZ.
const DISPOSABLE_DOMAINS = new Set<string>([
    'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org',
    '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org',
    'throwawaymail.com', 'yopmail.com', 'yopmail.net', 'yopmail.fr',
    'getnada.com', 'nada.email', 'dispostable.com', 'trashmail.com', 'trashmail.net',
    'sharklasers.com', 'grr.la', 'guerrillamailblock.com', 'maildrop.cc',
    'mailnesia.com', 'mailcatch.com', 'fakeinbox.com', 'tempinbox.com',
    'spamgourmet.com', 'mytemp.email', 'emailondeck.com', 'mohmal.com',
    'mintemail.com', 'tempmailo.com', 'moakt.com', 'burnermail.io',
    '33mail.com', 'spam4.me', 'tempr.email', 'discard.email',
    'fakemailgenerator.com', 'wegwerfmail.de', 'einrot.com', 'mailexpire.com',
    'spambog.com', 'mvrht.net', 'harakirimail.com', 'tempail.com', 'cs.email',
    'gmailnator.com', 'emltmp.com', 'vomoto.com', 'trbvm.com', 'mailto.plus',
]);

export function isDisposableDomain(domain: string): boolean {
    return DISPOSABLE_DOMAINS.has(domain.toLowerCase().trim());
}

// ── Rol adresleri ────────────────────────────────────────────────────────────
// Kişisel olmayan, paylaşımlı kutular. Soğuk mailde dönüşümü düşük ve şikâyet
// riski yüksektir ama teslim edilebilirler → yalnız İŞARETLENİR, engellenmez.
const ROLE_LOCAL_PARTS = new Set<string>([
    'info', 'admin', 'administrator', 'sales', 'support', 'contact', 'noreply',
    'no-reply', 'donotreply', 'do-not-reply', 'help', 'office', 'hello', 'team',
    'marketing', 'billing', 'accounts', 'accounting', 'hr', 'jobs', 'careers',
    'webmaster', 'postmaster', 'abuse', 'security', 'privacy', 'legal',
    'compliance', 'sysadmin', 'root', 'mail', 'mailer', 'newsletter',
    'notifications', 'notification', 'service', 'services', 'enquiries', 'enquiry',
    'inquiries', 'feedback', 'press', 'media', 'partners', 'partnership',
]);

export function isRoleAddress(email: string): boolean {
    const at = email.lastIndexOf('@');
    if (at <= 0) return false;
    return ROLE_LOCAL_PARTS.has(email.slice(0, at).toLowerCase().trim());
}

// ── Tekil doğrulama ──────────────────────────────────────────────────────────

/**
 * Tek bir e-postayı doğrular (sözdizimi → disposable → MX). Gönderim-anı tekrar
 * kontrolü için de kullanılır (MX cache'li → ucuz).
 */
export async function validateEmail(email: string): Promise<EmailValidation> {
    const raw = (email || '').trim();
    const res: EmailValidation = { email: raw, validity: 'valid', reason: null, role: false, disposable: false };

    if (!isValidSyntax(raw)) {
        res.validity = 'invalid';
        res.reason = 'syntax';
        return res;
    }
    res.role = isRoleAddress(raw); // yalnız işaret
    const domain = domainFromEmail(raw);
    if (isDisposableDomain(domain)) {
        res.disposable = true;
        res.validity = 'invalid';
        res.reason = 'disposable';
        return res;
    }
    const mx = await checkMxDeliverability(domain);
    if (mx === 'no_mx') {
        res.validity = 'invalid';
        res.reason = 'no_mx';
    } else if (mx === 'unknown') {
        res.validity = 'unknown'; // fail-open
    }
    // has_mx → valid
    return res;
}

// ── Toplu doğrulama ──────────────────────────────────────────────────────────

export interface BatchValidateOptions {
    concurrency?: number; // eşzamanlı MX araması (varsayılan 24)
    maxDomains?: number;  // MX aranacak azami benzersiz alan (varsayılan 500)
    budgetMs?: number;    // MX fazı için duvar-saati bütçesi (varsayılan 12000)
}

/**
 * Bir e-posta listesini toplu doğrular; sonucu normalize edilmiş (küçük harf)
 * e-posta anahtarlı Map olarak döner. Verimlilik + güvenlik sınırları:
 *   - Alan-bazında TEKİLLEŞTİRME — aynı domain bir kez MX-aranır (liste çoğunlukla
 *     az sayıda şirket alanına dağılır).
 *   - EŞZAMANLILIK sınırı — DNS'i sel basmaz.
 *   - TAVAN + BÜTÇE — çok geniş/yavaş listelerde takılmaz; sınır aşılan alanların
 *     MX'i 'unknown' sayılır → FAIL-OPEN (o e-postalar geçer, gönderim-anı kontrol
 *     ikinci savunma). Sözdizimi/disposable/role senkron olduğundan her zaman uygulanır.
 */
export async function validateEmails(
    emails: string[],
    opts: BatchValidateOptions = {},
): Promise<Map<string, EmailValidation>> {
    const concurrency = opts.concurrency ?? 24;
    const maxDomains = opts.maxDomains ?? 500;
    const budgetMs = opts.budgetMs ?? 12_000;

    const out = new Map<string, EmailValidation>();
    const domainToKeys = new Map<string, string[]>(); // alan → o alanı kullanan e-posta anahtarları

    // 1) Senkron eleme (sözdizimi/disposable/role) + MX gereken alanları topla.
    for (const rawEmail of emails) {
        const raw = (rawEmail || '').trim();
        const key = raw.toLowerCase();
        if (out.has(key)) continue; // aynı e-posta tekrar
        const res: EmailValidation = { email: raw, validity: 'valid', reason: null, role: false, disposable: false };

        if (!isValidSyntax(raw)) {
            res.validity = 'invalid';
            res.reason = 'syntax';
            out.set(key, res);
            continue;
        }
        res.role = isRoleAddress(raw);
        const domain = domainFromEmail(raw);
        if (isDisposableDomain(domain)) {
            res.disposable = true;
            res.validity = 'invalid';
            res.reason = 'disposable';
            out.set(key, res);
            continue;
        }
        // MX beklemede — şimdilik 'valid'; alan sonucuna göre 3. adımda güncellenir.
        out.set(key, res);
        const arr = domainToKeys.get(domain);
        if (arr) arr.push(key);
        else domainToKeys.set(domain, [key]);
    }

    // 2) Benzersiz alanların MX'i (cache + eşzamanlılık + bütçe).
    const domains = [...domainToKeys.keys()];
    const domainResult = new Map<string, MxDeliverability>();
    const toLookup = domains.slice(0, maxDomains);
    for (const d of domains.slice(maxDomains)) domainResult.set(d, 'unknown'); // tavan üstü → fail-open

    const deadline = Date.now() + budgetMs;
    let idx = 0;
    const worker = async (): Promise<void> => {
        while (idx < toLookup.length) {
            const d = toLookup[idx++];
            if (Date.now() >= deadline) { domainResult.set(d, 'unknown'); continue; } // bütçe doldu → fail-open
            try {
                domainResult.set(d, await checkMxDeliverability(d));
            } catch {
                domainResult.set(d, 'unknown');
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, toLookup.length) }, worker));

    // 3) Alan MX sonuçlarını e-postalara uygula.
    for (const [domain, keys] of domainToKeys) {
        const mx = domainResult.get(domain) ?? 'unknown';
        for (const key of keys) {
            const res = out.get(key);
            if (!res) continue;
            if (mx === 'no_mx') { res.validity = 'invalid'; res.reason = 'no_mx'; }
            else if (mx === 'unknown') { res.validity = 'unknown'; } // fail-open
            // has_mx → valid (değişmez)
        }
    }

    return out;
}
