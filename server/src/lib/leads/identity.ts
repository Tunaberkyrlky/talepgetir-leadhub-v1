/**
 * Lead identity resolution (v3 §7.1 ordered layers + §7.2 company match rules).
 *
 * Given a normalized submission, find the existing company/contact the lead
 * belongs to, in this strict order — each layer reports the match_method used:
 *   1. external_lead_id   (handled at the submission dedup level, in intake.ts)
 *   2. exact contact email
 *   3. exact contact phone
 *   4. canonical website/work-email domain → company
 *   5. company name + country              → company (ambiguous ⇒ needs_review)
 *   6. person name + domain                (contact-within-company, in intake.ts)
 *   7. nothing strong ⇒ caller creates (never fabricating a domain) or pends.
 *
 * Matching ONLY — creation lives in intake.ts so §7.2/§7.3 "create-or-enrich"
 * stays in one place. Every query is tenant-scoped (defense in depth atop RLS).
 */
import { supabaseAdmin } from '../supabase.js';
import { normalizeDomain, normalizeText } from '../research/engine/canonical.js';
import { extractEmailDomain } from '../emailMatcher.js';
import { escapeLike, type NormalizedLead } from './normalize.js';

export type LeadMatchMethod =
  | 'external_lead_id'
  | 'work_email'
  | 'phone'
  | 'domain'
  | 'name_country'
  | 'person_domain';

export interface IdentityResolution {
  companyId: string | null;
  contactId: string | null;
  matchMethod: LeadMatchMethod | null;
  needsReview: boolean;
  reviewReason: string | null;
  /** Registrable domain in play (website or work-email), so the caller can
   *  create a company WITH a real website instead of fabricating one. */
  domain: string | null;
}

interface ContactRow { id: string; company_id: string }
interface CompanyRow { id: string; name: string; website: string | null; country: string | null; location: string | null }

async function findContactByEmail(tenantId: string, email: string): Promise<ContactRow | null> {
  const { data } = await supabaseAdmin
    .from('contacts')
    .select('id, company_id')
    .eq('tenant_id', tenantId)
    .ilike('email', escapeLike(email))
    .limit(1)
    .maybeSingle();
  return (data as ContactRow) ?? null;
}

async function findContactByPhone(tenantId: string, phone: string): Promise<ContactRow | null> {
  const { data } = await supabaseAdmin
    .from('contacts')
    .select('id, company_id')
    .eq('tenant_id', tenantId)
    .eq('phone_e164', phone)
    .limit(1)
    .maybeSingle();
  return (data as ContactRow) ?? null;
}

/** Company whose stored website resolves to the same registrable domain.
 *  companies.website is free text, so pre-filter by substring then confirm
 *  with the public-suffix normalizer (canonical.ts). */
export async function findCompanyByDomain(tenantId: string, domain: string): Promise<CompanyRow | null> {
  const { data } = await supabaseAdmin
    .from('companies')
    .select('id, name, website, country, location')
    .eq('tenant_id', tenantId)
    .not('website', 'is', null)
    .ilike('website', `%${escapeLike(domain)}%`)
    .limit(25);
  for (const row of (data as CompanyRow[]) ?? []) {
    if (normalizeDomain(row.website) === domain) return row;
  }
  return null;
}

/** Exact normalized-name (+ country when provided) company match.
 *  Returns { match } for exactly one strong hit, { ambiguous } for more than one. */
export async function findCompanyByNameCountry(
  tenantId: string,
  name: string,
  country: string | null,
): Promise<{ match: CompanyRow | null; ambiguous: boolean }> {
  const wantName = normalizeText(name);
  if (!wantName) return { match: null, ambiguous: false };
  const wantCountry = country ? normalizeText(country) : null;

  const { data } = await supabaseAdmin
    .from('companies')
    .select('id, name, website, country, location')
    .eq('tenant_id', tenantId)
    .ilike('name', `%${escapeLike(name)}%`)
    .limit(50);

  const strong = ((data as CompanyRow[]) ?? []).filter((row) => {
    if (normalizeText(row.name) !== wantName) return false;
    if (!wantCountry) return true;
    const rowCountry = normalizeText(row.country ?? '');
    const rowLocation = normalizeText(row.location ?? '');
    // Country is a soft signal: match on country, or a location that contains it.
    return rowCountry === wantCountry || (rowLocation.length > 0 && rowLocation.includes(wantCountry));
  });

  if (strong.length === 1) return { match: strong[0], ambiguous: false };
  if (strong.length > 1) return { match: null, ambiguous: true };
  return { match: null, ambiguous: false };
}

export async function resolveIdentity(tenantId: string, norm: NormalizedLead): Promise<IdentityResolution> {
  const base: IdentityResolution = {
    companyId: null, contactId: null, matchMethod: null,
    needsReview: false, reviewReason: null, domain: null,
  };

  // Layer 2 — exact contact email
  if (norm.email) {
    const c = await findContactByEmail(tenantId, norm.email);
    if (c) return { ...base, companyId: c.company_id, contactId: c.id, matchMethod: 'work_email' };
  }

  // Layer 3 — exact contact phone
  if (norm.phone) {
    const c = await findContactByPhone(tenantId, norm.phone);
    if (c) return { ...base, companyId: c.company_id, contactId: c.id, matchMethod: 'phone' };
  }

  // Layer 4 — canonical domain (website field, else work-email domain)
  const domain = norm.domain ?? (norm.email ? extractEmailDomain(norm.email) : null);
  if (domain) {
    const co = await findCompanyByDomain(tenantId, domain);
    if (co) return { ...base, companyId: co.id, matchMethod: 'domain', domain };
  }

  // Layer 5 — company name (+ country). A single hit auto-links ONLY when the name
  // is corroborated by country; a name-ONLY hit is too weak (common names collide)
  // and a multi-hit is ambiguous — both go to needs_review, never auto-link.
  if (norm.companyName) {
    const { match, ambiguous } = await findCompanyByNameCountry(tenantId, norm.companyName, norm.country);
    if (ambiguous) {
      return { ...base, matchMethod: 'name_country', needsReview: true, reviewReason: 'ambiguous_company_name', domain };
    }
    if (match) {
      if (norm.country) return { ...base, companyId: match.id, matchMethod: 'name_country', domain };
      return { ...base, matchMethod: 'name_country', needsReview: true, reviewReason: 'name_only_match', domain };
    }
  }

  // Layer 7 — nothing strong. Caller creates (if it has a domain or name) or pends.
  return { ...base, domain };
}
