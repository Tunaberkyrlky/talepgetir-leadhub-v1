import { supabaseAdmin } from './supabase.js';
import { createLogger } from './logger.js';

const log = createLogger('emailMatcher');

// ─── Match method taxonomy ───────────────────────────────────────────────
// Lower rank = stronger / more trustworthy match.
// Rank order is consumed by the backfill script to decide whether a new
// match should overwrite an existing one.
export type MatchMethod =
    | 'manual'
    | 'contact_email_exact'
    | 'company_email_exact'
    | 'website_domain_exact'
    | 'company_name_exact'
    | 'plusvibe_website_exact'
    | 'plusvibe_name_exact'
    | 'fuzzy_substring'
    | 'unmatched';

export const MATCH_METHOD_RANK: Record<MatchMethod, number> = {
    manual: 0,
    contact_email_exact: 1,
    company_email_exact: 2,
    website_domain_exact: 3,
    company_name_exact: 4,
    plusvibe_website_exact: 5,
    plusvibe_name_exact: 6,
    fuzzy_substring: 7,
    unmatched: 99,
};

/** Treat legacy rows (match_method NULL) as if they came from the loosest layer,
 *  so any exact-layer hit will overwrite them during backfill. */
export const LEGACY_RANK = MATCH_METHOD_RANK.fuzzy_substring;

export interface MatchResult {
    tenant_id: string;
    company_id: string | null;
    contact_id: string | null;
    match_status: 'matched' | 'unmatched';
    match_method: MatchMethod;
}

// ─── Company cache for domain matching ───────────────────────────────────
interface CachedCompanyRow {
    id: string;
    tenant_id: string;
    name: string | null;
    normalizedName: string | null;
    websiteLabels: string[];
}
interface CompanyCacheEntry { data: CachedCompanyRow[]; ts: number }
const companyCache = new Map<string, CompanyCacheEntry>();
const COMPANY_CACHE_TTL = 60_000;
const PAGE_SIZE = 1000;

async function fetchAllCompanies(tenantId: string): Promise<CachedCompanyRow[]> {
    const cached = companyCache.get(tenantId);
    if (cached && Date.now() - cached.ts < COMPANY_CACHE_TTL) return cached.data;

    const all: CachedCompanyRow[] = [];
    let from = 0;
    while (true) {
        const { data, error } = await supabaseAdmin
            .from('companies')
            .select('id, tenant_id, name, website')
            .eq('tenant_id', tenantId)
            .range(from, from + PAGE_SIZE - 1);

        if (error) {
            log.warn({ err: error, tenantId, from }, 'Paginated company fetch failed');
            break;
        }
        if (!data || data.length === 0) break;
        for (const row of data) {
            const normalizedName = normalizeName(row.name);
            all.push({
                id: row.id,
                tenant_id: row.tenant_id,
                name: row.name,
                normalizedName: normalizedName && normalizedName.length >= 4 ? normalizedName : null,
                websiteLabels: row.website ? extractWebsiteLabels(row.website) : [],
            });
        }
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }

    companyCache.set(tenantId, { data: all, ts: Date.now() });
    log.info({ tenantId, count: all.length }, 'Company cache refreshed for domain matching');
    return all;
}

export function clearCompanyCache(tenantId?: string): void {
    if (tenantId) companyCache.delete(tenantId);
    else companyCache.clear();
}

// ─── Normalization helpers (shared between matcher & search) ─────────────

export function normalizeName(s: string | null | undefined): string | null {
    if (!s) return null;
    const n = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return n.length > 0 ? n : null;
}

const PERSONAL_DOMAINS = new Set([
    'gmail', 'googlemail', 'hotmail', 'yahoo', 'ymail', 'outlook', 'live',
    'msn', 'icloud', 'me', 'mac', 'aol', 'protonmail', 'proton', 'yandex',
    'mail', 'gmx', 'web', 'inbox', 'zoho', 'fastmail', 'hey', 'pm',
    'tutanota', 'tuta', 'startmail', 'hushmail', 'mailfence', 'runbox',
]);

