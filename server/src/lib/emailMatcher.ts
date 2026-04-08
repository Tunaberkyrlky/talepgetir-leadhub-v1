import { supabaseAdmin } from './supabase.js';
import { createLogger } from './logger.js';

const log = createLogger('emailMatcher');

export interface MatchResult {
    tenant_id: string;
    company_id: string | null;
    contact_id: string | null;
    match_status: 'matched' | 'unmatched';
}

// ─── Company cache for domain matching (avoids refetching on every email) ───
interface CachedCompanyRow {
    id: string;
    tenant_id: string;
    name: string | null;
    normalizedName: string | null;
    websiteLabels: string[];
}
interface CompanyCacheEntry { data: CachedCompanyRow[]; ts: number }
const companyCache = new Map<string, CompanyCacheEntry>();
const COMPANY_CACHE_TTL = 60_000; // 60s — fresh enough for matching batches

const PAGE_SIZE = 1000;

/** Score bonus when email domain exactly matches a company website domain */
const WEBSITE_MATCH_BONUS = 100;

/** Fetch all companies for a tenant with pagination + short TTL cache.
 *  Pre-computes normalizedName and websiteLabels to avoid per-email recalculation. */
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
            const normalizedName = row.name ? row.name.toLowerCase().replace(/[^a-z0-9]/g, '') : null;
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

/** Clear the company cache for a tenant (call after imports/deletes) */
export function clearCompanyCache(tenantId?: string): void {
    if (tenantId) companyCache.delete(tenantId);
    else companyCache.clear();
}

/** Personal/free email providers — skip domain label matching for these */
const PERSONAL_DOMAINS = new Set([
    'gmail', 'googlemail', 'hotmail', 'yahoo', 'ymail', 'outlook', 'live',
    'msn', 'icloud', 'me', 'mac', 'aol', 'protonmail', 'proton', 'yandex',
    'mail', 'gmx', 'web', 'inbox', 'zoho', 'fastmail', 'hey', 'pm',
    'tutanota', 'tuta', 'startmail', 'hushmail', 'mailfence', 'runbox',
]);

/** Known country-code and generic TLDs to strip when extracting domain labels */
const TLDS = new Set([
    'com', 'org', 'net', 'edu', 'gov', 'io', 'co', 'info', 'biz', 'me', 'tv', 'app', 'dev',
    // Country codes (2-letter)
    'nl', 'de', 'uk', 'fr', 'es', 'it', 'be', 'at', 'ch', 'se', 'no', 'dk', 'fi', 'pl',
    'pt', 'cz', 'sk', 'ro', 'hu', 'bg', 'hr', 'si', 'rs', 'ba', 'mk', 'al', 'gr', 'tr',
    'ru', 'ua', 'lt', 'lv', 'ee', 'ie', 'lu', 'mt', 'cy', 'is', 'li', 'mc', 'ad', 'sm',
    'us', 'ca', 'mx', 'br', 'ar', 'cl', 'pe', 'ec', 'uy', 'py', 'bo', 've',
    'au', 'nz', 'jp', 'cn', 'kr', 'in', 'sg', 'hk', 'tw', 'th', 'vn', 'id', 'my', 'ph',
    'za', 'ng', 'ke', 'eg', 'ma', 'ae', 'sa', 'il', 'qa', 'kw', 'om', 'bh',
]);

/**
 * Extract all meaningful domain labels from an email address.
 * Handles subdomains (e.g. klantenservice.trekpleister.nl → ['klantenservice', 'trekpleister'])
 * and multi-part TLDs (e.g. thewildfoods.com.mx → ['thewildfoods']).
 * Returns empty array for personal providers.
 */
function extractDomainLabels(email: string): string[] {
    const atIdx = email.lastIndexOf('@');
    if (atIdx === -1) return [];
    const afterAt = email.slice(atIdx + 1).toLowerCase();
    const parts = afterAt.split('.');

    // Filter out TLDs and short segments, keep meaningful labels
    const labels = parts.filter(p => p.length >= 3 && !TLDS.has(p));

    // Check if any label is a personal provider
    if (labels.some(l => PERSONAL_DOMAINS.has(l))) return [];

    return labels;
}

/** Extract meaningful labels from a website URL for domain matching */
function extractWebsiteLabels(website: string): string[] {
    try {
        const url = website.startsWith('http') ? website : `https://${website}`;
        const hostname = new URL(url).hostname.toLowerCase();
        const parts = hostname.replace(/^www\./, '').split('.');
        return parts.filter(p => p.length >= 3 && !TLDS.has(p));
    } catch {
        return [];
    }
}


/** Optional hints from PlusVibe webhook to improve matching when email-based matching fails */
export interface MatchHints {
    company_name?: string | null;
    company_website?: string | null;
}

/**
 * Match a sender email to a contact or company within the given tenant.
 *
 * Priority:
 * 1. contacts.email exact match → returns contact + company
 * 2. companies.company_email exact match → returns company only
 * 3. Domain label (between @ and first dot) matched against companies.name
 *    via ILIKE — also tries hyphens/underscores as spaces (best-effort)
 * 3b. PlusVibe hints fallback — match via company_name or company_website from webhook
 * 4. No match → unmatched
 */
