/**
 * Cold Call — ülke tarife/erişilebilirlik verisi (origin-aware, Twilio v2 — canlı
 * Pricing API doğrulaması 2026-07-14). Kaynak: plans/coldcall_pricing_v2.json +
 * plans/COLD_CALL_PRICING_TABLE.md (değerler burada HARD-CODE edilir, JSON runtime'da
 * okunmaz).
 *
 * v1 (tek-oranlı outUsdPerMin) YANLIŞTI: gerçek Twilio giden dakika fiyatı
 * **(arayan numaranın menşe bölgesi) × (hedef ülke + hat tipi)** matrisidir —
 * EEA/UK menşeli bir numarayla AB mobili aramak, US menşeline göre ~9× ucuzdur
 * (intra-Avrupa interconnect tarifesi). Bu yüzden fiyat artık dört hücreli:
 * intlMobileUsd / intlFixedUsd / euMobileUsd / euFixedUsd.
 *
 * Müşteriye $ COGS ASLA gösterilmez; müşteri yalnız kategori + dakika çarpanını
 * görür (routes shape'ler). $/dk alanları admin marj görünürlüğü içindir.
 */

export type BlockedReason = 'sanctioned' | 'provider_unsupported' | 'premium_rate_risk';
export type OriginRegion = 'EU' | 'INTL';
export type LineType = 'mobile' | 'fixed';
/** Numara satın alma belge/adres gereksinimi: none→docless, any→low_friction, local→docs
 *  (plans/coldcall_pricing_v2.json.addr eşlemesi; addr'de kayıt yoksa temkinli 'docs' varsayılır). */
export type DocStatus = 'docless' | 'low_friction' | 'docs';

export interface NumberTypeOffer {
    monthlyUsd: number;
    docStatus: DocStatus;
}

export interface CountryVoiceInfo {
    code: string;                       // ISO-3166 alpha-2
    nameTr: string;
    nameEn: string;
    dialCode: string;                   // '+1'
    /** COGS $/dk — (menşe bölgesi) × (hat tipi) dört hücreli matris (Twilio pricing v2, canlı). */
    intlMobileUsd: number;
    intlFixedUsd: number;
    euMobileUsd: number;
    euFixedUsd: number;
    /** E.164 (ülke kodu dahil, '+' hariç) mobil önek kümesi — en-uzun-eşleşme ile hat tipi tespiti. */
    mobilePrefixes: string[];
    callable: boolean;
    blockedReason?: BlockedReason;
    /** Satın alınabilir numara tipleri (local/mobile/national/"toll free"…) → kira + belge durumu.
     *  Boş obje = bu ülkede (henüz) numara envanteri yok. */
    numbers: Record<string, NumberTypeOffer>;
}

/** 1 kredi-dakika = bu maliyet (plan §4, kilitli karar). */
export const BASE_COST_USD = 0.03;
/** Çarpan tavanı — 6× üstü maliyetli hedefler bilinçli sübvansiyonla 6×'te kesilir (plan §5). */
export const MAX_MULT = 6;

/** multiplierForRate = clamp(ceil(round(usdPerMin,4) / BASE_COST_USD), 1, 6). */
export function multiplierForRate(usdPerMin: number): number {
    const rounded = Math.round(usdPerMin * 10000) / 10000;
    const raw = Math.ceil(rounded / BASE_COST_USD);
    return Math.min(MAX_MULT, Math.max(1, raw));
}

export type CostTier = 'standard' | 'expensive' | 'very_expensive' | 'blocked';

/** Müşteri görünürlüğü için kaba kategori (badge rengi): 1×=standard, 2-3×=expensive, 4-6×=very_expensive. */
export function tierForMultiplier(multiplier: number): CostTier {
    if (multiplier <= 0) return 'blocked';
    if (multiplier === 1) return 'standard';
    if (multiplier <= 3) return 'expensive';
    return 'very_expensive';
}

/**
 * Menşe bölgesi — EEA + UK = 'EU' (intra-Avrupa tarifesi alır), geri kalan her şey 'INTL'.
 * Not: bu sınıflandırma DESTİNASYON tablosundan (COUNTRY_PRICING) bağımsızdır — ör. FI/CZ/SK
 * şu an satın alınabilir numara envanterinde yok ama menşe olarak yine de EU sayılır, envanter
 * genişledikçe otomatik doğru çalışsın diye (plan §0, "hedef ülkeler kod aşamasında tamamlanır").
 */
const EEA_UK_ORIGINS: ReadonlySet<string> = new Set([
    'GB', 'IE', 'DE', 'FR', 'NL', 'BE', 'ES', 'IT', 'PT', 'AT', 'SE', 'NO', 'DK', 'FI',
    'PL', 'CZ', 'SK', 'RO', 'HU', 'BG', 'GR', 'HR', 'SI', 'EE', 'LV', 'LT', 'LU', 'CY', 'MT', 'IS', 'LI',
]);

export function originRegionFor(countryCode: string): OriginRegion {
    return EEA_UK_ORIGINS.has(countryCode.toUpperCase()) ? 'EU' : 'INTL';
}

/** NANP'da (+1 US/CA) mobil/sabit ayrımı yok — rate zaten eşit, her zaman 'fixed' say. */
const NANP_NO_SPLIT: ReadonlySet<string> = new Set(['US', 'CA']);

/**
 * Hat tipi — aranan E.164'ün hedef ülkenin mobil önek kümesiyle (en-uzun-eşleşme) karşılaştırması.
 * mobilePrefixes boşsa eşleşme HİÇBİR ZAMAN mümkün değildir → marj-güvenli varsayım: 'mobile'
 * (yüksek oran) döner, 'fixed' asla varsayılan olarak seçilmez.
 */
export function lineTypeFor(toE164: string, destCountry: CountryVoiceInfo): LineType {
    if (NANP_NO_SPLIT.has(destCountry.code)) return 'fixed';
    if (!destCountry.mobilePrefixes.length) return 'mobile';
    const digits = toE164.replace(/^\+/, '');
    const matched = destCountry.mobilePrefixes.some((p) => digits.startsWith(p));
    return matched ? 'mobile' : 'fixed';
}

export interface RateResult {
    blocked: false;
    usdPerMin: number;
    lineType: LineType;
    multiplier: number;
    destCountry: CountryVoiceInfo;
}

export interface BlockedRate {
    blocked: true;
    destCountry?: CountryVoiceInfo;
    reason: BlockedReason | 'unknown_destination';
}

export function isBlockedRate(r: RateResult | BlockedRate): r is BlockedRate {
    return r.blocked === true;
}

/**
 * Origin-aware oran çözümü: (arayan numaranın ülkesi → menşe bölgesi) × (hedef + hat tipi).
 * Hedef tanımsız/engelliyse blocked marker döner — çağıran taraf bunu 4xx'e çevirir (fail-closed).
 */
export function rateFor(fromCountryCode: string, toE164: string): RateResult | BlockedRate {
    const dest = countryForE164(toE164);
    if (!dest) return { blocked: true, reason: 'unknown_destination' };
    if (!dest.callable) return { blocked: true, destCountry: dest, reason: dest.blockedReason ?? 'provider_unsupported' };
    const region = originRegionFor(fromCountryCode);
    const lineType = lineTypeFor(toE164, dest);
    const usdPerMin = region === 'EU'
        ? (lineType === 'mobile' ? dest.euMobileUsd : dest.euFixedUsd)
        : (lineType === 'mobile' ? dest.intlMobileUsd : dest.intlFixedUsd);
    return { blocked: false, usdPerMin, lineType, multiplier: multiplierForRate(usdPerMin), destCountry: dest };
}

