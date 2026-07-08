/**
 * Cold Call — ülke tarife/erişilebilirlik verisi (İNDİKATİF, Twilio bazlı).
 *
 * Müşteriye $ COGS ASLA gösterilmez; müşteri yalnız kategori + dakika çarpanını
 * görür (routes shape'ler). $/dk alanları admin marj görünürlüğü içindir.
 *
 * multiplier: 1 dakika konuşma kotadan kaç dakika düşer.
 *   1x  → outUsdPerMin <= 0.06
 *   2x  → <= 0.16
 *   4x  → <= 0.45
 *   blocked → > 0.45 (premium/IRSF riski) veya yaptırım/sağlayıcı engeli
 */

export type BlockedReason = 'sanctioned' | 'provider_unsupported' | 'premium_rate_risk';

export interface CountryVoiceInfo {
    code: string;                       // ISO-3166 alpha-2
    nameTr: string;
    nameEn: string;
    dialCode: string;                   // '+1'
    outUsdPerMin: number;               // indikatif COGS (PSTN bacağı)
    callable: boolean;
    blockedReason?: BlockedReason;
    /** Satın alınabilir yerel numara envanteri (yoksa numara satılamaz) */
    numbers?: { monthlyUsd: number; requiresDocs: boolean };
}

export function multiplierFor(outUsdPerMin: number): number {
    if (outUsdPerMin <= 0.06) return 1;
    if (outUsdPerMin <= 0.16) return 2;
    if (outUsdPerMin <= 0.45) return 4;
    return 0; // blocked — çağrıya izin verilmez
}

export type CostTier = 'standard' | 'expensive' | 'very_expensive' | 'blocked';

export function tierFor(c: CountryVoiceInfo): CostTier {
    if (!c.callable) return 'blocked';
    const m = multiplierFor(c.outUsdPerMin);
    if (m === 1) return 'standard';
    if (m === 2) return 'expensive';
    if (m === 4) return 'very_expensive';
    return 'blocked';
}

