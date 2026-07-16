/** Faz 5 — shared types/helpers for the LinkedIn campaign UI (kept out of component files
 *  so react-refresh sees pure-component modules). */

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface LinkedInCampaign {
    id: string;
    name: string;
    status: CampaignStatus;
    sender_account_ids: string[];
    settings: Record<string, unknown>;
    dry_run: boolean;
    created_at: string;
}

export interface AccountOption { id: string; name: string | null; public_id: string | null; status: string }

export const CAMPAIGN_STATUS_COLOR: Record<CampaignStatus, string> = {
    draft: 'gray', active: 'green', paused: 'yellow', archived: 'dark',
};

export function accountLabel(a: AccountOption): string {
    return a.name ?? a.public_id ?? a.id.slice(0, 8);
}

/** Heuristic: does this cell look like a web URL (scheme, www., or bare host.tld[/…])? */
function isUrlShaped(v: string): boolean {
    return /^https?:\/\//i.test(v) || /^([a-z0-9-]+\.)+[a-z]{2,}(\/|\?|#|$)/i.test(v);
}
/**
 * Extract the profile slug from a URL-shaped value, host-anchored so lookalike hosts
 * (notlinkedin.com/in/x, evil.test/linkedin.com/in/x) are rejected. Returns null when the value
 * is not a linkedin.com (or *.linkedin.com) `/in/<slug>` URL or the slug's percent-encoding is malformed.
 */
function linkedInSlugFromUrl(v: string): string | null {
    let url: URL;
    try {
        url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); // scheme-less pastes still parse
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
    const segs = url.pathname.split('/').filter(Boolean);
    if (segs[0] !== 'in' || !segs[1]) return null;
    try {
        return decodeURIComponent(segs[1]);
    } catch {
        return null; // malformed percent-encoding
    }
}
/**
 * Turn a single identity cell (profile URL / public id / URN) into the wire id fields.
 * Returns null when empty OR when the cell is URL-shaped but NOT a supported LinkedIn profile
 * URL (a generic website, a lookalike host…) — such a value must not become a garbage public_id.
 * Used by both the CSV import and the paste tab (parseLeadLine), so they behave identically.
 */
export function identityFields(idPart: string): { public_id?: string; profile_urn?: string } | null {
    const v = idPart.trim();
    if (!v) return null;
    if (v.toLowerCase().startsWith('urn:li:')) return { profile_urn: v };
    if (isUrlShaped(v)) {
        const slug = linkedInSlugFromUrl(v);
        return slug ? { public_id: slug } : null;
    }
    return { public_id: v }; // bare slug / public id — unchanged
}

/** One lead per line: profile URL / public id / URN — optionally `, First, Last, Company, Title`. */
export function parseLeadLine(line: string): Record<string, string> | null {
    const parts = line.split(',').map((s) => s.trim());
    const idf = identityFields(parts[0] ?? '');
    if (!idf) return null;
    const lead: Record<string, string> = { ...idf };
    if (parts[1]) lead.first_name = parts[1];
    if (parts[2]) lead.last_name = parts[2];
    if (parts[3]) lead.company = parts[3];
    if (parts[4]) lead.title = parts[4];
    return lead;
}

/**
 * Compact RFC 4180 CSV parser: honours quoted fields (commas + newlines inside quotes),
 * doubled `""` escaped quotes, and CRLF/LF line endings. Returns rows of raw string cells.
 */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0; // strip a leading BOM
    const n = text.length;
    while (i < n) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
                inQuotes = false; i++; continue;
            }
            field += c; i++; continue; // newlines/commas are literal inside quotes
        }
        if (c === '"') { inQuotes = true; i++; continue; }
        if (c === ',') { row.push(field); field = ''; i++; continue; }
        if (c === '\r') { i++; continue; } // fold CRLF — the \n ends the row
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
        field += c; i++;
    }
    // Flush the final field/row unless the file ended cleanly on a newline.
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
}