/** SaaS hosting providers — the apex of `acme.zendesk.com` is "zendesk.com",
 *  but the real company is "Acme", not Zendesk. We must not treat the apex
 *  as a company-identifying domain. Subdomain labels (e.g. "acme") may still
 *  be useful for name matching. */
const SAAS_HOSTS = new Set([
    // CRM / Ticketing
    'zendesk', 'freshdesk', 'hubspot', 'intercom', 'helpscout',
    // E-commerce / Site builders
    'shopify', 'wix', 'squarespace', 'webflow', 'wordpress',
    // ERP / Business apps
    'odoo', 'salesforce', 'dynamics',
    // Productivity / docs / blog
    'notion', 'medium', 'gitbook', 'substack',
    // Code / dev
    'github', 'gitlab', 'bitbucket',
    // Forms / scheduling
    'typeform', 'calendly', 'hopin',
    // Email / marketing
    'mailchimp', 'sendgrid', 'mailgun', 'klaviyo',
]);

const TLDS = new Set([
    'com', 'org', 'net', 'edu', 'gov', 'io', 'co', 'info', 'biz', 'me', 'tv', 'app', 'dev',
    'nl', 'de', 'uk', 'fr', 'es', 'it', 'be', 'at', 'ch', 'se', 'no', 'dk', 'fi', 'pl',
    'pt', 'cz', 'sk', 'ro', 'hu', 'bg', 'hr', 'si', 'rs', 'ba', 'mk', 'al', 'gr', 'tr',
    'ru', 'ua', 'lt', 'lv', 'ee', 'ie', 'lu', 'mt', 'cy', 'is', 'li', 'mc', 'ad', 'sm',
    'us', 'ca', 'mx', 'br', 'ar', 'cl', 'pe', 'ec', 'uy', 'py', 'bo', 've',
    'au', 'nz', 'jp', 'cn', 'kr', 'in', 'sg', 'hk', 'tw', 'th', 'vn', 'id', 'my', 'ph',
    'za', 'ng', 'ke', 'eg', 'ma', 'ae', 'sa', 'il', 'qa', 'kw', 'om', 'bh',
]);

/** Strip protocol/www and return lowercased hostname. Empty string if not parseable. */
function extractHostname(input: string): string {
    try {
        const url = input.startsWith('http') ? input : `https://${input}`;
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return input.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    }
}

/** Apex / registrable-ish domain for exact comparison.
 *  Handles common 2-part TLDs (.co.uk, .com.tr, .com.au, etc.) heuristically. */
export function extractApexDomain(input: string): string | null {
    const host = extractHostname(input);
    if (!host) return null;
    const parts = host.split('.').filter(Boolean);
    if (parts.length < 2) return null;

    // Known 2-part suffixes
    const twoPartSuffixes = new Set([
        'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk',
        'com.tr', 'org.tr', 'gov.tr', 'edu.tr', 'net.tr',
        'com.au', 'net.au', 'org.au',
        'co.nz', 'co.jp', 'co.kr', 'co.za', 'co.in',
        'com.br', 'com.mx', 'com.ar', 'com.sg', 'com.hk',
    ]);
    if (parts.length >= 3) {
        const last2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
        if (twoPartSuffixes.has(last2)) {
            return `${parts[parts.length - 3]}.${last2}`;
        }
    }
    return parts.slice(-2).join('.');
}

/** Domain part of an email address ("info@foo.com" → "foo.com"), lowercased.
 *  Returns null for personal providers and SaaS hosts (acme.zendesk.com → null,
 *  not zendesk.com — apex doesn't identify the customer). */
export function extractEmailDomain(email: string): string | null {
    const atIdx = email.lastIndexOf('@');
    if (atIdx === -1) return null;
    const apex = extractApexDomain(email.slice(atIdx + 1));
    if (!apex) return null;
    const firstLabel = apex.split('.')[0];
    if (PERSONAL_DOMAINS.has(firstLabel)) return null;
    if (SAAS_HOSTS.has(firstLabel)) return null;
    return apex;
}

