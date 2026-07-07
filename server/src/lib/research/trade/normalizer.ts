/**
 * Y2 trade CSV normalizer.
 *
 * Supports both the compact customer template (company, HS code, amount, website,
 * country, contact) and raw customs exports with repeated/misaligned columns. The
 * content classifiers are a TypeScript port of v1/ticaret-veri-temizleme/duzenle.py.
 */
import Papa from 'papaparse';

const MAX_ROWS = 25_000;
const NULLISH = new Set([
    '', '-', 'N/A', 'NA', 'UNKNOWN', 'NULL', 'NONE', 'NOT AVAILABLE', 'NOT STATED',
    'SE DESCONOCE', 'DESCONOCIDO', 'DESCONHECIDO', 'NO DISPONIBLE', 'NAO DISPONIVEL',
    'SIN DATOS', 'SIN INFORMACION', 'TO ORDER', 'ORDER',
]);

const LEGAL_NAME = /\b(INC|LLC|L\.?L\.?C|LTD|LTDA|CORP|CO\s*LTD|S\s*\.?\s*A|S\s*\.?\s*R\s*\.?\s*L|SRL|SAC|SAS|EIRL|SA\s+DE\s+CV|CIA|COMPANY|GMBH|B\.?V|AG|PVT|LIMITED|SOCIEDAD|ANONIMA|INDUSTRIA|COMERCIO|COMERCIAL|TRADING|GROUP|ENTERPRISE)\b/i;
const PRODUCT_WORDS = /\b(RAW|HIDE|HIDES|SKIN|SKINS|BOVINE|CATTLE|WET|SALTED|FRESH|PIEL|PIELES|CUERO|CUEROS|FREIGHT|SHIPPER|HTS|HS\s*COMMODITY|KILOGRAM|PACKAGE|PIECE|CONTAINER|PALLET|INVOICE|CONTRACT|COMMODITY)\b/gi;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WEBSITE_RE = /^(?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}(?:[/?#].*)?$/i;
const PHONE_RE = /^\+?[\d\s()./-]{7,24}$/;
const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRY_ALIASES: Record<string, string> = {
    turkey: 'TR', turkiye: 'TR',
    usa: 'US', 'u s a': 'US', 'united states of america': 'US',
    uk: 'GB', 'u k': 'GB', britain: 'GB', 'great britain': 'GB',
    uae: 'AE', 'u a e': 'AE',
    russia: 'RU', 'south korea': 'KR', 'north korea': 'KP',
    vietnam: 'VN', 'czech republic': 'CZ', 'ivory coast': 'CI',
};
const COUNTRY_CODES_BY_NAME = (() => {
    const map = new Map<string, string>();
    for (let first = 65; first <= 90; first++) {
        for (let second = 65; second <= 90; second++) {
            const code = String.fromCharCode(first, second);
            const name = REGION_NAMES.of(code);
            if (name && name !== code && name !== 'Unknown Region') map.set(asciiFold(name), code);
        }
    }
    return map;
})();

const ALIASES = {
    company: ['company name', 'company', 'buyer', 'buyer name', 'importer', 'main importer', 'consignee', 'firma adi', 'firma', 'alici', 'ithalatci'],
    hs: ['hs code', 'hscode', 'hs codes', 'hs', 'gtip', 'tariff code', 'commodity code', 'ncm'],
    amount: ['export value', 'import value', 'trade value', 'total value', 'amount', 'value usd', 'usd value', 'tutar', 'alim tutari'],
    website: ['website', 'web site', 'company website', 'url', 'domain', 'websitesi'],
    country: ['buyer country', 'importer country', 'destination country', 'country', 'ulke', 'alici ulke'],
    summary: ['company summary', 'summary', 'description', 'product description', 'aciklama', 'firma ozeti'],
    email: ['email', 'e-mail', 'company email', 'mail', 'eposta'],
    phone: ['phone', 'telephone', 'mobile', 'tel', 'telefon'],
    currency: ['currency', 'para birimi', 'doviz'],
} as const;
const BUYER_COMPANY_HINTS = ['buyer', 'importer', 'consignee', 'main importer', 'alici', 'ithalatci'];
const GENERIC_COMPANY_HEADERS = new Set(['company name', 'company', 'firma adi', 'firma']);
const NON_COMPANY_HEADER = /\b(exporter|seller|shipper|supplier|manufacturer|origin|country|destination|address|email|mail|phone|telephone|tel|mobile|website|url|domain|hs|hscode|gtip|tariff|commodity|code|amount|value|currency|date|invoice|product|description|summary)\b/;

type FieldName = keyof typeof ALIASES;
type HeaderIndexes = Record<FieldName, number[]>;

export interface NormalizedTradeRow {
    rowNumber: number;
    companyName: string | null;
    hsCodes: string[];
    exportValue: number | null;
    website: string | null;
    country: string | null;
    summary: string | null;
    email: string | null;
    phone: string | null;
    currency: string;
    confidence: 'high' | 'medium' | 'low';
    needsReview: boolean;
    reviewReasons: string[];
    rejected: boolean;
    raw: Record<string, string | null>;
}

export interface TradeCsvResult {
    headers: string[];
    rows: NormalizedTradeRow[];
    totalRows: number;
    acceptedRows: number;
    reviewRows: number;
    rejectedRows: number;
}

function clean(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/^\uFEFF/, '').trim();
    return NULLISH.has(text.toUpperCase()) ? null : text;
}

function asciiFold(value: string): string {
    return value
        .toLowerCase()
        .replace(/ı/g, 'i')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function indexesFor(headers: string[], field: FieldName): number[] {
    const aliases = ALIASES[field];
    return headers
        .map((header, index) => ({ index, normalized: asciiFold(header) }))
        .filter(({ normalized }) => aliases.some((alias) => normalized === alias || normalized.includes(alias)))
        .map(({ index }) => index);
}

function companyIndexes(headers: string[]): number[] {
    const indexed = headers.map((header, index) => ({ index, normalized: asciiFold(header) }));
    const buyerSpecific = indexed
        .filter(({ normalized }) => BUYER_COMPANY_HINTS.some((hint) => normalized.includes(hint)) && !NON_COMPANY_HEADER.test(normalized))
        .map(({ index }) => index);
    if (buyerSpecific.length > 0) return buyerSpecific;

    return indexed
        .filter(({ normalized }) => GENERIC_COMPANY_HEADERS.has(normalized) || (normalized.includes('company') && !NON_COMPANY_HEADER.test(normalized)))
        .map(({ index }) => index);
}

function buildIndexes(headers: string[]): HeaderIndexes {
    const indexes = Object.fromEntries(
        (Object.keys(ALIASES) as FieldName[]).map((field) => [field, indexesFor(headers, field)]),
    ) as HeaderIndexes;
    // Customs exports often include both exporter/seller and importer/buyer companies. Prefer the
    // destination-side company; fall back to a generic customer-template company column only when absent.
    indexes.company = companyIndexes(headers);
    // A buyer's country is the destination side. Never silently treat export/origin country as
    // buyer country when the destination cell is absent; unknown is safer and reviewable.
    indexes.country = headers
        .map((header, index) => ({ index, normalized: asciiFold(header) }))
        .filter(({ normalized }) => [
            'buyer country', 'importer country', 'destination country', 'country', 'ulke', 'alici ulke',
        ].includes(normalized))
        .map(({ index }) => index);
    return indexes;
}

function valueAt(row: string[], index: number | undefined): string | null {
    return index === undefined ? null : clean(row[index]);
}

function firstValue(row: string[], indexes: number[]): string | null {
    for (const index of indexes) {
        const value = valueAt(row, index);
        if (value) return value;
    }
    return null;
}

function looksLikeCompany(value: string): boolean {
    if (/^\d/.test(value) || EMAIL_RE.test(value) || WEBSITE_RE.test(value)) return false;
    const products = value.match(PRODUCT_WORDS)?.length ?? 0;
    if (products >= 2 && !LEGAL_NAME.test(value)) return false;
    return LEGAL_NAME.test(value) || (value.length >= 2 && value.length <= 140 && products === 0);
}

function companyFrom(row: string[], indexes: number[]): string | null {
    const candidates = indexes
        .map((index) => valueAt(row, index))
        .filter((value): value is string => !!value && looksLikeCompany(value));
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => Number(LEGAL_NAME.test(b)) - Number(LEGAL_NAME.test(a)) || a.length - b.length)[0];
}

function normalizeHsCodes(values: Array<string | null>): string[] {
    const codes = new Set<string>();
    for (const value of values) {
        if (!value) continue;
        const explicit = value.match(/\d[\d.\s-]{2,14}\d/g) ?? [];
        for (const candidate of explicit) {
            const digits = candidate.replace(/\D/g, '');
            if (digits.length >= 4 && digits.length <= 12) codes.add(digits);
        }
    }
    return [...codes];
}

function parseNumber(value: string | null): number | null {
    if (!value) return null;
    let raw = value.replace(/[^\d,.-]/g, '');
    if (!raw || !/\d/.test(raw)) return null;
    const comma = raw.lastIndexOf(',');
    const dot = raw.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
        const decimal = comma > dot ? ',' : '.';
        const thousands = decimal === ',' ? /\./g : /,/g;
        raw = raw.replace(thousands, '').replace(decimal, '.');
    } else if (comma >= 0) {
        const trailing = raw.length - comma - 1;
        raw = trailing > 0 && trailing <= 2 ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
    } else if (dot >= 0) {
        const trailing = raw.length - dot - 1;
        if (trailing === 3 && /^\d{1,3}(\.\d{3})+$/.test(raw)) raw = raw.replace(/\./g, '');
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeCountry(value: string | null): string | null {
    if (!value) return null;
    const folded = asciiFold(value);
    const explicitCode = /^[a-z]{2}$/i.test(value.trim()) ? value.trim().toUpperCase() : null;
    const code = explicitCode ?? COUNTRY_ALIASES[folded] ?? COUNTRY_CODES_BY_NAME.get(folded);
    return code ? (REGION_NAMES.of(code) ?? value.trim()) : value.trim();
}

function normalizeWebsite(value: string | null): string | null {
    if (!value) return null;
    const candidate = value.trim().replace(/[),.;]+$/, '');
    return WEBSITE_RE.test(candidate) ? candidate : null;
}

function findWebsite(row: string[], indexes: number[]): string | null {
    const preferred = normalizeWebsite(firstValue(row, indexes));
    if (preferred) return preferred;
    for (const cell of row) {
        const found = normalizeWebsite(clean(cell));
        if (found) return found;
    }
    return null;
}

function findPattern(row: string[], indexes: number[], pattern: RegExp): string | null {
    const preferred = firstValue(row, indexes);
    if (preferred && pattern.test(preferred)) return preferred;
    for (const cell of row) {
        const value = clean(cell);
        if (value && pattern.test(value)) return value;
    }
    return null;
}

function normalizeCurrency(explicit: string | null, amountRaw: string | null): string {
    const value = explicit?.trim().toUpperCase();
    if (value && /^[A-Z]{3}$/.test(value)) return value;
    if (amountRaw?.includes('€')) return 'EUR';
    if (amountRaw?.includes('£')) return 'GBP';
    if (amountRaw?.includes('₺')) return 'TRY';
    return 'USD';
}

function rawObject(headers: string[], row: string[]): Record<string, string | null> {
    const raw: Record<string, string | null> = {};
    headers.forEach((header, index) => {
        const base = clean(header) ?? `column_${index + 1}`;
        let key = base;
        let suffix = 2;
        while (key in raw) key = `${base}_${suffix++}`;
        raw[key] = clean(row[index]);
    });
    return raw;
}

function normalizeRow(headers: string[], indexes: HeaderIndexes, row: string[], rowNumber: number): NormalizedTradeRow {
    const companyName = companyFrom(row, indexes.company);
    const hsCodes = normalizeHsCodes(indexes.hs.map((index) => valueAt(row, index)));
    const amountRaw = firstValue(row, indexes.amount);
    const exportValue = parseNumber(amountRaw);
    const website = findWebsite(row, indexes.website);
    const country = normalizeCountry(firstValue(row, indexes.country));
    const descriptions = indexes.summary
        .map((index) => valueAt(row, index))
        .filter((value): value is string => !!value && !looksLikeCompany(value));
    const summary = descriptions.sort((a, b) => b.length - a.length)[0] ?? null;
    const email = findPattern(row, indexes.email, EMAIL_RE);
    const phone = findPattern(row, indexes.phone, PHONE_RE);
    const currency = normalizeCurrency(firstValue(row, indexes.currency), amountRaw);

    const reasons: string[] = [];
    if (!companyName) reasons.push('buyer company could not be identified');
    if (hsCodes.length === 0) reasons.push('HS/GTIP code is missing or invalid');
    if (!country) reasons.push('buyer country is missing');
    if (amountRaw && exportValue === null) reasons.push('trade amount is not numeric');

    const rejected = !companyName;
    const needsReview = reasons.length > 0;
    return {
        rowNumber,
        companyName,
        hsCodes,
        exportValue,
        website,
        country,
        summary,
        email,
        phone,
        currency,
        confidence: rejected ? 'low' : needsReview ? 'medium' : 'high',
        needsReview,
        reviewReasons: reasons,
        rejected,
        raw: rawObject(headers, row),
    };
}

export function normalizeTradeCsv(input: Buffer | string): TradeCsvResult {
    const content = Buffer.isBuffer(input) ? input.toString('utf8') : input;
    const parsed = Papa.parse<string[]>(content, {
        header: false,
        skipEmptyLines: 'greedy',
    });
    if (parsed.errors.length > 0) {
        throw new Error(`CSV parse failed: ${parsed.errors[0].message}`);
    }
    if (parsed.data.length < 2) throw new Error('CSV must contain a header and at least one data row');

    const headers = parsed.data[0].map((header, index) => clean(header) ?? `Column ${index + 1}`);
    const indexes = buildIndexes(headers);
    const sourceRows = parsed.data.slice(1);
    if (sourceRows.length > MAX_ROWS) throw new Error(`CSV has too many rows (max ${MAX_ROWS})`);

    const rows = sourceRows.map((row, index) => normalizeRow(headers, indexes, row, index + 2));
    return {
        headers,
        rows,
        totalRows: rows.length,
        acceptedRows: rows.filter((row) => !row.rejected).length,
        reviewRows: rows.filter((row) => !row.rejected && row.needsReview).length,
        rejectedRows: rows.filter((row) => row.rejected).length,
    };
}
