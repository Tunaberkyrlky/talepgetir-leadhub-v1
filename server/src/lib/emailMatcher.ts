import { supabaseAdmin } from './supabase.js';
import { createLogger } from './logger.js';

const log = createLogger('emailMatcher');

export interface MatchResult {
    tenant_id: string;
    company_id: string | null;
    contact_id: string | null;
    match_status: 'matched' | 'unmatched';
}

/**
 * Match a sender email to a contact or company across all tenants.
 *
 * Priority:
 * 1. contacts.email → prefer is_primary, then updated_at DESC → returns contact + company
 * 2. companies.company_email → updated_at DESC → returns company only
 * 3. No match → uses defaultTenantId
 */
export async function matchSenderEmail(
    senderEmail: string,
    defaultTenantId: string
): Promise<MatchResult> {
    const email = senderEmail.toLowerCase().trim();

    // Step 1: Search contacts
    const { data: contacts, error: contactErr } = await supabaseAdmin
        .from('contacts')
        .select('id, company_id, tenant_id, is_primary, updated_at')
        .eq('email', email)
        .order('is_primary', { ascending: false })
        .order('updated_at', { ascending: false })
        .limit(1);

    if (contactErr) {
        log.error({ err: contactErr, email }, 'Contact lookup failed');
    }

    if (contacts && contacts.length > 0) {
        const contact = contacts[0];
        log.info({ email, contact_id: contact.id, company_id: contact.company_id }, 'Matched via contact');
        return {
            tenant_id: contact.tenant_id,
            company_id: contact.company_id,
            contact_id: contact.id,
            match_status: 'matched',
        };
    }

    // Step 2: Search companies
    const { data: companies, error: companyErr } = await supabaseAdmin
        .from('companies')
        .select('id, tenant_id, updated_at')
        .eq('company_email', email)
        .order('updated_at', { ascending: false })
        .limit(1);

    if (companyErr) {
        log.error({ err: companyErr, email }, 'Company lookup failed');
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

    // Step 3: No match
    log.info({ email }, 'No match found, using default tenant');
    return {
        tenant_id: defaultTenantId,
        company_id: null,
        contact_id: null,
        match_status: 'unmatched',
    };
}