/** Domain labels extracted from email's hostname (supports subdomains).
 *  SaaS host labels are stripped (acme.zendesk.com → ['acme']).
 *  Returns empty array if any label is a personal provider. */
function extractDomainLabels(email: string): string[] {
    const atIdx = email.lastIndexOf('@');
    if (atIdx === -1) return [];
    const afterAt = email.slice(atIdx + 1).toLowerCase();
    const parts = afterAt.split('.');
    const labels = parts.filter(p => p.length >= 3 && !TLDS.has(p) && !SAAS_HOSTS.has(p));
    if (labels.some(l => PERSONAL_DOMAINS.has(l))) return [];
    return labels;
}

function extractWebsiteLabels(website: string): string[] {
    const host = extractHostname(website);
    if (!host) return [];
    return host.split('.').filter(p => p.length >= 3 && !TLDS.has(p) && !SAAS_HOSTS.has(p));
}

export interface MatchHints {
    company_name?: string | null;
    company_website?: string | null;
}

const ENABLE_FUZZY_FALLBACK = process.env.EMAIL_MATCHER_ENABLE_FUZZY === 'true';

// ─── Layered matcher ──────────────────────────────────────────────────────
// Each layer returns a MatchResult (matched) or null (no hit → fall through).
// Layers are evaluated in order; the FIRST hit wins.
// Ambiguity within a layer (2+ candidates that can't be tie-broken) → null,
// letting weaker layers try. Never silently picks an arbitrary winner.

interface LayerCtx {
    senderEmail: string;
    tenantId: string;
    hints?: MatchHints;
}

async function layerContactEmailExact(ctx: LayerCtx): Promise<MatchResult | null> {
    const { data, error } = await supabaseAdmin
        .from('contacts')
        .select('id, company_id, tenant_id, is_primary, updated_at')
        .eq('email', ctx.senderEmail)
        .eq('tenant_id', ctx.tenantId)
        .order('is_primary', { ascending: false })
        .order('updated_at', { ascending: false })
        .limit(1);

    if (error) {
        log.error({ err: error, email: ctx.senderEmail }, 'Contact lookup failed');
        throw new Error(`Contact lookup failed: ${error.message}`);
    }
    if (!data || data.length === 0) return null;

    const contact = data[0];
    return {
        tenant_id: contact.tenant_id,
        company_id: contact.company_id,
        contact_id: contact.id,
        match_status: 'matched',
        match_method: 'contact_email_exact',
    };
}

async function layerCompanyEmailExact(ctx: LayerCtx): Promise<MatchResult | null> {
    const { data, error } = await supabaseAdmin
        .from('companies')
        .select('id, tenant_id, updated_at')
        .eq('company_email', ctx.senderEmail)
        .eq('tenant_id', ctx.tenantId)
        .order('updated_at', { ascending: false })
        .limit(1);

    if (error) {
        log.error({ err: error, email: ctx.senderEmail }, 'Company email lookup failed');
        throw new Error(`Company lookup failed: ${error.message}`);
    }
    if (!data || data.length === 0) return null;

    return {
        tenant_id: data[0].tenant_id,
        company_id: data[0].id,
        contact_id: null,
        match_status: 'matched',
        match_method: 'company_email_exact',
    };
}

/** Exact apex-domain equality between sender email domain and company website. */
async function layerWebsiteDomainExact(ctx: LayerCtx): Promise<MatchResult | null> {
    const senderApex = extractEmailDomain(ctx.senderEmail);
    if (!senderApex) return null;
    return await queryCompanyByWebsiteApex(ctx.tenantId, senderApex, 'website_domain_exact');
}

