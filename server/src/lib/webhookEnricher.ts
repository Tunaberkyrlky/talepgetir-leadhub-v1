import { supabaseAdmin } from './supabase.js';
import { clearCompanyCache } from './emailMatcher.js';
import { createLogger } from './logger.js';

const log = createLogger('webhookEnricher');

interface WebhookPayload {
    first_name?: string | null;
    last_name?: string | null;
    company_name?: string | null;
    company_website?: string | null;
    linkedin_company_url?: string | null;
    linkedin_person_url?: string | null;
    industry?: string | null;
    job_title?: string | null;
    department?: string | null;
    phone_number?: string | null;
    country?: string | null;
    city?: string | null;
    state?: string | null;
    custom_company_size?: string | null;
    custom_revenue?: string | null;
}

/**
 * Fill blank fields on a matched company using PlusVibe webhook data.
 * Never overwrites existing values — only fills nulls/empty strings.
 */
export async function enrichCompanyFromWebhook(
    companyId: string,
    payload: WebhookPayload,
    tenantId: string,
): Promise<void> {
    const { data: company, error: fetchErr } = await supabaseAdmin
        .from('companies')
        .select('website, linkedin, industry, employee_size, location, company_phone, custom_fields')
        .eq('id', companyId)
        .single();

    if (fetchErr || !company) return;

    const updates: Record<string, unknown> = {};

    if (!company.website && payload.company_website) {
        updates.website = payload.company_website;
    }
    if (!company.linkedin && payload.linkedin_company_url) {
        updates.linkedin = payload.linkedin_company_url;
    }
    if (!company.industry && payload.industry) {
        updates.industry = payload.industry;
    }
    if (!company.employee_size && payload.custom_company_size) {
        updates.employee_size = payload.custom_company_size;
    }
    if (!company.location) {
        const parts = [payload.city, payload.state, payload.country].filter(Boolean);
        if (parts.length > 0) updates.location = parts.join(', ');
    }
    if (!company.company_phone && payload.phone_number) {
        updates.company_phone = payload.phone_number;
    }

    // Store revenue in custom_fields if not already set
    if (payload.custom_revenue) {
        const cf = (company.custom_fields as Record<string, unknown>) || {};
        if (!cf.revenue) {
            updates.custom_fields = { ...cf, revenue: payload.custom_revenue };
        }
    }

    if (Object.keys(updates).length === 0) return;

    const { error } = await supabaseAdmin
        .from('companies')
        .update(updates)
        .eq('id', companyId);

    if (error) {
        log.warn({ err: error, companyId }, 'Company enrichment failed');
    } else {
        log.info({ companyId, fields: Object.keys(updates) }, 'Company enriched from webhook');
        // If website was updated, clear cache so matching uses the new value
        if (updates.website) clearCompanyCache(tenantId);
    }
}

/**
 * Fill blank fields on a matched contact using PlusVibe webhook data.
 * Never overwrites existing values — only fills nulls/empty strings.
 */
export async function enrichContactFromWebhook(
    contactId: string,
    payload: WebhookPayload,
): Promise<void> {
    const { data: contact, error: fetchErr } = await supabaseAdmin
        .from('contacts')
        .select('first_name, last_name, title, linkedin, phone_e164, department, country')
        .eq('id', contactId)
        .single();

    if (fetchErr || !contact) return;

    const updates: Record<string, unknown> = {};

    if (!contact.first_name && payload.first_name) {
        updates.first_name = payload.first_name;
    }
    if (!contact.last_name && payload.last_name) {
        updates.last_name = payload.last_name;
    }
    if (!contact.title && payload.job_title) {
        updates.title = payload.job_title;
    }
    if (!contact.linkedin && payload.linkedin_person_url) {
        updates.linkedin = payload.linkedin_person_url;
    }
    if (!contact.phone_e164 && payload.phone_number) {
        updates.phone_e164 = payload.phone_number;
    }
    if (!contact.department && payload.department) {
        updates.department = payload.department;
    }
    if (!contact.country && payload.country) {
        updates.country = payload.country;
    }

    if (Object.keys(updates).length === 0) return;

    const { error } = await supabaseAdmin
        .from('contacts')
        .update(updates)
        .eq('id', contactId);

    if (error) {
        log.warn({ err: error, contactId }, 'Contact enrichment failed');
    } else {
        log.info({ contactId, fields: Object.keys(updates) }, 'Contact enriched from webhook');
    }
}
