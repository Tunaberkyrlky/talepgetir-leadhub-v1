/**
 * Import Mapper — Fuzzy header matching for CSV/XLSX imports
 * Matches uploaded file headers to known DB field aliases
 */

// Known DB fields with their aliases for fuzzy matching
const FIELD_ALIASES: Record<string, { table: string; field: string; aliases: string[]; required: boolean }> = {
    'companies.name': {
        table: 'companies',
        field: 'name',
        aliases: ['company_name', 'şirket adı', 'firma', 'company', 'firma adı', 'şirket', 'name', 'ad'],
        required: true,
    },
    'companies.website': {
        table: 'companies',
        field: 'website',
        aliases: ['website', 'web', 'url', 'site', 'web sitesi', 'web site'],
        required: false,
    },
    'companies.location': {
        table: 'companies',
        field: 'location',
        aliases: ['location', 'konum', 'şehir', 'city', 'ülke', 'country', 'lokasyon', 'il', "Adress"],
        required: false,
    },
    'companies.industry': {
        table: 'companies',
        field: 'industry',
        aliases: ['industry', 'sektör', 'sector', 'sektoru', 'endüstri'],
        required: false,
    },
    'companies.employee_size': {
        table: 'companies',
        field: 'employee_size',
        aliases: ['employee_size', 'employee_count', 'çalışan sayısı', 'employees', 'çalışan', 'personel sayısı', 'employee'],
        required: false,
    },
    'companies.product_services': {
        table: 'companies',
        field: 'product_services',
        aliases: ['product_services', 'products', 'services', 'ürün hizmet', 'ürünler', 'hizmetler', 'product/service'],
        required: false,
    },
    'companies.description': {
        table: 'companies',
        field: 'description',
        aliases: ['description', 'about', 'hakkında', 'açıklama', 'aciklama', 'desc', 'about company'],
        required: false,
    },
    'companies.linkedin': {
        table: 'companies',
        field: 'linkedin',
        aliases: ['linkedin', 'linkedin_url', 'linkedin url', 'company linkedin', 'linkedin profil'],
        required: false,
    },
    'companies.company_phone': {
        table: 'companies',
        field: 'company_phone',
        aliases: ['company_phone', 'şirket telefonu', 'şirket tel', 'company phone', 'office phone', 'ofis telefon', 'central phone'],
        required: false,
    },
    'companies.stage': {
        table: 'companies',
        field: 'stage',
        aliases: ['stage', 'durum', 'status', 'aşama', 'asama', 'safha'],
        required: false,
    },
    'companies.deal_summary': {
        table: 'companies',
        field: 'deal_summary',
        aliases: ['deal_summary', 'özet', 'summary', 'anlaşma özeti', 'deal'],
        required: false,
    },
    'companies.next_step': {
        table: 'companies',
        field: 'next_step',
        aliases: ['next_step', 'sonraki adım', 'follow_up', 'sonraki_adim', 'takip', 'next'],
        required: false,
    },
    'contacts.first_name': {
        table: 'contacts',
        field: 'first_name',
        aliases: [
            'first_name', 'first name', 'firstname', 'ad', 'isim', 'kişi adı', 'contact_name',
            'full_name', 'full name', 'fullname', 'yetkili', 'yetkili kişi', 'ad soyad', 'isim soyisim',
        ],
        required: false,
    },
    'contacts.last_name': {
        table: 'contacts',
        field: 'last_name',
        aliases: [
            'last_name', 'last name', 'lastname', 'surname', 'soyad', 'soy isim', 'soyadı',
        ],
        required: false,
    },
    'contacts.title': {
        table: 'contacts',
        field: 'title',
        aliases: ['contact_title', 'pozisyon', 'title', 'ünvan', 'unvan', 'görev', 'gorev', 'job title', 'job_title'],
        required: false,
    },
    'contacts.email': {
        table: 'contacts',
        field: 'email',
        aliases: ['contact_email', 'email', 'e-posta', 'eposta', 'e_posta', 'mail', 'email address', 'work email'],
        required: false,
    },
    'contacts.phone_e164': {
        table: 'contacts',
        field: 'phone_e164',
        aliases: ['contact_phone', 'telefon', 'phone', 'tel', 'cep', 'cep telefonu', 'mobile', 'phone number', 'mobile phone'],
        required: false,
    },
    'contacts.country': {
        table: 'contacts',
        field: 'country',
        aliases: ['country', 'ülke', 'ulke', 'location', 'konum'],
        required: false,
    },
    'contacts.seniority': {
        table: 'contacts',
        field: 'seniority',
        aliases: ['seniority', 'kıdem', 'kidem', 'seviye', 'level', 'seniority level'],
        required: false,
    },
    'contacts.department': {
        table: 'contacts',
        field: 'department',
        aliases: ['department', 'departman', 'bölüm', 'bolum', 'team', 'takım', 'takim'],
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
 * Simple string similarity (Dice coefficient)
 */
function similarity(a: string, b: string): number {
    const na = normalize(a);
    const nb = normalize(b);

    if (na === nb) return 1;
    if (na.length < 2 || nb.length < 2) return 0;

    // Check if one contains the other
    if (na.includes(nb) || nb.includes(na)) return 0.8;

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
    for (const b of bigramsB) {
        if (bigramsA.has(b)) matches++;
    }

    return (2 * matches) / (bigramsA.size + bigramsB.size);
}

/**
 * Auto-match file headers to DB fields
 */
export function autoMapHeaders(fileHeaders: string[]): MappingSuggestion[] {
    const usedDbFields = new Set<string>();
    const suggestions: MappingSuggestion[] = [];

    // First pass: exact and high-confidence matches
    for (const header of fileHeaders) {
        let bestMatch: { key: string; score: number } | null = null;

        // Strip 'people_' prefix when matching so merged headers like 'people_email'
        // correctly map to contacts.email instead of remaining unmapped
        const effectiveHeader = header.startsWith('people_') ? header.slice(7) : header;

        for (const [key, fieldDef] of Object.entries(FIELD_ALIASES)) {
            if (usedDbFields.has(key)) continue;

            for (const alias of fieldDef.aliases) {
                const score = Math.max(similarity(header, alias), similarity(effectiveHeader, alias));
                if (score > (bestMatch?.score || 0)) {
                    bestMatch = { key, score };
                }
            }
        }

        if (bestMatch && bestMatch.score >= 0.6) {
            const fieldDef = FIELD_ALIASES[bestMatch.key];
            usedDbFields.add(bestMatch.key);
            suggestions.push({
                fileHeader: header,
                dbField: bestMatch.key,
                table: fieldDef.table,
                field: fieldDef.field,
                confidence: bestMatch.score,
                required: fieldDef.required,
            });
        } else {
            suggestions.push({
                fileHeader: header,
                dbField: null,
                table: null,
                field: null,
                confidence: 0,
                required: false,
            });
        }
    }

    return suggestions;
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