async function queryCompanyByWebsiteApex(
    tenantId: string,
    apex: string,
    method: MatchMethod,
): Promise<MatchResult | null> {
    // Defense-in-depth: never resolve a SaaS host apex to a customer company.
    const firstLabel = apex.split('.')[0];
    if (SAAS_HOSTS.has(firstLabel)) return null;

    // Match common stored forms: "apex", "www.apex", "https://apex", "https://www.apex/..." etc.
    // We use ILIKE patterns; apex is alphanumeric + dots so it's safe to interpolate.
    const safeApex = apex.replace(/[%_\\]/g, ''); // strip wildcards just in case

    const { data, error } = await supabaseAdmin
        .from('companies')
        .select('id, tenant_id, website, updated_at')
        .eq('tenant_id', tenantId)
        .not('website', 'is', null)
        .or(
            `website.ilike.${safeApex},` +
            `website.ilike.www.${safeApex},` +
            `website.ilike.%//${safeApex},` +
            `website.ilike.%//${safeApex}/%,` +
            `website.ilike.%//www.${safeApex},` +
            `website.ilike.%//www.${safeApex}/%,` +
            `website.ilike.${safeApex}/%,` +
            `website.ilike.www.${safeApex}/%`
        )
        .order('updated_at', { ascending: false })
        .limit(5);

    if (error) {
        log.warn({ err: error, apex }, 'Website apex query failed');
        return null;
    }
    if (!data || data.length === 0) return null;

    // Verify each candidate's actual apex matches (ILIKE is a coarse filter).
    const verified = data.filter(c => extractApexDomain(c.website || '') === apex);
    if (verified.length === 0) return null;

    if (verified.length > 1) {
        log.info({ apex, count: verified.length, ids: verified.map(c => c.id) },
            'Multiple companies share website apex; using most recently updated');
    }

    return {
        tenant_id: verified[0].tenant_id,
        company_id: verified[0].id,
        contact_id: null,
        match_status: 'matched',
        match_method: method,
    };
}

/** Exact (normalized) equality between any sender domain label and a company name. */
async function layerCompanyNameExact(ctx: LayerCtx): Promise<MatchResult | null> {
    const labels = extractDomainLabels(ctx.senderEmail);
    if (labels.length === 0) return null;
    const normalizedLabels = labels.map(l => l.replace(/[^a-z0-9]/g, '')).filter(l => l.length >= 4);
    if (normalizedLabels.length === 0) return null;

    const all = await fetchAllCompanies(ctx.tenantId);
    const labelSet = new Set(normalizedLabels);

    const hits = all.filter(c => c.normalizedName && labelSet.has(c.normalizedName));
    if (hits.length === 0) return null;

    // Tie-break: prefer the longest normalized name (most specific).
    hits.sort((a, b) => (b.normalizedName?.length ?? 0) - (a.normalizedName?.length ?? 0));

    if (hits.length > 1 && hits[0].normalizedName?.length === hits[1].normalizedName?.length) {
        // Genuine ambiguity — refuse rather than guess.
        log.info({ email: ctx.senderEmail, candidates: hits.map(c => c.id) },
            'Ambiguous company_name_exact match; falling through');
        return null;
    }

    return {
        tenant_id: hits[0].tenant_id,
        company_id: hits[0].id,
        contact_id: null,
        match_status: 'matched',
        match_method: 'company_name_exact',
    };
}

async function layerPlusvibeWebsiteExact(ctx: LayerCtx): Promise<MatchResult | null> {
    if (!ctx.hints?.company_website) return null;
    const apex = extractApexDomain(ctx.hints.company_website);
    if (!apex) return null;
    return await queryCompanyByWebsiteApex(ctx.tenantId, apex, 'plusvibe_website_exact');
}

async function layerPlusvibeNameExact(ctx: LayerCtx): Promise<MatchResult | null> {
    if (!ctx.hints?.company_name) return null;
    const normalizedHint = normalizeName(ctx.hints.company_name);
    if (!normalizedHint || normalizedHint.length < 4) return null;

    const all = await fetchAllCompanies(ctx.tenantId);
    const hits = all.filter(c => c.normalizedName === normalizedHint);
    if (hits.length === 0) return null;

    if (hits.length > 1) {
        log.info({ hint: ctx.hints.company_name, candidates: hits.map(c => c.id) },
            'Ambiguous plusvibe_name_exact match; falling through');
        return null;
    }

    return {
        tenant_id: hits[0].tenant_id,
        company_id: hits[0].id,
        contact_id: null,
        match_status: 'matched',
        match_method: 'plusvibe_name_exact',
    };
}