/**
 * Numara tipleri arasından "önerilen" satın alma seçeneğini belirler — belgesiz (docless) öncelikli,
 * sonra mobile > local > national > "toll free" sırası, eşitlikte ucuz olan kazanır. Tek-tip satın
 * alma akışı (numbers.ts /search, POST /) bunu kullanır; admin panelinde tüm tipler ayrıca listelenir.
 */
const NUMBER_TYPE_PRIORITY = ['mobile', 'local', 'national', 'toll free'];

export function primaryNumberOffer(numbers: Record<string, NumberTypeOffer>): (NumberTypeOffer & { type: string }) | null {
    const entries = Object.entries(numbers);
    if (!entries.length) return null;
    const docless = entries.filter(([, v]) => v.docStatus === 'docless');
    const pool = [...(docless.length ? docless : entries)];
    pool.sort(([aType, aOffer], [bType, bOffer]) => {
        const aIdx = NUMBER_TYPE_PRIORITY.indexOf(aType);
        const bIdx = NUMBER_TYPE_PRIORITY.indexOf(bType);
        const aRank = aIdx === -1 ? NUMBER_TYPE_PRIORITY.length : aIdx;
        const bRank = bIdx === -1 ? NUMBER_TYPE_PRIORITY.length : bIdx;
        return aRank !== bRank ? aRank - bRank : aOffer.monthlyUsd - bOffer.monthlyUsd;
    });
    const [type, offer] = pool[0];
    return { type, ...offer };
}