export async function matchSenderEmail(
    senderEmail: string,
    defaultTenantId: string,
    hints?: MatchHints,
): Promise<MatchResult> {
    const email = senderEmail.toLowerCase().trim();

    // Step 1: Search contacts scoped to the tenant
    const { data: contacts, error: contactErr } = await supabaseAdmin
        .from('contacts')
        .select('id, company_id, tenant_id, is_primary, updated_at')
        .eq('email', email)
        .eq('tenant_id', defaultTenantId)
        .order('is_primary', { ascending: false })
        .order('updated_at', { ascending: false })
        .limit(1);

    if (contactErr) {
        log.error({ err: contactErr, email }, 'Contact lookup failed');
        throw new Error(`Contact lookup failed: ${contactErr.message}`);
    }

    if (contacts && contacts.length > 0) {
        const contact = contacts[0];
        log.info({ email, contact_id: contact.id, company_id: contact.company_id }, 'Matched via contact email');
        return {
            tenant_id: contact.tenant_id,
            company_id: contact.company_id,
            contact_id: contact.id,
            match_status: 'matched',
        };
    }

    // Step 2: Search companies scoped to the tenant by company_email
    const { data: companies, error: companyErr } = await supabaseAdmin
        .from('companies')
        .select('id, tenant_id, updated_at')
        .eq('company_email', email)
        .eq('tenant_id', defaultTenantId)
        .order('updated_at', { ascending: false })
        .limit(1);

    if (companyErr) {
        log.error({ err: companyErr, email }, 'Company lookup failed');
        throw new Error(`Company lookup failed: ${companyErr.message}`);
    }

    if (companies && companies.length > 0) {
        const company = companies[0];
        log.info({ email, company_id: company.id }, 'Matched via company email');
        return {
            tenant_id: company.tenant_id,
            company_id: company.id,
            contact_id: null,
            match_status: 'matched',
        };
    }

    // Step 3: Domain-based matching (best-effort)
    //
    // Strategy:
    // a) Extract all domain labels from email (supports subdomains)
    //    e.g. vragen@klantenservice.trekpleister.nl → ['klantenservice', 'trekpleister']
    // b) Try matching each label against company name (bidirectional substring)
    // c) Also try matching against company website domain
    // Prefer the longest matching company name to avoid false positives.
    const domainLabels = extractDomainLabels(email);
    if (domainLabels.length > 0) {
        const normalizedLabels = domainLabels.map(l => l.replace(/[^a-z0-9]/g, ''));

        const allCompanies = await fetchAllCompanies(defaultTenantId);

        if (allCompanies.length > 0) {
            let bestMatch: typeof allCompanies[0] | null = null;
            let bestScore = 0;

            for (const company of allCompanies) {
                // a) Match against company name (pre-computed)
                if (company.normalizedName) {
                    for (const nd of normalizedLabels) {
                        const matched =
                            nd.includes(company.normalizedName) ||
                            company.normalizedName.includes(nd);
                        if (matched && company.normalizedName.length > bestScore) {
                            bestScore = company.normalizedName.length;
                            bestMatch = company;
                        }
                    }
                }

                // b) Match against website domain (pre-computed)
                for (const wl of company.websiteLabels) {
                    for (const nd of normalizedLabels) {
                        if (nd === wl && wl.length >= 3) {
                            const score = wl.length + WEBSITE_MATCH_BONUS;
                            if (score > bestScore) {
                                bestScore = score;
                                bestMatch = company;
                            }
                        }
                    }
                }
            }

            if (bestMatch) {
                log.info({ email, company_id: bestMatch.id, domainLabels, company_name: bestMatch.name }, 'Matched via domain label (bidirectional)');
                return {
                    tenant_id: bestMatch.tenant_id,
                    company_id: bestMatch.id,
                    contact_id: null,
                    match_status: 'matched',
                };
            }
        }
    }

    // Step 3b: PlusVibe hints fallback (company_name / company_website)
    if (hints?.company_name || hints?.company_website) {
        const allCompanies = domainLabels.length > 0
            ? await fetchAllCompanies(defaultTenantId)  // already fetched above
            : await fetchAllCompanies(defaultTenantId);

        if (allCompanies.length > 0) {
            let hintMatch: typeof allCompanies[0] | null = null;
            let hintScore = 0;

            // Try matching by company_website from PlusVibe
            if (hints.company_website) {
                const hintWebsiteLabels = extractWebsiteLabels(hints.company_website);
                for (const company of allCompanies) {
                    for (const wl of company.websiteLabels) {
                        for (const hl of hintWebsiteLabels) {
                            if (hl === wl && wl.length >= 3) {
                                const score = wl.length + WEBSITE_MATCH_BONUS;
                                if (score > hintScore) {
                                    hintScore = score;
                                    hintMatch = company;
                                }
                            }
                        }
                    }
                }
            }

            // Try matching by company_name from PlusVibe
            if (!hintMatch && hints.company_name) {
                const normalizedHint = hints.company_name.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (normalizedHint.length >= 4) {
                    for (const company of allCompanies) {
                        if (company.normalizedName) {
                            const matched =
                                normalizedHint.includes(company.normalizedName) ||
                                company.normalizedName.includes(normalizedHint);
                            if (matched && company.normalizedName.length > hintScore) {
                                hintScore = company.normalizedName.length;
                                hintMatch = company;
                            }
                        }
                    }
                }
            }

            if (hintMatch) {
                log.info({ email, company_id: hintMatch.id, company_name: hintMatch.name, hint_source: hints.company_website ? 'website' : 'name' }, 'Matched via PlusVibe hints');
                return {
                    tenant_id: hintMatch.tenant_id,
                    company_id: hintMatch.id,
                    contact_id: null,
                    match_status: 'matched',
                };
            }
        }
    }

    // Step 4: No match
    log.info({ email }, 'No match found, using default tenant');
    return {
        tenant_id: defaultTenantId,
        company_id: null,
        contact_id: null,
        match_status: 'unmatched',
    };
}

const EARLY_STAGES = ['cold', 'in_queue', 'first_contact'];

/**
 * If the company is still in an early stage, advance it to 'connected'.
 * Call this whenever an email reply is successfully matched to a company.
 */
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