export const COUNTRY_PRICING: CountryVoiceInfo[] = [
    // ── Kuzey Amerika ──
    { code: 'US', nameTr: 'ABD', nameEn: 'United States', dialCode: '+1', outUsdPerMin: 0.014, callable: true, numbers: { monthlyUsd: 1.15, requiresDocs: false } },
    { code: 'CA', nameTr: 'Kanada', nameEn: 'Canada', dialCode: '+1', outUsdPerMin: 0.014, callable: true, numbers: { monthlyUsd: 1.15, requiresDocs: false } },
    { code: 'MX', nameTr: 'Meksika', nameEn: 'Mexico', dialCode: '+52', outUsdPerMin: 0.011, callable: true, numbers: { monthlyUsd: 3.0, requiresDocs: true } },

    // ── Batı Avrupa ──
    { code: 'GB', nameTr: 'Birleşik Krallık', nameEn: 'United Kingdom', dialCode: '+44', outUsdPerMin: 0.03, callable: true, numbers: { monthlyUsd: 1.15, requiresDocs: true } },
    { code: 'DE', nameTr: 'Almanya', nameEn: 'Germany', dialCode: '+49', outUsdPerMin: 0.04, callable: true, numbers: { monthlyUsd: 1.15, requiresDocs: true } },
    { code: 'FR', nameTr: 'Fransa', nameEn: 'France', dialCode: '+33', outUsdPerMin: 0.06, callable: true, numbers: { monthlyUsd: 1.15, requiresDocs: true } },
    { code: 'NL', nameTr: 'Hollanda', nameEn: 'Netherlands', dialCode: '+31', outUsdPerMin: 0.05, callable: true, numbers: { monthlyUsd: 3.0, requiresDocs: true } },
    { code: 'BE', nameTr: 'Belçika', nameEn: 'Belgium', dialCode: '+32', outUsdPerMin: 0.06, callable: true, numbers: { monthlyUsd: 1.5, requiresDocs: true } },
    { code: 'ES', nameTr: 'İspanya', nameEn: 'Spain', dialCode: '+34', outUsdPerMin: 0.05, callable: true, numbers: { monthlyUsd: 1.15, requiresDocs: true } },
    { code: 'IT', nameTr: 'İtalya', nameEn: 'Italy', dialCode: '+39', outUsdPerMin: 0.08, callable: true, numbers: { monthlyUsd: 1.15, requiresDocs: true } },
    { code: 'PT', nameTr: 'Portekiz', nameEn: 'Portugal', dialCode: '+351', outUsdPerMin: 0.06, callable: true, numbers: { monthlyUsd: 1.5, requiresDocs: true } },
    { code: 'IE', nameTr: 'İrlanda', nameEn: 'Ireland', dialCode: '+353', outUsdPerMin: 0.04, callable: true, numbers: { monthlyUsd: 1.5, requiresDocs: true } },
    { code: 'AT', nameTr: 'Avusturya', nameEn: 'Austria', dialCode: '+43', outUsdPerMin: 0.07, callable: true, numbers: { monthlyUsd: 1.5, requiresDocs: true } },
    { code: 'CH', nameTr: 'İsviçre', nameEn: 'Switzerland', dialCode: '+41', outUsdPerMin: 0.09, callable: true, numbers: { monthlyUsd: 1.5, requiresDocs: true } },

    // ── Kuzey Avrupa ──
    { code: 'SE', nameTr: 'İsveç', nameEn: 'Sweden', dialCode: '+46', outUsdPerMin: 0.04, callable: true, numbers: { monthlyUsd: 1.5, requiresDocs: true } },
    { code: 'NO', nameTr: 'Norveç', nameEn: 'Norway', dialCode: '+47', outUsdPerMin: 0.05, callable: true, numbers: { monthlyUsd: 1.5, requiresDocs: true } },
    { code: 'DK', nameTr: 'Danimarka', nameEn: 'Denmark', dialCode: '+45', outUsdPerMin: 0.04, callable: true, numbers: { monthlyUsd: 1.5, requiresDocs: true } },
    { code: 'FI', nameTr: 'Finlandiya', nameEn: 'Finland', dialCode: '+358', outUsdPerMin: 0.08, callable: true, numbers: { monthlyUsd: 1.5, requiresDocs: true } },

    // ── Doğu Avrupa ──
    { code: 'PL', nameTr: 'Polonya', nameEn: 'Poland', dialCode: '+48', outUsdPerMin: 0.03, callable: true, numbers: { monthlyUsd: 3.0, requiresDocs: true } },
    { code: 'CZ', nameTr: 'Çekya', nameEn: 'Czechia', dialCode: '+420', outUsdPerMin: 0.05, callable: true, numbers: { monthlyUsd: 3.0, requiresDocs: true } },
    { code: 'SK', nameTr: 'Slovakya', nameEn: 'Slovakia', dialCode: '+421', outUsdPerMin: 0.08, callable: true },
    { code: 'RO', nameTr: 'Romanya', nameEn: 'Romania', dialCode: '+40', outUsdPerMin: 0.06, callable: true, numbers: { monthlyUsd: 3.0, requiresDocs: true } },
    { code: 'HU', nameTr: 'Macaristan', nameEn: 'Hungary', dialCode: '+36', outUsdPerMin: 0.06, callable: true },
    { code: 'BG', nameTr: 'Bulgaristan', nameEn: 'Bulgaria', dialCode: '+359', outUsdPerMin: 0.09, callable: true },
    { code: 'GR', nameTr: 'Yunanistan', nameEn: 'Greece', dialCode: '+30', outUsdPerMin: 0.07, callable: true },
    { code: 'UA', nameTr: 'Ukrayna', nameEn: 'Ukraine', dialCode: '+380', outUsdPerMin: 0.13, callable: true },
    { code: 'RS', nameTr: 'Sırbistan', nameEn: 'Serbia', dialCode: '+381', outUsdPerMin: 0.14, callable: true },
    { code: 'RU', nameTr: 'Rusya', nameEn: 'Russia', dialCode: '+7', outUsdPerMin: 0.1, callable: false, blockedReason: 'provider_unsupported' },
    { code: 'BY', nameTr: 'Belarus', nameEn: 'Belarus', dialCode: '+375', outUsdPerMin: 0.3, callable: false, blockedReason: 'provider_unsupported' },

    // ── Türkiye & çevresi ──
    { code: 'TR', nameTr: 'Türkiye', nameEn: 'Türkiye', dialCode: '+90', outUsdPerMin: 0.14, callable: true },
    { code: 'AZ', nameTr: 'Azerbaycan', nameEn: 'Azerbaijan', dialCode: '+994', outUsdPerMin: 0.25, callable: true },
    { code: 'GE', nameTr: 'Gürcistan', nameEn: 'Georgia', dialCode: '+995', outUsdPerMin: 0.16, callable: true },
    { code: 'KZ', nameTr: 'Kazakistan', nameEn: 'Kazakhstan', dialCode: '+7', outUsdPerMin: 0.12, callable: true },
    { code: 'UZ', nameTr: 'Özbekistan', nameEn: 'Uzbekistan', dialCode: '+998', outUsdPerMin: 0.13, callable: true },

    // ── Orta Doğu ──
    { code: 'AE', nameTr: 'BAE', nameEn: 'United Arab Emirates', dialCode: '+971', outUsdPerMin: 0.16, callable: true },
    { code: 'SA', nameTr: 'Suudi Arabistan', nameEn: 'Saudi Arabia', dialCode: '+966', outUsdPerMin: 0.14, callable: true },
    { code: 'QA', nameTr: 'Katar', nameEn: 'Qatar', dialCode: '+974', outUsdPerMin: 0.17, callable: true },
    { code: 'KW', nameTr: 'Kuveyt', nameEn: 'Kuwait', dialCode: '+965', outUsdPerMin: 0.12, callable: true },
    { code: 'BH', nameTr: 'Bahreyn', nameEn: 'Bahrain', dialCode: '+973', outUsdPerMin: 0.11, callable: true },
    { code: 'OM', nameTr: 'Umman', nameEn: 'Oman', dialCode: '+968', outUsdPerMin: 0.16, callable: true },
    { code: 'JO', nameTr: 'Ürdün', nameEn: 'Jordan', dialCode: '+962', outUsdPerMin: 0.18, callable: true },
    { code: 'IL', nameTr: 'İsrail', nameEn: 'Israel', dialCode: '+972', outUsdPerMin: 0.05, callable: true },
    { code: 'IQ', nameTr: 'Irak', nameEn: 'Iraq', dialCode: '+964', outUsdPerMin: 0.19, callable: true },
    { code: 'IR', nameTr: 'İran', nameEn: 'Iran', dialCode: '+98', outUsdPerMin: 0.2, callable: false, blockedReason: 'sanctioned' },
    { code: 'SY', nameTr: 'Suriye', nameEn: 'Syria', dialCode: '+963', outUsdPerMin: 0.35, callable: false, blockedReason: 'sanctioned' },
    { code: 'LB', nameTr: 'Lübnan', nameEn: 'Lebanon', dialCode: '+961', outUsdPerMin: 0.15, callable: true },

    // ── Afrika ──
    { code: 'EG', nameTr: 'Mısır', nameEn: 'Egypt', dialCode: '+20', outUsdPerMin: 0.12, callable: true },
    { code: 'MA', nameTr: 'Fas', nameEn: 'Morocco', dialCode: '+212', outUsdPerMin: 0.25, callable: true },
    { code: 'DZ', nameTr: 'Cezayir', nameEn: 'Algeria', dialCode: '+213', outUsdPerMin: 0.28, callable: true },
    { code: 'TN', nameTr: 'Tunus', nameEn: 'Tunisia', dialCode: '+216', outUsdPerMin: 0.32, callable: true },
    { code: 'NG', nameTr: 'Nijerya', nameEn: 'Nigeria', dialCode: '+234', outUsdPerMin: 0.18, callable: true },
    { code: 'KE', nameTr: 'Kenya', nameEn: 'Kenya', dialCode: '+254', outUsdPerMin: 0.16, callable: true },
    { code: 'ZA', nameTr: 'Güney Afrika', nameEn: 'South Africa', dialCode: '+27', outUsdPerMin: 0.06, callable: true },
    { code: 'ET', nameTr: 'Etiyopya', nameEn: 'Ethiopia', dialCode: '+251', outUsdPerMin: 0.3, callable: true },
    { code: 'SD', nameTr: 'Sudan', nameEn: 'Sudan', dialCode: '+249', outUsdPerMin: 0.25, callable: false, blockedReason: 'sanctioned' },
    { code: 'SO', nameTr: 'Somali', nameEn: 'Somalia', dialCode: '+252', outUsdPerMin: 0.55, callable: false, blockedReason: 'premium_rate_risk' },
    { code: 'SL', nameTr: 'Sierra Leone', nameEn: 'Sierra Leone', dialCode: '+232', outUsdPerMin: 0.6, callable: false, blockedReason: 'premium_rate_risk' },
    { code: 'KM', nameTr: 'Komorlar', nameEn: 'Comoros', dialCode: '+269', outUsdPerMin: 0.7, callable: false, blockedReason: 'premium_rate_risk' },
    { code: 'CU', nameTr: 'Küba', nameEn: 'Cuba', dialCode: '+53', outUsdPerMin: 0.9, callable: false, blockedReason: 'sanctioned' },
    { code: 'KP', nameTr: 'Kuzey Kore', nameEn: 'North Korea', dialCode: '+850', outUsdPerMin: 1.0, callable: false, blockedReason: 'sanctioned' },

    // ── Asya-Pasifik ──
    { code: 'IN', nameTr: 'Hindistan', nameEn: 'India', dialCode: '+91', outUsdPerMin: 0.015, callable: true },
    { code: 'PK', nameTr: 'Pakistan', nameEn: 'Pakistan', dialCode: '+92', outUsdPerMin: 0.1, callable: true },
    { code: 'BD', nameTr: 'Bangladeş', nameEn: 'Bangladesh', dialCode: '+880', outUsdPerMin: 0.06, callable: true },
    { code: 'CN', nameTr: 'Çin', nameEn: 'China', dialCode: '+86', outUsdPerMin: 0.02, callable: true },
    { code: 'HK', nameTr: 'Hong Kong', nameEn: 'Hong Kong', dialCode: '+852', outUsdPerMin: 0.02, callable: true, numbers: { monthlyUsd: 6.0, requiresDocs: true } },
    { code: 'TW', nameTr: 'Tayvan', nameEn: 'Taiwan', dialCode: '+886', outUsdPerMin: 0.05, callable: true },
    { code: 'JP', nameTr: 'Japonya', nameEn: 'Japan', dialCode: '+81', outUsdPerMin: 0.06, callable: true, numbers: { monthlyUsd: 4.5, requiresDocs: true } },
    { code: 'KR', nameTr: 'Güney Kore', nameEn: 'South Korea', dialCode: '+82', outUsdPerMin: 0.03, callable: true },
    { code: 'SG', nameTr: 'Singapur', nameEn: 'Singapore', dialCode: '+65', outUsdPerMin: 0.015, callable: true, numbers: { monthlyUsd: 6.0, requiresDocs: true } },
    { code: 'MY', nameTr: 'Malezya', nameEn: 'Malaysia', dialCode: '+60', outUsdPerMin: 0.025, callable: true },
    { code: 'TH', nameTr: 'Tayland', nameEn: 'Thailand', dialCode: '+66', outUsdPerMin: 0.04, callable: true },
    { code: 'VN', nameTr: 'Vietnam', nameEn: 'Vietnam', dialCode: '+84', outUsdPerMin: 0.08, callable: true },
    { code: 'PH', nameTr: 'Filipinler', nameEn: 'Philippines', dialCode: '+63', outUsdPerMin: 0.13, callable: true },
    { code: 'ID', nameTr: 'Endonezya', nameEn: 'Indonesia', dialCode: '+62', outUsdPerMin: 0.06, callable: true },
    { code: 'AU', nameTr: 'Avustralya', nameEn: 'Australia', dialCode: '+61', outUsdPerMin: 0.03, callable: true, numbers: { monthlyUsd: 3.0, requiresDocs: true } },
    { code: 'NZ', nameTr: 'Yeni Zelanda', nameEn: 'New Zealand', dialCode: '+64', outUsdPerMin: 0.05, callable: true },

    // ── Güney Amerika ──
    { code: 'BR', nameTr: 'Brezilya', nameEn: 'Brazil', dialCode: '+55', outUsdPerMin: 0.025, callable: true, numbers: { monthlyUsd: 4.0, requiresDocs: true } },
    { code: 'AR', nameTr: 'Arjantin', nameEn: 'Argentina', dialCode: '+54', outUsdPerMin: 0.04, callable: true },
    { code: 'CL', nameTr: 'Şili', nameEn: 'Chile', dialCode: '+56', outUsdPerMin: 0.05, callable: true },
    { code: 'CO', nameTr: 'Kolombiya', nameEn: 'Colombia', dialCode: '+57', outUsdPerMin: 0.04, callable: true },
    { code: 'PE', nameTr: 'Peru', nameEn: 'Peru', dialCode: '+51', outUsdPerMin: 0.05, callable: true },
    { code: 'UY', nameTr: 'Uruguay', nameEn: 'Uruguay', dialCode: '+598', outUsdPerMin: 0.09, callable: true },
];

const byCode = new Map(COUNTRY_PRICING.map((c) => [c.code, c]));

export function countryByCode(code: string): CountryVoiceInfo | undefined {
    return byCode.get(code.toUpperCase());
}

/**
 * E.164 numaradan ülke tespiti — en uzun dial code eşleşmesi.
 * (+1 US/CA çakışması: numara satın alınan ülke değil ARANAN yön önemli;
 * +1 için US tarifesi kullanılır, ikisi de aynı fiyat bandındadır.)
 */
const sortedByDialLen = [...COUNTRY_PRICING].sort((a, b) => b.dialCode.length - a.dialCode.length);

export function countryForE164(e164: string): CountryVoiceInfo | undefined {
    // KZ/RU ikisi de +7: RU bloklu olduğundan +7'yi KZ'ye düşürmemek için
    // önce tam liste sırasında uzun kod eşleşmesi yapılır; +7 çakışmasında RU
    // (bloklu) tercih edilir — fail-closed: emin olmadığımız +7 yönü aranamaz.
    if (/^\+7\d/.test(e164)) return byCode.get('RU');
    return sortedByDialLen.find((c) => e164.startsWith(c.dialCode));
}