export const COUNTRY_PRICING: CountryVoiceInfo[] = [
    // ── Kuzey Amerika (NANP — hat ayrımı yok) ──
    {
        code: 'US', nameTr: 'ABD', nameEn: 'United States', dialCode: '+1',
        intlMobileUsd: 0.014, intlFixedUsd: 0.014, euMobileUsd: 0.014, euFixedUsd: 0.014,
        mobilePrefixes: [], callable: true,
        numbers: { local: { monthlyUsd: 1.15, docStatus: 'docless' }, 'toll free': { monthlyUsd: 2.15, docStatus: 'docs' } },
    },
    {
        code: 'CA', nameTr: 'Kanada', nameEn: 'Canada', dialCode: '+1',
        intlMobileUsd: 0.014, intlFixedUsd: 0.014, euMobileUsd: 0.014, euFixedUsd: 0.014,
        mobilePrefixes: [], callable: true,
        numbers: { local: { monthlyUsd: 1.15, docStatus: 'docless' }, 'toll free': { monthlyUsd: 2.15, docStatus: 'docs' } },
    },

    // ── B.Krallık & İrlanda ──
    {
        code: 'GB', nameTr: 'Birleşik Krallık', nameEn: 'United Kingdom', dialCode: '+44',
        intlMobileUsd: 0.32, intlFixedUsd: 0.0158, euMobileUsd: 0.32, euFixedUsd: 0.0158,
        mobilePrefixes: ['447'], callable: true,
        numbers: {
            local: { monthlyUsd: 1.15, docStatus: 'docs' },
            mobile: { monthlyUsd: 2.5, docStatus: 'docless' },
            national: { monthlyUsd: 1.15, docStatus: 'docs' },
            'toll free': { monthlyUsd: 2.7, docStatus: 'docs' },
        },
    },
    {
        code: 'IE', nameTr: 'İrlanda', nameEn: 'Ireland', dialCode: '+353',
        intlMobileUsd: 0.0945, intlFixedUsd: 0.0483, euMobileUsd: 0.0945, euFixedUsd: 0.0483,
        mobilePrefixes: ['3538'], callable: true,
        numbers: { local: { monthlyUsd: 1.8, docStatus: 'docs' } },
    },

    // ── Batı Avrupa ──
    {
        code: 'DE', nameTr: 'Almanya', nameEn: 'Germany', dialCode: '+49',
        intlMobileUsd: 0.3763, intlFixedUsd: 0.0283, euMobileUsd: 0.042, euFixedUsd: 0.0283,
        mobilePrefixes: ['4915', '4916', '4917', '49700', '49701'], callable: true,
        numbers: { local: { monthlyUsd: 1.35, docStatus: 'docs' }, mobile: { monthlyUsd: 30.0, docStatus: 'docs' } },
    },
    {
        code: 'FR', nameTr: 'Fransa', nameEn: 'France', dialCode: '+33',
        intlMobileUsd: 0.1603, intlFixedUsd: 0.0187, euMobileUsd: 0.0404, euFixedUsd: 0.0187,
        mobilePrefixes: ['336', '337'], callable: true,
        numbers: { local: { monthlyUsd: 1.35, docStatus: 'docs' }, national: { monthlyUsd: 1.35, docStatus: 'docs' } },
    },
    {
        code: 'NL', nameTr: 'Hollanda', nameEn: 'Netherlands', dialCode: '+31',
        intlMobileUsd: 0.2763, intlFixedUsd: 0.3675, euMobileUsd: 0.0241, euFixedUsd: 0.0179,
        mobilePrefixes: ['316', '31970'], callable: true,
        numbers: { mobile: { monthlyUsd: 7.7, docStatus: 'low_friction' } },
    },
    {
        code: 'BE', nameTr: 'Belçika', nameEn: 'Belgium', dialCode: '+32',
        intlMobileUsd: 0.5576, intlFixedUsd: 0.1375, euMobileUsd: 0.0387, euFixedUsd: 0.0715,
        mobilePrefixes: ['32456', '3246', '3247', '3248', '3249', '3277'], callable: true,
        numbers: { mobile: { monthlyUsd: 1.25, docStatus: 'docs' }, 'toll free': { monthlyUsd: 25.0, docStatus: 'docs' } },
    },
    {
        code: 'ES', nameTr: 'İspanya', nameEn: 'Spain', dialCode: '+34',
        intlMobileUsd: 0.18, intlFixedUsd: 0.0178, euMobileUsd: 0.0486, euFixedUsd: 0.0178,
        mobilePrefixes: ['346', '3471', '3472', '3473', '3474'], callable: true,
        numbers: {},
    },
    {
        code: 'IT', nameTr: 'İtalya', nameEn: 'Italy', dialCode: '+39',
        intlMobileUsd: 0.0476, intlFixedUsd: 0.0168, euMobileUsd: 0.0445, euFixedUsd: 0.0168,
        mobilePrefixes: ['393'], callable: true,
        numbers: { mobile: { monthlyUsd: 45.0, docStatus: 'low_friction' }, 'toll free': { monthlyUsd: 27.0, docStatus: 'docs' } },
    },
    {
        code: 'PT', nameTr: 'Portekiz', nameEn: 'Portugal', dialCode: '+351',
        intlMobileUsd: 0.495, intlFixedUsd: 0.0171, euMobileUsd: 0.0495, euFixedUsd: 0.0171,
        mobilePrefixes: [
            '3511691', '3511693', '3511696', '3511891', '3511892', '3511893', '3511896',
            '3516091', '3516093', '3516096', '3516391', '3516392', '3516393', '3516396',
            '3516591', '3516592', '3516593', '3516596', '3516691', '3516693', '3516696',
            '35191', '35192', '35193', '35196',
        ],
        callable: true,
        numbers: {},
    },
    {
        code: 'AT', nameTr: 'Avusturya', nameEn: 'Austria', dialCode: '+43',
        intlMobileUsd: 0.0495, intlFixedUsd: 0.0176, euMobileUsd: 0.0495, euFixedUsd: 0.0176,
        mobilePrefixes: [
            '43644', '43650', '43651', '43652', '43653', '43655', '43657', '43659', '43660',
            '43661', '43663', '43664', '43665', '43666', '43667', '43668', '43669',
            '4367', '4368', '4369',
        ],
        callable: true,
        numbers: {
            local: { monthlyUsd: 1.0, docStatus: 'docs' },
            mobile: { monthlyUsd: 6.0, docStatus: 'docs' },
            national: { monthlyUsd: 1.0, docStatus: 'docs' },
            'toll free': { monthlyUsd: 25.0, docStatus: 'docs' },
        },
    },
    {
        code: 'CH', nameTr: 'İsviçre', nameEn: 'Switzerland', dialCode: '+41',
        intlMobileUsd: 0.1802, intlFixedUsd: 0.0419, euMobileUsd: 0.1802, euFixedUsd: 0.0419,
        mobilePrefixes: ['41754', '4176', '4177', '4178', '4179', '4186076', '4186077', '4186078', '4186079'],
        callable: true,
        numbers: { local: { monthlyUsd: 1.15, docStatus: 'docs' }, mobile: { monthlyUsd: 9.0, docStatus: 'docs' } },
    },

    // ── Kuzey Avrupa ──
    {
        code: 'SE', nameTr: 'İsveç', nameEn: 'Sweden', dialCode: '+46',
        intlMobileUsd: 0.0714, intlFixedUsd: 0.0187, euMobileUsd: 0.0714, euFixedUsd: 0.0187,
        mobilePrefixes: [
            '46252', '46254', '46376', '46518', '46519', '46592', '46593', '46673', '46674',
            '46675', '46676', '4670', '4671', '4672', '4673', '467524', '46755', '46756', '4676',
        ],
        callable: true,
        numbers: { mobile: { monthlyUsd: 3.0, docStatus: 'docless' } },
    },
    {
        code: 'NO', nameTr: 'Norveç', nameEn: 'Norway', dialCode: '+47',
        intlMobileUsd: 0.077, intlFixedUsd: 0.0296, euMobileUsd: 0.077, euFixedUsd: 0.0296,
        mobilePrefixes: ['474', '4758', '4759', '479'], callable: true,
        numbers: {},
    },
    {
        code: 'DK', nameTr: 'Danimarka', nameEn: 'Denmark', dialCode: '+45',
        intlMobileUsd: 0.0564, intlFixedUsd: 0.024, euMobileUsd: 0.0564, euFixedUsd: 0.024,
        mobilePrefixes: [
            '452', '4530', '4531', '453235', '4540', '4541', '4542', '4550', '4551', '4552',
            '45530', '45531', '45532', '455330', '455331', '455332', '455333', '455334', '455335',
            '455336', '455337', '455338', '455339', '45534', '45535', '45536', '45537', '45538',
            '45539', '4560', '4561', '45710', '45711', '45712', '45713', '45714', '45715', '45716',
            '457170', '457171', '457172', '457173', '457174', '457175', '457176', '457177', '457178',
            '457179', '45718', '457190', '457191', '457192', '457193', '457194', '457195', '457196',
            '457197', '457198', '457199', '45721', '4581', '4591', '4592', '4593',
        ],
        callable: true,
        numbers: { mobile: { monthlyUsd: 15.0, docStatus: 'docs' } },
    },

    // ── Doğu Avrupa ──
    {
        code: 'PL', nameTr: 'Polonya', nameEn: 'Poland', dialCode: '+48',
        intlMobileUsd: 0.2202, intlFixedUsd: 0.1114, euMobileUsd: 0.0715, euFixedUsd: 0.0315,
        mobilePrefixes: [
            '4850', '4851', '48530', '48531', '48532', '48533', '48534', '48535', '485360', '485361',
            '485362', '485363', '485364', '485365', '485366', '485367', '485368', '485369', '48537',
            '48538', '48539', '48570', '485711', '485712', '485713', '485714', '48574', '48575',
            '48578', '4860', '4864', '4866', '4869', '487200', '487201', '487202', '487203', '487204',
            '487205', '487206', '487207', '487208', '487209', '48721', '48722', '48723', '48724',
            '48725', '48726', '487270', '487271', '487272', '487273', '487274', '487275', '487276',
            '487277', '487278', '487279', '487280', '487281', '487282', '487283', '487284', '487285',
            '487286', '487287', '487288', '487289', '48729', '48730', '48731', '48732', '48733',
            '487341', '487342', '487343', '487344', '487390', '487391', '487392', '487394', '487395',
            '487396', '4878', '4879', '4888', '4890',
        ],
        callable: true,
        numbers: { 'toll free': { monthlyUsd: 20.0, docStatus: 'docs' } },
    },

    // ── Türkiye & Orta Doğu ──
    {
        code: 'TR', nameTr: 'Türkiye', nameEn: 'Türkiye', dialCode: '+90',
        intlMobileUsd: 0.2875, intlFixedUsd: 0.0701, euMobileUsd: 0.2875, euFixedUsd: 0.0701,
        mobilePrefixes: ['905'], callable: true,
        numbers: {},
    },
    {
        code: 'AE', nameTr: 'BAE', nameEn: 'United Arab Emirates', dialCode: '+971',
        intlMobileUsd: 0.2995, intlFixedUsd: 0.3635, euMobileUsd: 0.2995, euFixedUsd: 0.3635,
        mobilePrefixes: ['9715'], callable: true,
        numbers: {},
    },
    {
        code: 'SA', nameTr: 'Suudi Arabistan', nameEn: 'Saudi Arabia', dialCode: '+966',
        intlMobileUsd: 0.1738, intlFixedUsd: 0.1738, euMobileUsd: 0.1738, euFixedUsd: 0.1738,
        mobilePrefixes: ['96650', '96653', '96654', '96655', '96656', '96658', '96659'], callable: true,
        numbers: {},
    },
    {
        code: 'IL', nameTr: 'İsrail', nameEn: 'Israel', dialCode: '+972',
        intlMobileUsd: 0.1868, intlFixedUsd: 0.0659, euMobileUsd: 0.1868, euFixedUsd: 0.0659,
        mobilePrefixes: ['9721515', '9721535', '9725', '9726'], callable: true,
        numbers: {
            local: { monthlyUsd: 5.5, docStatus: 'docs' },
            mobile: { monthlyUsd: 15.0, docStatus: 'docs' },
            national: { monthlyUsd: 5.5, docStatus: 'docs' },
            'toll free': { monthlyUsd: 22.0, docStatus: 'docs' },
        },
    },

    // ── Asya-Pasifik ──
    {
        code: 'JP', nameTr: 'Japonya', nameEn: 'Japan', dialCode: '+81',
        intlMobileUsd: 0.185, intlFixedUsd: 0.0746, euMobileUsd: 0.185, euFixedUsd: 0.0746,
        mobilePrefixes: ['8160', '8170', '8180', '8190'], callable: true,
        numbers: {
            local: { monthlyUsd: 4.75, docStatus: 'docs' },
            national: { monthlyUsd: 4.75, docStatus: 'docs' },
            'toll free': { monthlyUsd: 25.0, docStatus: 'docs' },
        },
    },
    {
        code: 'AU', nameTr: 'Avustralya', nameEn: 'Australia', dialCode: '+61',
        intlMobileUsd: 0.075, intlFixedUsd: 0.0252, euMobileUsd: 0.075, euFixedUsd: 0.0252,
        mobilePrefixes: ['6116', '614'], callable: true,
        numbers: {
            local: { monthlyUsd: 3.0, docStatus: 'docs' },
            mobile: { monthlyUsd: 8.25, docStatus: 'low_friction' },
            'toll free': { monthlyUsd: 20.0, docStatus: 'docs' },
        },
    },

    // ── Güney Amerika ──
    {
        code: 'BR', nameTr: 'Brezilya', nameEn: 'Brazil', dialCode: '+55',
        intlMobileUsd: 0.0663, intlFixedUsd: 0.031, euMobileUsd: 0.0663, euFixedUsd: 0.031,
        mobilePrefixes: [
            '551153', '551154', '551157', '55116', '55117', '55118', '55119', '55126', '55127',
            '55128', '55129', '55136', '55137', '55138', '55139', '55146', '55147', '55148', '55149',
            '55156', '55157', '55158', '55159', '55166', '55167', '55168', '55169', '55176', '55177',
            '55178', '55179', '55186', '55187', '55188', '55189', '55196', '55197', '55198', '55199',
            '55216', '55217', '55218', '55219', '55226', '55227', '55228', '55229', '55246', '55247',
            '55248', '55249', '55276', '55277', '55278', '55279', '55286', '55287', '55288', '55289',
            '55316', '55317', '55318', '55319', '55326', '55327', '55328', '55329', '5533', '55346',
            '55347', '55348', '55349', '55356', '55357', '55358', '55359', '55376', '55377', '55378',
            '55379', '55386', '55387', '55388', '55389', '55416', '55417', '55418', '55419', '55426',
            '55427', '55428', '55429', '55436', '55437', '55438', '55439', '55446', '55447', '55448',
            '55449', '55456', '55457', '55458', '55459', '55466', '55467', '55468', '55469', '55476',
            '55477', '55478', '55479', '55486', '55487', '55488', '55489', '55496', '55497', '55498',
            '55499', '55516', '55517', '55518', '55519', '55526', '55527', '55528', '55529', '55536',
            '55537', '55538', '55539', '55546', '55547', '55548', '55549', '55556', '55557', '55558',
            '55559', '55616', '55617', '55618', '55619', '55626', '55627', '55628', '55629', '55636',
            '55637', '55638', '55639', '55646', '55647', '55648', '55649', '55656', '55657', '55658',
            '55659', '55666', '55667', '55668', '55669', '55676', '55677', '55678', '55679', '55686',
            '55687', '55688', '55689', '55696', '55697', '55698', '55699', '55716', '55717', '55718',
            '55719', '55736', '55737', '55738', '55739', '55746', '55747', '55748', '55749', '55756',
            '55757', '55758', '55759', '55776', '55777', '55778', '55779', '55786', '55787', '55788',
            '55789', '55796', '55797', '55798', '55799', '55816', '55817', '55818', '55819', '55826',
            '55827', '55828', '55829', '55836', '55837', '55838', '55839', '55846', '55847', '55848',
            '55849', '55856', '55857', '55858', '55859', '55866', '55867', '55868', '55869', '55876',
            '55877', '55878', '55879', '55886', '55887', '55888', '55889', '55896', '55897', '55898',
            '55899', '55916', '55917', '55918', '55919', '55926', '55927', '55928', '55929', '55936',
            '55937', '55938', '55939', '55946', '55947', '55948', '55949', '55956', '55957', '55958',
            '55959', '55966', '55967', '55968', '55969', '55976', '55977', '55978', '55979', '55986',
            '55987', '55988', '55989', '55996', '55997', '55998', '55999',
        ],
        callable: true,
        numbers: { local: { monthlyUsd: 4.25, docStatus: 'docs' } },
    },
    {
        code: 'MX', nameTr: 'Meksika', nameEn: 'Mexico', dialCode: '+52',
        intlMobileUsd: 0.016, intlFixedUsd: 0.016, euMobileUsd: 0.016, euFixedUsd: 0.016,
        mobilePrefixes: ['521'], callable: true,
        numbers: {
            local: { monthlyUsd: 6.25, docStatus: 'docs' },
            mobile: { monthlyUsd: 15.0, docStatus: 'docs' },
            'toll free': { monthlyUsd: 30.0, docStatus: 'docs' },
        },
    },

    // ── Ek pazarlar (canlı Twilio v2/v1; ikincil-EU intra-EEA indirimi ertelendi, konservatif) ──
    {
        code: 'FI', nameTr: 'Finlandiya', nameEn: 'Finland', dialCode: '+358',
        intlMobileUsd: 0.5172, intlFixedUsd: 0.495, euMobileUsd: 0.5172, euFixedUsd: 0.495,
        mobilePrefixes: ['358299', '3584', '35850'], callable: true,
        numbers: { mobile: { monthlyUsd: 5.0, docStatus: 'docs' }, 'toll free': { monthlyUsd: 40.0, docStatus: 'docs' } },
    },
    {
        code: 'CZ', nameTr: 'Çekya', nameEn: 'Czechia', dialCode: '+420',
        intlMobileUsd: 0.1499, intlFixedUsd: 0.044, euMobileUsd: 0.1499, euFixedUsd: 0.044,
        mobilePrefixes: ['420601', '420602', '420603', '420604', '420605', '420606', '420607', '420608', '420702', '420703', '420705', '42072', '42073', '42077', '42079', '420840', '420841', '420842', '420847', '420848', '420849', '42093', '420961', '420962', '420963', '420964', '420965', '420966', '420967'], callable: true,
        numbers: { mobile: { monthlyUsd: 12.0, docStatus: 'docs' }, national: { monthlyUsd: 1.5, docStatus: 'docs' }, 'toll free': { monthlyUsd: 35.0, docStatus: 'docs' } },
    },
    {
        code: 'SK', nameTr: 'Slovakya', nameEn: 'Slovakia', dialCode: '+421',
        intlMobileUsd: 0.1158, intlFixedUsd: 0.0298, euMobileUsd: 0.1158, euFixedUsd: 0.0298,
        mobilePrefixes: ['421901', '421902', '421903', '421904', '421905', '421906', '421907', '421908', '421910', '421911', '421912', '421914', '421915', '421916', '421917', '421918', '421919', '421940', '421944', '421945', '421948', '421949'], callable: true,
        numbers: { 'toll free': { monthlyUsd: 25.0, docStatus: 'docs' } },
    },
    {
        code: 'RO', nameTr: 'Romanya', nameEn: 'Romania', dialCode: '+40',
        intlMobileUsd: 0.032, intlFixedUsd: 0.0125, euMobileUsd: 0.032, euFixedUsd: 0.0125,
        mobilePrefixes: ['4070', '4071', '4072', '4073', '4074', '4075', '4076', '4077', '4078', '40799', '4080'], callable: true,
        numbers: { local: { monthlyUsd: 3.0, docStatus: 'docs' }, national: { monthlyUsd: 3.0, docStatus: 'docs' }, 'toll free': { monthlyUsd: 25.0, docStatus: 'docs' } },
    },
    {
        code: 'HU', nameTr: 'Macaristan', nameEn: 'Hungary', dialCode: '+36',
        intlMobileUsd: 0.1155, intlFixedUsd: 0.1042, euMobileUsd: 0.1155, euFixedUsd: 0.1042,
        mobilePrefixes: ['3620', '3630', '3631', '3670'], callable: true,
        numbers: { mobile: { monthlyUsd: 35.0, docStatus: 'docs' } },
    },
    {
        code: 'BG', nameTr: 'Bulgaristan', nameEn: 'Bulgaria', dialCode: '+359',
        intlMobileUsd: 0.5855, intlFixedUsd: 0.1171, euMobileUsd: 0.5855, euFixedUsd: 0.1171,
        mobilePrefixes: ['35987', '35988', '35989', '359988', '359989'], callable: true,
        numbers: { 'toll free': { monthlyUsd: 110.0, docStatus: 'docs' } },
    },
    {
        code: 'GR', nameTr: 'Yunanistan', nameEn: 'Greece', dialCode: '+30',
        intlMobileUsd: 0.4964, intlFixedUsd: 0.1842, euMobileUsd: 0.4964, euFixedUsd: 0.1842,
        mobilePrefixes: ['306905', '306906', '306907', '306908', '306909', '30693', '30694', '30695', '30697', '30698', '30699'], callable: true,
        numbers: { local: { monthlyUsd: 1.0, docStatus: 'docs' } },
    },
    {
        code: 'UA', nameTr: 'Ukrayna', nameEn: 'Ukraine', dialCode: '+380',
        intlMobileUsd: 0.4098, intlFixedUsd: 0.3141, euMobileUsd: 0.4098, euFixedUsd: 0.3141,
        mobilePrefixes: ['38050', '38063', '38066', '38067', '380680', '380681', '380682', '380683', '380684', '380685', '380686', '380687', '380688', '380689', '38093', '38095', '38096', '38097', '38098', '38099'], callable: true,
        numbers: {},
    },
    {
        code: 'RS', nameTr: 'Sırbistan', nameEn: 'Serbia', dialCode: '+381',
        intlMobileUsd: 0.8211, intlFixedUsd: 0.597, euMobileUsd: 0.8211, euFixedUsd: 0.597,
        mobilePrefixes: ['38160', '38161', '38162', '38163', '38164', '38165', '38166', '38168', '38169'], callable: true,
        numbers: {},
    },
    {
        code: 'UZ', nameTr: 'Özbekistan', nameEn: 'Uzbekistan', dialCode: '+998',
        intlMobileUsd: 0.1972, intlFixedUsd: 0.1982, euMobileUsd: 0.1972, euFixedUsd: 0.1982,
        mobilePrefixes: ['9989'], callable: true,
        numbers: {},
    },
    {
        code: 'GE', nameTr: 'Gürcistan', nameEn: 'Georgia', dialCode: '+995',
        intlMobileUsd: 0.4727, intlFixedUsd: 0.3662, euMobileUsd: 0.4727, euFixedUsd: 0.3662,
        mobilePrefixes: ['995514', '995551', '995555', '995557', '995558', '995568', '995570', '995571', '995574', '995577', '995579', '995591', '995592', '995593', '995595', '995596', '995597', '995598', '995599'], callable: true,
        numbers: { local: { monthlyUsd: 18.0, docStatus: 'docs' }, national: { monthlyUsd: 18.0, docStatus: 'docs' } },
    },
    {
        code: 'AZ', nameTr: 'Azerbaycan', nameEn: 'Azerbaijan', dialCode: '+994',
        intlMobileUsd: 0.6257, intlFixedUsd: 0.3989, euMobileUsd: 0.6257, euFixedUsd: 0.3989,
        mobilePrefixes: ['99440', '99444', '99450', '99451', '99455', '99460', '99470', '99477'], callable: true,
        numbers: {},
    },
    {
        code: 'QA', nameTr: 'Katar', nameEn: 'Qatar', dialCode: '+974',
        intlMobileUsd: 0.3993, intlFixedUsd: 0.3013, euMobileUsd: 0.3993, euFixedUsd: 0.3013,
        mobilePrefixes: ['974124', '9742', '9743', '9745', '9746', '9747'], callable: true,
        numbers: {},
    },
    {
        code: 'KW', nameTr: 'Kuveyt', nameEn: 'Kuwait', dialCode: '+965',
        intlMobileUsd: 0.13, intlFixedUsd: 0.1026, euMobileUsd: 0.13, euFixedUsd: 0.1026,
        mobilePrefixes: ['9655', '9656', '9659'], callable: true,
        numbers: {},
    },
    {
        code: 'BH', nameTr: 'Bahreyn', nameEn: 'Bahrain', dialCode: '+973',
        intlMobileUsd: 0.2261, intlFixedUsd: 0.2267, euMobileUsd: 0.2261, euFixedUsd: 0.2267,
        mobilePrefixes: ['97331', '973320', '973322', '973323', '97333', '97334', '97335', '97336', '97337', '973383', '973384', '973388', '97339', '9736300', '9736333', '9736361', '9736366', '973663', '973666', '973669'], callable: true,
        numbers: {},
    },
    {
        code: 'OM', nameTr: 'Umman', nameEn: 'Oman', dialCode: '+968',
        intlMobileUsd: 0.41, intlFixedUsd: 0.4145, euMobileUsd: 0.41, euFixedUsd: 0.4145,
        mobilePrefixes: ['9681505', '9689'], callable: true,
        numbers: {},
    },
    {
        code: 'JO', nameTr: 'Ürdün', nameEn: 'Jordan', dialCode: '+962',
        intlMobileUsd: 0.3448, intlFixedUsd: 0.2677, euMobileUsd: 0.3448, euFixedUsd: 0.2677,
        mobilePrefixes: ['96275', '96277', '96278', '96279'], callable: true,
        numbers: {},
    },
    {
        code: 'EG', nameTr: 'Mısır', nameEn: 'Egypt', dialCode: '+20',
        intlMobileUsd: 0.209, intlFixedUsd: 0.2056, euMobileUsd: 0.209, euFixedUsd: 0.2056,
        mobilePrefixes: ['2011'], callable: true,
        numbers: {},
    },
    {
        code: 'MA', nameTr: 'Fas', nameEn: 'Morocco', dialCode: '+212',
        intlMobileUsd: 1.0748, intlFixedUsd: 0.5307, euMobileUsd: 1.0748, euFixedUsd: 0.5307,
        mobilePrefixes: ['2126', '2127', '2128920'], callable: true,
        numbers: {},
    },
    {
        code: 'DZ', nameTr: 'Cezayir', nameEn: 'Algeria', dialCode: '+213',
        intlMobileUsd: 1.8365, intlFixedUsd: 0.1161, euMobileUsd: 1.8365, euFixedUsd: 0.1161,
        mobilePrefixes: ['2135', '2136', '2137', '21396'], callable: true,
        numbers: { local: { monthlyUsd: 33.0, docStatus: 'docs' } },
    },
    {
        code: 'TN', nameTr: 'Tunus', nameEn: 'Tunisia', dialCode: '+216',
        intlMobileUsd: 1.2714, intlFixedUsd: 1.5995, euMobileUsd: 1.2714, euFixedUsd: 1.5995,
        mobilePrefixes: ['2160', '2162', '21640', '21641', '21642', '2165', '2169', '2170'], callable: true,
        numbers: { local: { monthlyUsd: 120.0, docStatus: 'docs' }, national: { monthlyUsd: 120.0, docStatus: 'docs' } },
    },
    {
        code: 'NG', nameTr: 'Nijerya', nameEn: 'Nigeria', dialCode: '+234',
        intlMobileUsd: 0.2349, intlFixedUsd: 0.2303, euMobileUsd: 0.2349, euFixedUsd: 0.2303,
        mobilePrefixes: ['234701', '234702', '234703', '2347047', '2347048', '2347049', '234705', '234706', '234708', '234802', '234803', '234804', '234805', '234806', '234807', '234808', '234809', '234810', '234811', '234812', '234813', '234814', '234815', '234816', '234817', '234818', '234902', '234903', '234905', '234906', '234907', '234908', '234909'], callable: true,
        numbers: {},
    },
    {
        code: 'KE', nameTr: 'Kenya', nameEn: 'Kenya', dialCode: '+254',
        intlMobileUsd: 0.3933, intlFixedUsd: 0.3779, euMobileUsd: 0.3933, euFixedUsd: 0.3779,
        mobilePrefixes: ['2547'], callable: true,
        numbers: {},
    },
    {
        code: 'ZA', nameTr: 'Güney Afrika', nameEn: 'South Africa', dialCode: '+27',
        intlMobileUsd: 0.3749, intlFixedUsd: 0.4725, euMobileUsd: 0.3749, euFixedUsd: 0.4725,
        mobilePrefixes: ['27600', '27603', '27604', '27605', '27606', '27607', '27608', '27609', '27610', '27611', '27612', '27613', '27614', '27615', '27616', '27617', '27618', '27619', '2762', '27630', '27631', '27632', '27633', '27634', '27635', '27636', '27637', '27638', '27639', '27640', '27641', '27642', '27643', '27644', '27645', '27646', '27647', '27648', '27649', '27650', '27651', '27652', '27653', '27654', '27655', '27656', '27657', '27658', '27659', '27660', '27661', '27662', '27663', '27664', '27665', '27670', '27710', '27711', '27712', '27713', '27714', '27715', '27716', '27717', '27718', '27719', '2772', '2773', '2774', '2776', '2778', '2779', '27810', '27811', '27812', '27813', '27814', '27815', '27816', '27817', '27818', '27819', '2782', '2783', '2784', '2785', '2787285', '2787286', '2787287', '2787288', '2787289'], callable: true,
        numbers: { mobile: { monthlyUsd: 4.0, docStatus: 'docs' }, national: { monthlyUsd: 1.5, docStatus: 'docs' } },
    },
    {
        code: 'IN', nameTr: 'Hindistan', nameEn: 'India', dialCode: '+91',
        intlMobileUsd: 0.0496, intlFixedUsd: 0.0699, euMobileUsd: 0.0496, euFixedUsd: 0.0699,
        mobilePrefixes: ['91510', '9170', '91720', '917250', '917259', '917265', '917275', '917276', '917277', '917278', '917293', '917298', '917299', '917373', '917376', '917377', '917379', '917382', '917396', '917398', '917399', '917411', '917415', '917416', '917417', '917418', '917419', '917428', '917429', '917439', '917483', '917488', '917489', '917498', '917499', '917500', '917501', '917502', '917503', '917504', '917505', '917520', '917549', '917566', '917567', '917568', '917569', '9175728', '9175729', '9175730', '9175738', '9175739', '9175740', '9175748', '9175749', '9175750', '9175758', '9175790', '9175791', '9175792', '9175794', '9175870', '9175871', '9175872', '9175873', '9175874', '917588', '9175890', '9175891', '9175892', '9175893', '9175894', '9175895', '917597', '917598', '9175990', '9175991', '9175992', '9175993', '9175994', '917600', '917602', '917607', '917620', '917631', '917639', '917654', '917665', '917666', '917667', '917668', '917669', '917676', '917677', '917679', '917696', '917697', '917698', '917699', '9177', '9178', '91800', '91801', '91805', '91807', '91808', '91809', '91810', '918115', '918116', '91812', '918130', '91814', '918171', '918179', '918197', '918220', '9182329', '918233', '918235', '918237', '918238', '918239', '918252', '918260', '918264', '918268', '918269', '918270', '918271', '918273', '918275', '9182770', '9182771', '9182772', '9182773', '9182774', '9182775', '9182776', '918280', '918281', '918285', '918286', '918287', '918290', '918291', '918293', '918294', '918295', '918296', '918297', '918298', '9183000', '9183001', '918302', '918303', '918305', '918306', '918307', '918308', '918309', '9183309', '9183310', '9183318', '9183319', '9183320', '9183328', '9183329', '9183330', '9183338', '9183339', '9183340', '9183348', '9183349', '9183350', '9183358', '9183359', '9183360', '9183368', '9183369', '9183370', '918341', '918344', '918347', '918348', '918349', '918374', '918390', '918400', '918401', '918409', '918410', '918420', '918421', '918423', '918427', '918428', '918429', '91843', '918445', '918446', '918447', '918448', '918449', '918453', '918459', '918460', '918469', '918486', '918489', '918500', '918507', '918508', '918509', '918511', '918521', '918526', '918527', '918528', '918529', '918530', '918544', '918547', '918553', '918574', '918575', '918590', '918591', '918595', '918597', '91860', '918650', '918651', '918652', '918653', '918655', '918657', '918658', '918670', '918675', '918679', '918686', '918687', '918688', '918690', '918695', '918696', '918697', '918698', '918699', '918712', '918714', '918722', '918726', '918750', '918754', '918755', '918756', '918757', '918758', '918759', '918760', '918762', '918763', '9187640', '9187641', '9187642', '9187643', '9187644', '9187645', '9187646', '9187647', '918765', '918766', '918767', '918768', '918769', '918779', '91879', '91880', '918810', '918815', '918817', '918820', '918822', '918824', '918825', '918826', '918827', '918828', '918853', '918858', '918859', '918860', '918861', '918866', '918867', '91887', '91888', '91889', '91890', '918923', '918925', '918926', '918927', '918928', '918929', '918930', '918939', '918940', '918943', '918948', '91895', '918960', '918961', '918962', '918967', '918968', '918969', '91897', '91898', '91899', '919'], callable: true,
        numbers: {},
    },
    {
        code: 'PK', nameTr: 'Pakistan', nameEn: 'Pakistan', dialCode: '+92',
        intlMobileUsd: 0.18, intlFixedUsd: 0.155, euMobileUsd: 0.18, euFixedUsd: 0.155,
        mobilePrefixes: ['923'], callable: true,
        numbers: {},
    },
    {
        code: 'BD', nameTr: 'Bangladeş', nameEn: 'Bangladesh', dialCode: '+880',
        intlMobileUsd: 0.06, intlFixedUsd: 0.06, euMobileUsd: 0.06, euFixedUsd: 0.06,
        mobilePrefixes: ['8801'], callable: true,
        numbers: {},
    },
    {
        code: 'CN', nameTr: 'Çin', nameEn: 'China', dialCode: '+86',
        intlMobileUsd: 0.3432, intlFixedUsd: 0.3231, euMobileUsd: 0.3432, euFixedUsd: 0.3231,
        mobilePrefixes: ['8613', '86145', '86147', '86150', '86151', '86152', '86153', '86155', '86156', '86157', '86158', '86159', '861700', '86177', '86180', '86182', '86183', '86185', '86186', '86187', '86188', '86189'], callable: true,
        numbers: {},
    },
    {
        code: 'HK', nameTr: 'Hong Kong', nameEn: 'Hong Kong', dialCode: '+852',
        intlMobileUsd: 0.0546, intlFixedUsd: 0.0414, euMobileUsd: 0.0546, euFixedUsd: 0.0414,
        mobilePrefixes: ['85217', '85248', '85249', '85251', '8525230', '8525231', '8525232', '8525233', '8525260', '8525261', '8525262', '8525263', '8525264', '85253', '85254', '85255', '85256', '85259', '8526', '8529'], callable: true,
        numbers: { mobile: { monthlyUsd: 15.0, docStatus: 'docs' }, 'toll free': { monthlyUsd: 25.0, docStatus: 'docs' } },
    },
    {
        code: 'TW', nameTr: 'Tayvan', nameEn: 'Taiwan', dialCode: '+886',
        intlMobileUsd: 0.1985, intlFixedUsd: 0.1196, euMobileUsd: 0.1985, euFixedUsd: 0.1196,
        mobilePrefixes: ['8869', '8870'], callable: true,
        numbers: {},
    },
    {
        code: 'KR', nameTr: 'Güney Kore', nameEn: 'South Korea', dialCode: '+82',
        intlMobileUsd: 0.0524, intlFixedUsd: 0.0552, euMobileUsd: 0.0524, euFixedUsd: 0.0552,
        mobilePrefixes: ['821'], callable: true,
        numbers: {},
    },
    {
        code: 'SG', nameTr: 'Singapur', nameEn: 'Singapore', dialCode: '+65',
        intlMobileUsd: 0.0578, intlFixedUsd: 0.0423, euMobileUsd: 0.0578, euFixedUsd: 0.0423,
        mobilePrefixes: ['658', '659'], callable: true,
        numbers: {},
    },
    {
        code: 'MY', nameTr: 'Malezya', nameEn: 'Malaysia', dialCode: '+60',
        intlMobileUsd: 0.08, intlFixedUsd: 0.0555, euMobileUsd: 0.08, euFixedUsd: 0.0555,
        mobilePrefixes: ['601'], callable: true,
        numbers: { local: { monthlyUsd: 4.0, docStatus: 'docs' }, 'toll free': { monthlyUsd: 25.0, docStatus: 'docs' } },
    },
    {
        code: 'TH', nameTr: 'Tayland', nameEn: 'Thailand', dialCode: '+66',
        intlMobileUsd: 0.1, intlFixedUsd: 0.1, euMobileUsd: 0.1, euFixedUsd: 0.1,
        mobilePrefixes: ['668', '669'], callable: true,
        numbers: { local: { monthlyUsd: 25.0, docStatus: 'docs' }, mobile: { monthlyUsd: 22.0, docStatus: 'docs' }, 'toll free': { monthlyUsd: 25.0, docStatus: 'docs' } },
    },
    {
        code: 'VN', nameTr: 'Vietnam', nameEn: 'Vietnam', dialCode: '+84',
        intlMobileUsd: 0.1777, intlFixedUsd: 0.1947, euMobileUsd: 0.1777, euFixedUsd: 0.1947,
        mobilePrefixes: ['8432', '8433', '8434', '8435', '8436', '8437', '8438', '8439', '8456', '8458', '8459', '8470', '8476', '8477', '8478', '8479', '8481', '8482', '8483', '8484', '8485', '849'], callable: true,
        numbers: {},
    },
    {
        code: 'PH', nameTr: 'Filipinler', nameEn: 'Philippines', dialCode: '+63',
        intlMobileUsd: 0.2938, intlFixedUsd: 0.2066, euMobileUsd: 0.2938, euFixedUsd: 0.2066,
        mobilePrefixes: ['63813', '63817', '639'], callable: true,
        numbers: { local: { monthlyUsd: 15.0, docStatus: 'docs' }, mobile: { monthlyUsd: 120.0, docStatus: 'docs' }, 'toll free': { monthlyUsd: 25.0, docStatus: 'docs' } },
    },
    {
        code: 'ID', nameTr: 'Endonezya', nameEn: 'Indonesia', dialCode: '+62',
        intlMobileUsd: 0.1066, intlFixedUsd: 0.1077, euMobileUsd: 0.1066, euFixedUsd: 0.1077,
        mobilePrefixes: ['628'], callable: true,
        numbers: { 'toll free': { monthlyUsd: 25.0, docStatus: 'docs' } },
    },
    {
        code: 'NZ', nameTr: 'Yeni Zelanda', nameEn: 'New Zealand', dialCode: '+64',
        intlMobileUsd: 0.084, intlFixedUsd: 0.0305, euMobileUsd: 0.084, euFixedUsd: 0.0305,
        mobilePrefixes: ['642'], callable: true,
        numbers: { local: { monthlyUsd: 3.15, docStatus: 'docs' }, 'toll free': { monthlyUsd: 40.0, docStatus: 'docs' } },
    },
    {
        code: 'AR', nameTr: 'Arjantin', nameEn: 'Argentina', dialCode: '+54',
        intlMobileUsd: 0.3528, intlFixedUsd: 0.0604, euMobileUsd: 0.3528, euFixedUsd: 0.0604,
        mobilePrefixes: ['549'], callable: true,
        numbers: { local: { monthlyUsd: 8.0, docStatus: 'docs' }, 'toll free': { monthlyUsd: 25.0, docStatus: 'docs' } },
    },
    {
        code: 'CL', nameTr: 'Şili', nameEn: 'Chile', dialCode: '+56',
        intlMobileUsd: 0.0746, intlFixedUsd: 0.0475, euMobileUsd: 0.0746, euFixedUsd: 0.0475,
        mobilePrefixes: ['569'], callable: true,
        numbers: { local: { monthlyUsd: 7.0, docStatus: 'docs' } },
    },
    {
        code: 'CO', nameTr: 'Kolombiya', nameEn: 'Colombia', dialCode: '+57',
        intlMobileUsd: 0.0377, intlFixedUsd: 0.07, euMobileUsd: 0.0377, euFixedUsd: 0.07,
        mobilePrefixes: ['573'], callable: true,
        numbers: { local: { monthlyUsd: 14.0, docStatus: 'docs' }, 'toll free': { monthlyUsd: 25.0, docStatus: 'docs' } },
    },
    {
        code: 'PE', nameTr: 'Peru', nameEn: 'Peru', dialCode: '+51',
        intlMobileUsd: 0.074, intlFixedUsd: 0.1651, euMobileUsd: 0.074, euFixedUsd: 0.1651,
        mobilePrefixes: ['519'], callable: true,
        numbers: { 'toll free': { monthlyUsd: 135.0, docStatus: 'docs' } },
    },
    {
        code: 'UY', nameTr: 'Uruguay', nameEn: 'Uruguay', dialCode: '+598',
        intlMobileUsd: 0.3255, intlFixedUsd: 0.1045, euMobileUsd: 0.3255, euFixedUsd: 0.1045,
        mobilePrefixes: ['5989'], callable: true,
        numbers: {},
    },

    // ── Yaptırım / sağlayıcı-desteklemez (canlı Twilio verisinde yok — bilinçli bloke) ──
    {
        code: 'RU', nameTr: 'Rusya', nameEn: 'Russia', dialCode: '+7',
        intlMobileUsd: 0.1, intlFixedUsd: 0.1, euMobileUsd: 0.1, euFixedUsd: 0.1,
        mobilePrefixes: [], callable: false, blockedReason: 'provider_unsupported',
        numbers: {},
    },
    {
        code: 'BY', nameTr: 'Belarus', nameEn: 'Belarus', dialCode: '+375',
        intlMobileUsd: 0.3, intlFixedUsd: 0.3, euMobileUsd: 0.3, euFixedUsd: 0.3,
        mobilePrefixes: [], callable: false, blockedReason: 'provider_unsupported',
        numbers: {},
    },
    {
        code: 'IR', nameTr: 'İran', nameEn: 'Iran', dialCode: '+98',
        intlMobileUsd: 0.2, intlFixedUsd: 0.2, euMobileUsd: 0.2, euFixedUsd: 0.2,
        mobilePrefixes: [], callable: false, blockedReason: 'sanctioned',
        numbers: {},
    },
    {
        code: 'SY', nameTr: 'Suriye', nameEn: 'Syria', dialCode: '+963',
        intlMobileUsd: 0.35, intlFixedUsd: 0.35, euMobileUsd: 0.35, euFixedUsd: 0.35,
        mobilePrefixes: [], callable: false, blockedReason: 'sanctioned',
        numbers: {},
    },
    {
        code: 'CU', nameTr: 'Küba', nameEn: 'Cuba', dialCode: '+53',
        intlMobileUsd: 0.9, intlFixedUsd: 0.9, euMobileUsd: 0.9, euFixedUsd: 0.9,
        mobilePrefixes: [], callable: false, blockedReason: 'sanctioned',
        numbers: {},
    },
    {
        code: 'KP', nameTr: 'Kuzey Kore', nameEn: 'North Korea', dialCode: '+850',
        intlMobileUsd: 1.0, intlFixedUsd: 1.0, euMobileUsd: 1.0, euFixedUsd: 1.0,
        mobilePrefixes: [], callable: false, blockedReason: 'sanctioned',
        numbers: {},
    },
];

