import { supabaseAdmin } from './supabase.js';
import { createLogger } from './logger.js';

const log = createLogger('emailMatcher');

export interface MatchResult {
    tenant_id: string;
    company_id: string | null;
    contact_id: string | null;
    match_status: 'matched' | 'unmatched';
}

/** Personal/free email providers — skip domain label matching for these */
const PERSONAL_DOMAINS = new Set([
    'gmail', 'googlemail', 'hotmail', 'yahoo', 'ymail', 'outlook', 'live',
    'msn', 'icloud', 'me', 'mac', 'aol', 'protonmail', 'proton', 'yandex',
    'mail', 'gmx', 'web', 'inbox', 'zoho', 'fastmail', 'hey', 'pm',
    'tutanota', 'tuta', 'startmail', 'hushmail', 'mailfence', 'runbox',
]);

/**
 * Extract the label part of a domain (between @ and first dot).
 * Returns null for personal providers and labels shorter than 3 chars.
 * Examples:
 *   john@acmecorp.com      → 'acmecorp'
 *   info@big-company.co.uk → 'big-company'
 *   user@gmail.com         → null  (personal provider)
 */
function extractDomainLabel(email: string): string | null {
    const atIdx = email.lastIndexOf('@');
    if (atIdx === -1) return null;
    const afterAt = email.slice(atIdx + 1).toLowerCase(); // e.g. 'acmecorp.com'
    const dotIdx = afterAt.indexOf('.');
    const label = dotIdx !== -1 ? afterAt.slice(0, dotIdx) : afterAt; // e.g. 'acmecorp'
    if (label.length < 3) return null;
    if (PERSONAL_DOMAINS.has(label)) return null;
    return label;
}


/**
 * Match a sender email to a contact or company within the given tenant.
 *
 * Priority:
 * 1. contacts.email exact match → returns contact + company
 * 2. companies.company_email exact match → returns company only
 * 3. Domain label (between @ and first dot) matched against companies.name
 *    via ILIKE — also tries hyphens/underscores as spaces (best-effort)
 * 4. No match → unmatched
 */
export async function matchSenderEmail(
    senderEmail: string,
    defaultTenantId: string
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

    // Step 3: Domain label bidirectional match against company names (best-effort)
    //
    // Why bidirectional: the domain label may be longer than the company name
    // (e.g. domain 'mestergruppenlogistikk', company 'Mestergruppen') OR shorter
    // (e.g. domain 'acme', company 'Acme Corp A.Ş.'). Both directions are checked.
    //
    // Approach: fetch all tenant companies (≤500), normalize both sides to
    // lowercase alphanumeric, then check containment. Prefer the longest
    // matching company name to avoid false positives from short names.
    const domainLabel = extractDomainLabel(email);
    if (domainLabel) {
        const normalizedDomain = domainLabel.replace(/[^a-z0-9]/g, '');

        const { data: allCompanies, error: companiesErr } = await supabaseAdmin
            .from('companies')
            .select('id, tenant_id, name, updated_at')
            .eq('tenant_id', defaultTenantId)
            .limit(500);

        if (companiesErr) {
            // Non-fatal: log and fall through to unmatched
            log.warn({ err: companiesErr, email, domainLabel }, 'Domain label company fetch failed — skipping');
        } else if (allCompanies && allCompanies.length > 0) {
            let bestMatch: typeof allCompanies[0] | null = null;
            let bestLen = 0;

            for (const company of allCompanies) {
                if (!company.name) continue;
                // Normalize: lowercase, strip non-alphanumeric (removes spaces, dots, A.Ş., Ltd. etc.)
                const normalizedName = company.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                // Require at least 4 chars to avoid spurious matches on very short names
                if (normalizedName.length < 4) continue;

                const matched =
                    normalizedDomain.includes(normalizedName) ||   // 'mestergruppenlogistikk' includes 'mestergruppen'
                    normalizedName.includes(normalizedDomain);      // 'acmecorporation' includes 'acmecorp'

                if (matched && normalizedName.length > bestLen) {
                    bestLen = normalizedName.length;
                    bestMatch = company;
                }
            }

            if (bestMatch) {
                log.info({ email, company_id: bestMatch.id, domainLabel, company_name: bestMatch.name }, 'Matched via domain label (bidirectional)');
                return {
                    tenant_id: bestMatch.tenant_id,
                    company_id: bestMatch.id,
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