/** Header synonyms (case-, space/underscore- and diacritic-insensitive) for the non-identity fields. */
const CSV_SYNONYMS: Record<'first_name' | 'last_name' | 'company' | 'title', string[]> = {
    first_name: ['firstname', 'first', 'ad', 'adi', 'isim'],
    last_name: ['lastname', 'last', 'soyad', 'soyadi'],
    company: ['company', 'companyname', 'sirket', 'firma'],
    title: ['title', 'unvan', 'unvani', 'pozisyon', 'position'],
};
/**
 * Identity headers ranked strongest→weakest so an explicit LinkedIn column always wins over a
 * generic `URL`/`profile` (which is often a company website). Within a tier the first column wins.
 */
const IDENTITY_TIERS: string[][] = [
    ['linkedinurl', 'linkedinprofile', 'linkedinprofileurl', 'linkedinprofil', 'profillinki', 'linkedin'],
    ['publicid'],
    ['urn'],
    ['url', 'profileurl', 'profile', 'profil'],
];
/** Lowercase + fold Turkish diacritics (ı/İ→i, ş→s, ç→c, ö→o, ü→u, ğ→g) + strip spaces/underscores. */
function normHeader(h: string): string {
    return h
        .replace(/[İıI]/g, 'i')
        .replace(/[şŞ]/g, 's')
        .replace(/[çÇ]/g, 'c')
        .replace(/[öÖ]/g, 'o')
        .replace(/[üÜ]/g, 'u')
        .replace(/[ğĞ]/g, 'g')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // drop any residual combining marks
        .replace(/[\s_]+/g, '')
        .trim();
}
export interface CsvColumnMap {
    /** Strongest identity column (used for the preview); -1 when the CSV lacks one. */
    identity: number;
    /** ALL identity columns in tier-strength order — rows fall back down this list. */
    identityCandidates: number[];
    first_name: number; last_name: number; company: number; title: number;
}
/** Discriminated CSV-row outcome so the UI can count identity rejections separately. */
export type CsvRowResult =
    | { lead: Record<string, string> }
    | { skip: 'empty' | 'invalid_identity' };
/** Auto-detect the column index for each field; -1 when the CSV lacks that column. */
export function mapCsvHeaders(headers: string[]): CsvColumnMap {
    const norm = headers.map(normHeader);
    const find = (syns: string[]) => norm.findIndex((h) => syns.includes(h));
    // Every identity-looking column, strongest tier first (column order within a tier).
    const identityCandidates: number[] = [];
    for (const tier of IDENTITY_TIERS) {
        norm.forEach((h, idx) => { if (tier.includes(h) && !identityCandidates.includes(idx)) identityCandidates.push(idx); });
    }
    return {
        identity: identityCandidates[0] ?? -1,
        identityCandidates,
        first_name: find(CSV_SYNONYMS.first_name),
        last_name: find(CSV_SYNONYMS.last_name),
        company: find(CSV_SYNONYMS.company),
        title: find(CSV_SYNONYMS.title),
    };
}
/**
 * Build a lead wire object from a parsed CSV row. The identity is resolved PER ROW: the strongest
 * candidate column is tried first, falling back down the tiers until one cell yields a usable
 * identity — so a row with an empty `LinkedIn URL` but a valid `public_id` still imports.
 * Returns `{ skip: 'empty' }` when every candidate cell is blank and `{ skip: 'invalid_identity' }`
 * when at least one cell had a value but none was usable (e.g. only a company-website URL).
 */
export function csvRowToLead(row: string[], map: CsvColumnMap): CsvRowResult {
    let sawValue = false;
    let idf: { public_id?: string; profile_urn?: string } | null = null;
    for (const idx of map.identityCandidates) {
        const cell = (row[idx] ?? '').trim();
        if (!cell) continue;
        sawValue = true;
        idf = identityFields(cell);
        if (idf) break;
    }
    if (!idf) return { skip: sawValue ? 'invalid_identity' : 'empty' };
    const lead: Record<string, string> = { ...idf };
    const set = (idx: number, key: string) => { if (idx >= 0) { const v = (row[idx] ?? '').trim(); if (v) lead[key] = v; } };
    set(map.first_name, 'first_name');
    set(map.last_name, 'last_name');
    set(map.company, 'company');
    set(map.title, 'title');
    return { lead };
}