const byCode = new Map(COUNTRY_PRICING.map((c) => [c.code, c]));

export function countryByCode(code: string): CountryVoiceInfo | undefined {
    return byCode.get(code.toUpperCase());
}

/**
 * NANP (+1) premium / yüksek-maliyet / IRSF-riskli alan kodları (NPA).
 * +1 sadece US/CA değil; ~25 Karayip/Pasifik ülkesi de +1 kullanır ve bunların
 * dakika maliyeti US'in 5-30 katı (ve dolandırıcılık hedefi). Bunları US
 * tarifesiyle karıştırmak marj eritir → fail-closed: bu NPA'lar aranamaz.
 * (Kaynak: NANPA ülke-kodu atamaları; premium 900 dahil.)
 */
const NANP_PREMIUM_NPAS = new Set([
    '242', '246', '264', '268', '284', '340', '345', '441', '473', '649', '658',
    '664', '721', '758', '767', '784', '809', '829', '849', '868', '869', '876',
    '900', // premium-rate
]);

// Explicitly mapped US/Canada NPAs. Unknown +1 destinations fail closed instead
// of inheriting the cheap US rate; additions require a reviewed pricing update.
const NANP_CANADA_NPAS = new Set([
    '204','226','236','249','250','263','289','306','343','354','365','367','368','382',
    '403','416','418','428','431','437','438','450','468','474','506','514','519','548',
    '579','581','584','587','604','613','639','647','672','683','705','709','742','753',
    '778','780','782','807','819','825','867','873','879','902','905',
]);
const NANP_US_NPAS = new Set([
    '201','202','203','205','206','207','208','209','210','212','213','214','215','216',
    '217','218','219','220','223','224','225','227','228','229','231','234','235','239',
    '240','248','251','252','253','254','256','260','262','267','269','270','272','274',
    '276','279','281','283','301','302','303','304','305','307','308','309','310','312',
    '313','314','315','316','317','318','319','320','321','323','325','326','327','329',
    '330','331','332','334','336','337','339','341','346','347','350','351','352','360',
    '361','363','364','369','380','385','386','401','402','404','405','406','407','408',
    '409','410','412','413','414','415','417','419','423','424','425','430','432','434',
    '435','436','440','442','443','445','447','448','458','463','464','469','470','475',
    '478','479','480','484','501','502','503','504','505','507','508','509','510','512',
    '513','515','516','517','518','520','530','531','534','539','540','541','551','557',
    '559','561','562','563','564','567','570','571','572','573','574','575','580','582',
    '585','586','601','602','603','605','606','607','608','609','610','612','614','615',
    '616','617','618','619','620','623','626','628','629','630','631','636','640','641',
    '646','650','651','656','657','659','660','661','662','667','669','678','680','681',
    '682','689','701','702','703','704','706','707','708','712','713','714','715','716',
    '717','718','719','720','724','725','726','727','728','730','731','732','734','737',
    '740','743','747','754','757','760','762','763','765','769','770','771','772','773',
    '774','775','779','781','785','786','787','801','802','803','804','805','806','808',
    '810','812','813','814','815','816','817','818','820','826','828','830','831','832',
    '835','838','839','840','843','845','847','848','850','854','856','857','858','859',
    '860','862','863','864','865','870','872','878','901','903','904','906','908','909',
    '910','912','913','914','915','916','917','918','919','920','925','928','929','930',
    '931','934','936','937','938','940','941','943','945','947','948','949','951','952',
    '954','956','959','970','971','972','973','975','978','979','980','983','984','985',
    '986','989',
]);

