/**
 * Lead intake normalization (v3 §7.1, "email/phone/domain normalize" step).
 *
 * Turns a raw form payload's loose fields into the canonical shapes identity
 * resolution and storage rely on. Reuses the CRM's existing primitives:
 *   • sanitizeEmail  — strips placeholder/junk email values (validation.ts)
 *   • normalizeDomain — registrable domain via tldts / public-suffix (canonical.ts)
 * so a lead's identity keys match how companies/contacts were already stored.
 */
import { sanitizeEmail } from '../validation.js';
import { normalizeDomain, normalizeText } from '../research/engine/canonical.js';

/** Which raw payload keys feed each normalized field. field_mapping (per form)
 *  overrides these; a raw key wins over its aliases. */
const DEFAULT_FIELD_ALIASES: Record<string, string[]> = {
  email: ['email', 'work_email', 'business_email', 'e_mail', 'mail'],
  phone: ['phone', 'phone_number', 'telephone', 'tel', 'mobile', 'whatsapp'],
  first_name: ['first_name', 'firstname', 'fname', 'given_name'],
  last_name: ['last_name', 'lastname', 'lname', 'surname', 'family_name'],
  full_name: ['full_name', 'name', 'fullname', 'contact_name'],
  company_name: ['company_name', 'company', 'organization', 'organisation', 'business_name'],
  website: ['website', 'company_website', 'url', 'site', 'domain'],
  title: ['title', 'job_title', 'role', 'position'],
  country: ['country', 'country_name'],
};

const ATTRIBUTION_KEYS = {
  utm_source: ['utm_source'],
  utm_medium: ['utm_medium'],
  utm_campaign: ['utm_campaign'],
  utm_content: ['utm_content'],
  utm_term: ['utm_term'],
  gclid: ['gclid', 'gcl_id'],
  fbclid: ['fbclid'],
  landing_url: ['landing_url', 'landing_page', 'page_url'],
  referrer: ['referrer', 'referer', 'ref'],
} as const;

export interface NormalizedLead {
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  companyName: string | null;
  website: string | null;      // raw website string as given (kept, never fabricated)
  domain: string | null;       // canonical registrable domain, or null
  title: string | null;
  country: string | null;
}

export interface NormalizedAttribution {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  gclid: string | null;
  fbclid: string | null;
  landing_url: string | null;
  referrer: string | null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    return t.length ? t : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Pick the first present raw key for a logical field, honoring a form's
 *  field_mapping (rawKey → logicalField) before falling back to aliases. */
function pick(
  payload: Record<string, unknown>,
  logical: string,
  mappingByLogical: Record<string, string>,
): string | null {
  const mapped = mappingByLogical[logical];
  if (mapped && payload[mapped] !== undefined) {
    const v = str(payload[mapped]);
    if (v) return v;
  }
  for (const alias of DEFAULT_FIELD_ALIASES[logical] ?? [logical]) {
    const v = str(payload[alias]);
    if (v) return v;
  }
  return null;
}

/** E.164-ish phone normalize: keep a single leading '+' (or map a leading 00),
 *  strip everything non-digit. Returns null if fewer than 7 digits remain
 *  (too short to be a routable number) — deliberately light, not a full libphonenumber. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hadPlus = trimmed.startsWith('+') || trimmed.startsWith('00');
  let digits = trimmed.replace(/\D+/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2); // drop international 00 prefix
  if (digits.length < 7 || digits.length > 15) return null; // E.164 length bounds
  return hadPlus ? `+${digits}` : digits;
}

/** Escape LIKE/ILIKE wildcards so user-supplied text matches LITERALLY. Postgres
 *  LIKE treats % and _ as wildcards and \ as the default escape char; escape all
 *  three so a value like "a_b%c" can't act as a wildcard pattern (or scan-inflate). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Build a field_mapping lookup keyed by logical field. The stored mapping is
 *  rawKey → logicalField; invert it so pick() can go logical → rawKey. */
function invertMapping(fieldMapping: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (fieldMapping && typeof fieldMapping === 'object') {
    for (const [rawKey, logical] of Object.entries(fieldMapping as Record<string, unknown>)) {
      if (typeof logical === 'string' && logical) out[logical] = rawKey;
    }
  }
  return out;
}

export function normalizeSubmission(
  payload: Record<string, unknown>,
  fieldMapping?: unknown,
): NormalizedLead {
  const map = invertMapping(fieldMapping);

  const email = sanitizeEmail(pick(payload, 'email', map))?.toLowerCase() ?? null;
  const phone = normalizePhone(pick(payload, 'phone', map));

  let firstName = pick(payload, 'first_name', map);
  let lastName = pick(payload, 'last_name', map);
  const fullName = pick(payload, 'full_name', map);
  if (!firstName && fullName) {
    const parts = fullName.split(/\s+/);
    firstName = parts[0] ?? null;
    if (!lastName && parts.length > 1) lastName = parts.slice(1).join(' ');
  }

  const website = pick(payload, 'website', map);
  const domain = normalizeDomain(website);

  return {
    email,
    phone,
    firstName,
    lastName,
    fullName: fullName ?? (firstName ? [firstName, lastName].filter(Boolean).join(' ') : null),
    companyName: pick(payload, 'company_name', map),
    website,
    domain,
    title: pick(payload, 'title', map),
    country: pick(payload, 'country', map),
  };
}

export function normalizeAttribution(payload: Record<string, unknown>): NormalizedAttribution {
  const out = {} as Record<keyof typeof ATTRIBUTION_KEYS, string | null>;
  for (const [field, aliases] of Object.entries(ATTRIBUTION_KEYS)) {
    let value: string | null = null;
    for (const alias of aliases) {
      const v = str(payload[alias]);
      if (v) { value = v; break; }
    }
    out[field as keyof typeof ATTRIBUTION_KEYS] = value;
  }
  return out as NormalizedAttribution;
}

/** Normalized company name key for name+country fuzzy match (canonical.ts). */
export { normalizeText };
