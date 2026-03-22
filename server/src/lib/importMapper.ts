/**
 * Import Mapper — Fuzzy header matching for CSV/XLSX imports
 * Matches uploaded file headers to known DB field aliases
 */

// Known DB fields with their aliases for fuzzy matching
const FIELD_ALIASES: Record<string, { table: string; field: string; aliases: string[]; required: boolean }> = {
    'companies.name': {
        table: 'companies',
        field: 'name',
        aliases: [
            'company_name', 'company name', 'name', 'firma', 'firma adı', 'şirket', 'şirket adı',
            'sirket', 'sirket adi', 'kurum', 'kurum adı', 'işletme', 'isletme', 'organization',
            'organisation', 'account name', 'account',
        ],
        required: true,
    },
    'companies.website': {
        table: 'companies',
        field: 'website',
        aliases: [
            'website', 'web', 'url', 'site', 'domain', 'web sitesi', 'web site',
            'company website', 'company url', 'company domain', 'web adresi', 'internet adresi',
            'homepage', 'ana sayfa',
        ],
        required: false,
    },
    'companies.location': {
        table: 'companies',
        field: 'location',
        aliases: [
            'location', 'konum', 'lokasyon', 'address', 'adres', 'şehir', 'sehir', 'city',
            'il', 'ilçe', 'ilce', 'company location', 'headquarters', 'hq location',
            'company address', 'merkez', 'genel merkez', 'bölge', 'region',
        ],
        required: false,
    },
    'companies.industry': {
        table: 'companies',
        field: 'industry',
        aliases: [
            'industry', 'sektör', 'sektor', 'sector', 'sektoru', 'endüstri', 'endustri',
            'company type', 'company_type', 'business type', 'type of business', 'vertical',
            'iş alanı', 'is alani', 'faaliyet alanı', 'faaliyet alani',
        ],
        required: false,
    },
    'companies.employee_size': {
        table: 'companies',
        field: 'employee_size',
        aliases: [
            'employee_size', 'employee_count', 'employees', 'employee', 'headcount', 'head count',
            'çalışan sayısı', 'calisan sayisi', 'çalışan', 'calisan', 'personel sayısı', 'personel',
            'number of employees', 'staff size', 'workforce', 'team size', 'company size',
        ],
        required: false,
    },
    'companies.product_services': {
        table: 'companies',
        field: 'product_services',
        aliases: [
            'product_services', 'products', 'services', 'product/service', 'products and services',
            'ürün hizmet', 'urun hizmet', 'ürünler', 'urunler', 'hizmetler',
            'ürün ve hizmetler', 'urun ve hizmetler', 'specialties', 'uzmanlık alanı',
        ],
        required: false,
    },
    'companies.product_portfolio': {
        table: 'companies',
        field: 'product_portfolio',
        aliases: [
            'product_portfolio', 'product portfolio', 'portfolio', 'ürün portföyü', 'urun portfoyu',
            'portföy', 'portfoy', 'ürün kataloğu', 'urun katalogu', 'product catalog',
            'product catalogue', 'katalog', 'ürün yelpazesi',
        ],
        required: false,
    },
    'companies.fit_score': {
        table: 'companies',
        field: 'fit_score',
        aliases: [
            'fit_score', 'fit score', 'uyum puanı', 'uyum puani', 'uyum skoru',
            'score', 'puan', 'skor', 'match score', 'eşleşme puanı', 'esleme puani',
        ],
        required: false,
    },
    'companies.partnership_observation_1': {
        table: 'companies',
        field: 'partnership_observation_1',
        aliases: [
            'partnership_observation_1', 'partnership observation 1', 'partnership observations ai_1',
            'partnership observations ai 1', 'ortaklık gözlemi 1',
            'ortaklik gozlemi 1', 'gözlem 1', 'gozlem 1', 'observation 1',
        ],
        required: false,
    },
    'companies.partnership_observation_2': {
        table: 'companies',
        field: 'partnership_observation_2',
        aliases: [
            'partnership_observation_2', 'partnership observation 2', 'partnership observations ai_2',
            'partnership observations ai 2', 'ortaklık gözlemi 2',
            'ortaklik gozlemi 2', 'gözlem 2', 'gozlem 2', 'observation 2',
        ],
        required: false,
    },
    'companies.partnership_observation_3': {
        table: 'companies',
        field: 'partnership_observation_3',
        aliases: [
            'partnership_observation_3', 'partnership observation 3', 'partnership observations ai_3',
            'partnership observations ai 3', 'ortaklık gözlemi 3',
            'ortaklik gozlemi 3', 'gözlem 3', 'gozlem 3', 'observation 3',
        ],
        required: false,
    },
    'companies.linkedin': {
        table: 'companies',
        field: 'linkedin',
        aliases: [
            'linkedin', 'linkedin_url', 'linkedin url', 'company linkedin',
            'company linkedin url', 'linkedin profil', 'linkedin profili',
            'şirket linkedin', 'sirket linkedin',
        ],
        required: false,
    },
    'companies.company_phone': {
        table: 'companies',
        field: 'company_phone',
        aliases: [
            'company_phone', 'company phone', 'phone', 'office phone', 'business phone',
            'corporate phone', 'main phone', 'central phone', 'office number',
            'şirket telefonu', 'sirket telefonu', 'şirket tel', 'ofis telefon',
            'primary company phone', 'genel telefon', 'santral',
        ],
        required: false,
    },
    'companies.stage': {
        table: 'companies',
        field: 'stage',
        aliases: [
            'stage', 'status', 'durum', 'aşama', 'asama', 'safha',
            'pipeline stage', 'deal stage', 'lead status', 'lead stage',
            'müşteri durumu', 'musteri durumu',
        ],
        required: false,
    },
    'companies.company_summary': {
        table: 'companies',
        field: 'company_summary',
        aliases: [
            'company_summary', 'company summary', 'summary', 'notes', 'not',
            'özet', 'ozet', 'şirket özeti', 'sirket ozeti',
            'firma özeti', 'firma notları', 'notlar',
        ],
        required: false,
    },
    'companies.next_step': {
        table: 'companies',
        field: 'next_step',
        aliases: [
            'next_step', 'next step', 'follow_up', 'follow up', 'action item',
            'sonraki adım', 'sonraki adim', 'sonraki_adim', 'takip',
            'yapılacak', 'yapilacak', 'aksiyon', 'to do', 'todo',
        ],
        required: false,
    },
    'companies.company_email': {
        table: 'companies',
        field: 'company_email',
        aliases: [
            'company_email', 'company email', 'company mail', 'email', 'e-posta',
            'şirket e-posta', 'sirket email', 'şirket mail', 'sirket mail',
            'email adresi', 'kurumsal mail', 'kurumsal e-posta', 'info mail',
            'info email', 'genel mail', 'iletisim mail',
        ],
        required: false,
    },
    'companies.email_status': {
        table: 'companies',
        field: 'email_status',
        aliases: [
            'email_status', 'email status', 'e-posta durumu', 'mail durumu',
            'OmniVerifier Status', 'omniverifie status', 'omniversifier', 'omniverifier',
            'verification', 'email verification', 'mail doğrulama', 'mail dogrulama',
            'verification status', 'doğrulama durumu', 'dogrulama durumu',
        ],
        required: false,
    },

    // People fields (contacts table)
    'contacts.first_name': {
        table: 'contacts',
        field: 'first_name',
        aliases: [
            'first_name', 'first name', 'firstname', 'given name', 'contact first name',
            'isim', 'ad', 'adı', 'kişi adı', 'kisi adi', 'contact name',
            'full_name', 'full name', 'fullname', 'yetkili', 'yetkili kişi', 'yetkili kisi',
            'ad soyad', 'isim soyisim', 'ad soyadı',
        ],
        required: false,
    },
    'contacts.last_name': {
        table: 'contacts',
        field: 'last_name',
        aliases: [
            'last_name', 'last name', 'lastname', 'surname', 'family name',
            'contact last name', 'soyad', 'soyadı', 'soyadi', 'soy isim', 'soy ad',
        ],
        required: false,
    },
    'contacts.title': {
        table: 'contacts',
        field: 'title',
        aliases: [
            'contact_title', 'title', 'job title', 'job_title', 'position', 'role',
            'pozisyon', 'ünvan', 'unvan', 'görev', 'gorev', 'görevi', 'gorevi',
            'iş unvanı', 'is unvani', 'meslek', 'occupation',
        ],
        required: false,
    },
    'contacts.email': {
        table: 'contacts',
        field: 'email',
        aliases: [
            'contact_email', 'contact email', 'email', 'e-posta', 'eposta', 'e_posta',
            'mail', 'email address', 'work email', 'business email', 'email 1',
            'kişi mail', 'kisi mail', 'kişi e-posta', 'personal email',
        ],
        required: false,
    },
    'contacts.phone_e164': {
        table: 'contacts',
        field: 'phone_e164',
        aliases: [
            'contact_phone', 'contact phone', 'phone', 'telefon', 'tel',
            'cep', 'cep telefonu', 'cep tel', 'mobile', 'mobile phone',
            'phone number', 'direct phone', 'personal phone', 'gsm',
            'kişi telefon', 'kisi telefon', 'cep numarası', 'cep numarasi',
        ],
        required: false,
    },
    'contacts.country': {
        table: 'contacts',
        field: 'country',
        aliases: [
            'country', 'contact country', 'contact location',
            'ülke', 'ulke', 'kişi ülke', 'kisi ulke',
        ],
        required: false,
    },
    'contacts.seniority': {
        table: 'contacts',
        field: 'seniority',
        aliases: [
            'seniority', 'seniority level', 'experience level', 'management level',
            'kıdem', 'kidem', 'seviye', 'level', 'deneyim seviyesi',
            'yönetim seviyesi', 'yonetim seviyesi',
        ],
        required: false,
    },
    'contacts.department': {
        table: 'contacts',
        field: 'department',
        aliases: [
            'department', 'departman', 'bölüm', 'bolum', 'birim',
            'team', 'takım', 'takim', 'division', 'business unit',
            'departmanı', 'departmani', 'çalıştığı birim',
        ],
        required: false,
    },
    'contacts.linkedin': {
        table: 'contacts',
        field: 'linkedin',
        aliases: [
            'contact linkedin', 'contact linkedin url', 'person linkedin',
            'people linkedin', 'linkedin profil', 'linkedin profili',
            'kişi linkedin', 'kisi linkedin', 'linkedin',
        ],
        required: false,
    },
};