function blockedNanp(npa: string): CountryVoiceInfo {
    return {
        code: 'XN', nameTr: `Karayip/Premium (+1 ${npa})`, nameEn: `Caribbean/Premium (+1 ${npa})`,
        dialCode: '+1', intlMobileUsd: 0.5, intlFixedUsd: 0.5, euMobileUsd: 0.5, euFixedUsd: 0.5,
        mobilePrefixes: [], callable: false, blockedReason: 'premium_rate_risk', numbers: {},
    };
}

/**
 * ARANABİLİR ama US tarifesinden PAHALI +1 NPA'ları (codex P1): ABD toprakları/eyaletleri.
 * Twilio bunları US ($0.014) değil kendi yüksek tarifeleriyle faturalar (canlı v2 doğrulaması
 * 2026-07-14). Blocklamıyoruz (meşru hedef) — doğru orana yönlendiriyoruz. Origin-bağımsız.
 */
const NANP_NPA_RATES: Record<string, { code: string; nameTr: string; nameEn: string; usd: number }> = {
    '684': { code: 'AS', nameTr: 'Amerikan Samoası', nameEn: 'American Samoa', usd: 0.4576 },
    '670': { code: 'MP', nameTr: 'K. Mariana Adaları', nameEn: 'N. Mariana Islands', usd: 0.105 },
    '907': { code: 'US-AK', nameTr: 'Alaska (ABD)', nameEn: 'Alaska (US)', usd: 0.0945 },
    '671': { code: 'GU', nameTr: 'Guam', nameEn: 'Guam', usd: 0.0589 },
};

