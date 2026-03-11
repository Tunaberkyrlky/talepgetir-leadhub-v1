/**
 * Import Mapper — Fuzzy header matching for CSV/XLSX imports
 * Matches uploaded file headers to known DB field aliases
 */

// Known DB fields with their aliases for fuzzy matching
const FIELD_ALIASES: Record<string, { table: string; field: string; aliases: string[]; required: boolean }> = {
    'companies.name': {
        table: 'companies',
        field: 'name',
        aliases: ['company_name', 'şirket adı', 'firma', 'company name', 'firma adı', 'şirket', 'name'],
        required: true,
    },
    'companies.website': {
        table: 'companies',
        field: 'website',
        aliases: ['website', 'web', 'url', 'site', 'web sitesi', 'web site', 'company website', 'company url'],
        required: false,
    },
    'companies.location': {
        table: 'companies',
        field: 'location',
        aliases: ['location', 'konum', 'şehir', 'city', 'lokasyon', 'address', 'adres', 'company location', 'headquarters', 'hq location'],
        required: false,
    },
    'companies.industry': {
        table: 'companies',
        field: 'industry',
        aliases: ['industry', 'sektör', 'sector', 'sektoru', 'endüstri', 'company type', 'company_type', 'business type', 'type of business', 'vertical'],
        required: false,
    },
    'companies.employee_size': {
        table: 'companies',
        field: 'employee_size',
        aliases: ['employee_size', 'employee_count', 'çalışan sayısı', 'employees', 'çalışan', 'personel sayısı', 'employee', 'headcount', 'head count', 'number of employees', 'staff size', 'workforce', 'team size', 'company size'],
        required: false,
    },
    'companies.product_services': {
        table: 'companies',
        field: 'product_services',
        aliases: ['product_services', 'products', 'services', 'ürün hizmet', 'ürünler', 'hizmetler', 'product/service', 'products and services'],
        required: false,
    },
    'companies.description': {
        table: 'companies',
        field: 'description',
        aliases: ['description', 'about', 'hakkında', 'açıklama', 'aciklama', 'desc', 'about company', 'company description', 'overview', 'short description'],
        required: false,
    },
    'companies.linkedin': {
        table: 'companies',
        field: 'linkedin',
        aliases: ['linkedin', 'linkedin_url', 'linkedin url', 'company linkedin', 'linkedin profil', 'company linkedin url'],
        required: false,
    },
    'companies.company_phone': {
        table: 'companies',
        field: 'company_phone',
        aliases: ['company_phone', 'şirket telefonu', 'şirket tel', 'company phone', 'office phone', 'ofis telefon', 'central phone', 'primary company phone', 'main phone', 'office number', 'business phone', 'corporate phone'],
        required: false,
    },
    'companies.stage': {
        table: 'companies',
        field: 'stage',
        aliases: ['stage', 'durum', 'status', 'aşama', 'asama', 'safha', 'pipeline stage', 'deal stage'],
        required: false,
    },
    'companies.deal_summary': {
        table: 'companies',
        field: 'deal_summary',
        aliases: ['deal_summary', 'özet', 'summary', 'anlaşma özeti', 'deal summary', 'notes'],
        required: false,
    },
    'companies.next_step': {
        table: 'companies',
        field: 'next_step',
        aliases: ['next_step', 'sonraki adım', 'follow_up', 'sonraki_adim', 'takip', 'next step', 'follow up', 'action item'],
        required: false,
    },
    'contacts.first_name': {
        table: 'contacts',
        field: 'first_name',
        aliases: [
            'first_name', 'first name', 'firstname', 'isim', 'kişi adı', 'contact name',
            'full_name', 'full name', 'fullname', 'yetkili', 'yetkili kişi', 'ad soyad', 'isim soyisim',
            'contact first name', 'given name',
        ],
        required: false,
    },
    'contacts.last_name': {
        table: 'contacts',
        field: 'last_name',
        aliases: [
            'last_name', 'last name', 'lastname', 'surname', 'soyad', 'soy isim', 'soyadı',
            'contact last name', 'family name',
        ],
        required: false,
    },
    'contacts.title': {
        table: 'contacts',
        field: 'title',
        aliases: ['contact_title', 'pozisyon', 'title', 'ünvan', 'unvan', 'görev', 'gorev', 'job title', 'job_title', 'position', 'role'],
        required: false,
    },
    'contacts.email': {
        table: 'contacts',
        field: 'email',
        aliases: ['contact_email', 'email', 'e-posta', 'eposta', 'e_posta', 'mail', 'email address', 'work email', 'business email', 'email 1'],
        required: false,
    },
    'contacts.phone_e164': {
        table: 'contacts',
        field: 'phone_e164',
        aliases: ['contact_phone', 'telefon', 'phone', 'cep', 'cep telefonu', 'mobile', 'phone number', 'mobile phone', 'direct phone', 'personal phone', 'contact phone'],
        required: false,
    },
    'contacts.country': {
        table: 'contacts',
        field: 'country',
        aliases: ['contact country', 'ülke', 'ulke', 'contact location'],
        required: false,
    },
    'contacts.seniority': {
        table: 'contacts',
        field: 'seniority',
        aliases: ['seniority', 'kıdem', 'kidem', 'seviye', 'level', 'seniority level', 'experience level', 'management level'],
        required: false,
    },
    'contacts.department': {
        table: 'contacts',
        field: 'department',
        aliases: ['department', 'departman', 'bölüm', 'bolum', 'team', 'takım', 'takim', 'division', 'business unit'],
        required: false,
    },
    'contacts.linkedin': {
        table: 'contacts',
        field: 'linkedin',
        aliases: ['contact linkedin', 'contact linkedin url', 'person linkedin', 'people linkedin', 'linkedin profil', 'kişi linkedin', 'linkedin'],
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
 * Normalize a string for comparison: lowercase, trim, remove special chars
 */
function normalize(str: string): string {
    return str
        .toLowerCase()
        .trim()
        .replace(/[_\-\.]/g, ' ')
        .replace(/\s+/g, ' ');
}

/**
 * Simple string similarity (Dice coefficient + word overlap)
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
        // Score proportional to how much of the longer string is covered
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