export interface MappingSuggestion {
    fileHeader: string;
    dbField: string | null; // null = unmapped → custom_fields
    table: string | null;
    field: string | null;
    confidence: number; // 0-1
    required: boolean;
}

/**
 * Turkish character transliteration map
 */
const TR_MAP: Record<string, string> = {
    'ş': 's', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ü': 'u', 'ç': 'c',
    'Ş': 's', 'Ğ': 'g', 'İ': 'i', 'Ö': 'o', 'Ü': 'u', 'Ç': 'c',
};

/**
 * Transliterate Turkish characters to ASCII equivalents
 */
function transliterateTR(str: string): string {
    return str.replace(/[şğıöüçŞĞİÖÜÇ]/g, (ch) => TR_MAP[ch] || ch);
}

/**
 * Normalize a string for comparison: transliterate Turkish, lowercase,
 * trim, remove special chars, collapse whitespace
 */
function normalize(str: string): string {
    return transliterateTR(str)
        .toLowerCase()
        .trim()
        .replace(/[_\-\.\/\(\)#:;,'"]/g, ' ')
        .replace(/\s+/g, ' ');
}

/**
 * Levenshtein distance between two strings (two-row optimisation)
 */
function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    let curr = new Array<number>(b.length + 1);

    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[b.length];
}

/**
 * String similarity combining multiple strategies:
 * 1. Exact match after normalization (with Turkish transliteration)
 * 2. Substring coverage
 * 3. Word-level overlap
 * 4. Levenshtein for short strings (catches typos)
 * 5. Bigram Dice coefficient
 */
function similarity(a: string, b: string): number {
    const na = normalize(a);
    const nb = normalize(b);

    if (na === nb) return 1;
    if (na.length < 2 || nb.length < 2) return 0;

    // Substring check: only if the shorter string is meaningful (>=5 chars)
    // and covers a significant portion of the longer string
    const shorter = na.length <= nb.length ? na : nb;
    const longer = na.length <= nb.length ? nb : na;
    if (shorter.length >= 5 && longer.includes(shorter)) {
        const coverage = shorter.length / longer.length;
        return 0.6 + coverage * 0.35;
    }

    // Word-level overlap: split into words and check intersection
    const wordsA = na.split(' ').filter(w => w.length > 2);
    const wordsB = nb.split(' ').filter(w => w.length > 2);
    if (wordsA.length > 0 && wordsB.length > 0) {
        const setA = new Set(wordsA);
        const wordMatches = wordsB.filter(w => setA.has(w)).length;
        if (wordMatches > 0) {
            const wordScore = (2 * wordMatches) / (wordsA.length + wordsB.length);
            if (wordScore >= 0.5) return wordScore;
        }
    }

    // Levenshtein for short strings (≤15 chars): catch typos like "compny" → "company"
    if (na.length <= 15 && nb.length <= 15) {
        const maxLen = Math.max(na.length, nb.length);
        const dist = levenshtein(na, nb);
        const levScore = 1 - dist / maxLen;
        if (levScore >= 0.7) return levScore;
    }

    // Bigram-based Dice coefficient
    const bigramsA = new Set<string>();
    for (let i = 0; i < na.length - 1; i++) {
        bigramsA.add(na.substring(i, i + 2));
    }

    const bigramsB = new Set<string>();
    for (let i = 0; i < nb.length - 1; i++) {
        bigramsB.add(nb.substring(i, i + 2));
    }

    let matches = 0;
    for (const bg of bigramsB) {
        if (bigramsA.has(bg)) matches++;
    }

    return (2 * matches) / (bigramsA.size + bigramsB.size);
}

/**
 * Auto-match file headers to DB fields using optimal greedy assignment.
 *
 * Algorithm:
 * 1. Score every (header, dbField) pair using alias similarity.
 * 2. Add a small tiebreaker: how similar is the header to the field key itself
 *    (e.g. "Employee Size" is more similar to "employee_size" than "Headcount" is).
 * 3. Sort all candidates by combined score descending.
 * 4. Greedily assign: highest-score pair wins; skip if header or field already taken.
 * 5. Only accept matches with alias score >= 0.6.
 *
 * This ensures the most direct match (Employee Size → employee_size) beats
 * a synonym (Headcount → employee_size) when they compete for the same field.
 */
export function autoMapHeaders(fileHeaders: string[]): MappingSuggestion[] {
    const MIN_SCORE = 0.6;

    // Build all viable (header, dbField, score) candidates
    const candidates: { header: string; key: string; aliasScore: number; totalScore: number }[] = [];

    for (const header of fileHeaders) {
        const effectiveHeader = header.startsWith('people_') ? header.slice(7) : header;

        for (const [key, fieldDef] of Object.entries(FIELD_ALIASES)) {
            let bestAliasScore = 0;
            let bestAliasLength = 0;
            for (const alias of fieldDef.aliases) {
                const s = Math.max(similarity(header, alias), similarity(effectiveHeader, alias));
                if (s > bestAliasScore || (s === bestAliasScore && alias.length > bestAliasLength)) {
                    bestAliasScore = s;
                    bestAliasLength = alias.length;
                }
            }
            if (bestAliasScore < MIN_SCORE) continue;

            // Tiebreaker 1: longer alias = more specific match (dominates)
            // Tiebreaker 2: similarity to the field key name (secondary)
            const fieldKeyLabel = key.replace(/\./g, ' ').replace(/_/g, ' ');
            const aliasLengthBonus = bestAliasLength * 0.0001;
            const keyBonus = similarity(header, fieldKeyLabel) * 0.00001;

            candidates.push({ header, key, aliasScore: bestAliasScore, totalScore: bestAliasScore + aliasLengthBonus + keyBonus });
        }
    }

    // Sort by totalScore descending — best matches assigned first
    candidates.sort((a, b) => b.totalScore - a.totalScore);

    const usedHeaders = new Set<string>();
    const usedDbFields = new Set<string>();
    const result = new Map<string, MappingSuggestion>();

    for (const { header, key, aliasScore } of candidates) {
        if (usedHeaders.has(header) || usedDbFields.has(key)) continue;
        const fieldDef = FIELD_ALIASES[key];
        usedHeaders.add(header);
        usedDbFields.add(key);
        result.set(header, {
            fileHeader: header,
            dbField: key,
            table: fieldDef.table,
            field: fieldDef.field,
            confidence: aliasScore,
            required: fieldDef.required,
        });
    }

    // Preserve original header order; unmatched headers get null suggestion
    return fileHeaders.map((header) =>
        result.get(header) ?? {
            fileHeader: header,
            dbField: null,
            table: null,
            field: null,
            confidence: 0,
            required: false,
        }
    );
}

/**
 * Get all available DB fields for manual mapping dropdown
 */
export function getAvailableDbFields() {
    return Object.entries(FIELD_ALIASES).map(([key, def]) => ({
        value: key,
        label: `${def.table}.${def.field}`,
        table: def.table,
        field: def.field,
        required: def.required,
    }));
}

/**
 * Sanitize cell value to prevent formula injection
 */
export function sanitizeCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    // Handle ExcelJS hyperlink/rich-text objects: { text, hyperlink } or { richText }
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const raw = obj.hyperlink ?? obj.text ?? obj.result ?? '';
        const str = String(raw).trim();
        if (/^[=+\-@]/.test(str)) return "'" + str;
        return str;
    }
    const str = String(value).trim();
    if (/^[=+\-@]/.test(str)) {
        return "'" + str;
    }
    return str;
}