function rateNanp(npa: string): CountryVoiceInfo {
    const o = NANP_NPA_RATES[npa];
    return {
        code: o.code, nameTr: o.nameTr, nameEn: o.nameEn, dialCode: '+1',
        intlMobileUsd: o.usd, intlFixedUsd: o.usd, euMobileUsd: o.usd, euFixedUsd: o.usd,
        mobilePrefixes: [], callable: true, numbers: {},
    };
}

/**
 * E.164 numaradan ülke tespiti — en uzun dial code eşleşmesi.
 */
const sortedByDialLen = [...COUNTRY_PRICING].sort((a, b) => b.dialCode.length - a.dialCode.length);

export function countryForE164(e164: string): CountryVoiceInfo | undefined {
    // RU bloklu (+7 KZ artık envanterde yok) — +7 çakışmasında RU tercih edilir, fail-closed.
    if (/^\+7\d/.test(e164)) return byCode.get('RU');
    // +1 NANP: premium/Karayip NPA'ları bloke; pahalı ABD toprakları/eyaletleri (AS/AK/GU/MP)
    // kendi yüksek tarifesine; kalanı US/CA tarifesi (codex P1).
    if (/^\+1\d{3}/.test(e164)) {
        const npa = e164.slice(2, 5);
        if (NANP_PREMIUM_NPAS.has(npa)) return blockedNanp(npa);
        if (NANP_NPA_RATES[npa]) return rateNanp(npa);
        if (NANP_CANADA_NPAS.has(npa)) return byCode.get('CA');
        if (NANP_US_NPAS.has(npa)) return byCode.get('US');
        return undefined;
    }
    return sortedByDialLen.find((c) => e164.startsWith(c.dialCode));
}