/** Last-resort bidirectional substring (legacy behavior). Off by default. */
async function layerFuzzySubstring(ctx: LayerCtx): Promise<MatchResult | null> {
    if (!ENABLE_FUZZY_FALLBACK) return null;

    const labels = extractDomainLabels(ctx.senderEmail);
    if (labels.length === 0) return null;
    const normalizedLabels = labels.map(l => l.replace(/[^a-z0-9]/g, '')).filter(l => l.length >= 6);
    if (normalizedLabels.length === 0) return null;

    const all = await fetchAllCompanies(ctx.tenantId);
    let best: CachedCompanyRow | null = null;
    let bestScore = 0;

    for (const c of all) {
        if (!c.normalizedName || c.normalizedName.length < 6) continue;
        for (const nd of normalizedLabels) {
            const matched = nd.includes(c.normalizedName) || c.normalizedName.includes(nd);
            if (matched && c.normalizedName.length > bestScore) {
                bestScore = c.normalizedName.length;
                best = c;
            }
        }
    }
    if (!best) return null;

    return {
        tenant_id: best.tenant_id,
        company_id: best.id,
        contact_id: null,
        match_status: 'matched',
        match_method: 'fuzzy_substring',
    };
}

/**
 * Match a sender email to a contact or company within the given tenant.
 *
 * Layers run in confidence order (highest first). The FIRST layer that
 * returns a unique match wins. Ambiguity within a layer falls through to
 * weaker layers rather than picking an arbitrary candidate.
 *
 * Layers:
 *   1. contact_email_exact     — contacts.email == sender
 *   2. company_email_exact     — companies.company_email == sender
 *   3. website_domain_exact    — apex(sender) == apex(companies.website)
 *   4. company_name_exact      — normalize(domain_label) == normalize(companies.name)
 *   5. plusvibe_website_exact  — apex(hints.company_website) == apex(companies.website)
 *   6. plusvibe_name_exact     — normalize(hints.company_name) == normalize(companies.name)
 *   7. fuzzy_substring         — bidirectional substring (legacy; off by default,
 *                                set EMAIL_MATCHER_ENABLE_FUZZY=true to enable)
 */
export async function matchSenderEmail(
    senderEmail: string,
    defaultTenantId: string,
    hints?: MatchHints,
): Promise<MatchResult> {
    const ctx: LayerCtx = {
        senderEmail: senderEmail.toLowerCase().trim(),
        tenantId: defaultTenantId,
        hints,
    };

    const layers: Array<(c: LayerCtx) => Promise<MatchResult | null>> = [
        layerContactEmailExact,
        layerCompanyEmailExact,
        layerWebsiteDomainExact,
        layerCompanyNameExact,
        layerPlusvibeWebsiteExact,
        layerPlusvibeNameExact,
        layerFuzzySubstring,
    ];

    for (const layer of layers) {
        const r = await layer(ctx);
        if (r) {
            log.info(
                { email: ctx.senderEmail, method: r.match_method, company_id: r.company_id, contact_id: r.contact_id },
                'Sender matched',
            );
            return r;
        }
    }

    log.info({ email: ctx.senderEmail }, 'No match found across all layers');
    return {
        tenant_id: defaultTenantId,
        company_id: null,
        contact_id: null,
        match_status: 'unmatched',
        match_method: 'unmatched',
    };
}

const EARLY_STAGES = ['cold', 'in_queue', 'first_contact'];

export async function advanceCompanyStageOnMatch(companyId: string): Promise<void> {
    const { data: company } = await supabaseAdmin
        .from('companies')
        .select('stage')
        .eq('id', companyId)
        .single();

    if (!company || !EARLY_STAGES.includes(company.stage)) return;

    const { error } = await supabaseAdmin
        .from('companies')
        .update({ stage: 'connected', stage_changed_at: new Date().toISOString() })
        .eq('id', companyId);

    if (error) {
        log.warn({ err: error, companyId }, 'Failed to auto-advance company stage');
    } else {
        log.info({ companyId, from: company.stage, to: 'connected' }, 'Company stage auto-advanced via email reply match');
    }
}
