/**
 * Lead qualification (v3 §8 enrichment+qualification, §26 code org).
 *
 * A PURE function: given a lead's form fields + read-only website evidence and an
 * optional recipe, it produces a score, a verdict, the evidence that fired, and
 * machine reason codes. No I/O, no DB, no network — the adapter gathers evidence
 * and the route persists the result. Low-confidence ALWAYS routes to `review`
 * (a human decides; qualification never triggers outbound).
 *
 * The recipe is the per-source qualification config (lead_sources.qualification_recipe,
 * migration 123). NULL ⇒ the built-in DEFAULT_RECIPE below.
 */

/** Form-field subset qualification reads (mirrors NormalizedLead keys). */
export interface QualificationFormFields {
  email: string | null;
  companyName: string | null;
  website: string | null;
  domain: string | null;       // canonical registrable domain, or null
  country: string | null;
  fullName: string | null;
  phone: string | null;
  title: string | null;
}

/** Read-only evidence the enrichment adapter gathered (dry-run: the companies row). */
export interface WebsiteEvidence {
  hasWebsite: boolean;
  domain: string | null;
  industry: string | null;
  employeeSize: string | null;   // free-text band as stored on companies (e.g. "11-50")
  country: string | null;
  summary: string | null;
  /** Where the evidence came from — 'none' means nothing to score on ⇒ review. */
  source: 'company_row' | 'live_crawl' | 'none';
}

/** Qualification recipe MVP: required fields + ICP/geo/company-size signals + bands. */
export interface QualificationRecipe {
  requiredFields?: string[];          // e.g. ['email','company'] — any missing forces review/disqualify
  icpIndustries?: string[];           // case-insensitive substring match against evidence.industry
  icpCountries?: string[];            // ISO name/code match against country (form or evidence)
  minEmployees?: number;              // smallest acceptable company size (parsed from band)
  qualifiedAt?: number;               // score ≥ this ⇒ qualified (default 65)
  disqualifiedAt?: number;            // score ≤ this ⇒ disqualified (default 30)
}

export interface EvidenceItem {
  code: string;
  weight: number;      // signed contribution to the score
  hit: boolean;        // whether the signal fired positively
  detail?: string | null;
}

export interface QualificationResult {
  score: number;                                        // 0..100
  verdict: 'qualified' | 'disqualified' | 'review';
  evidence: EvidenceItem[];
  reasonCodes: string[];
}

export const DEFAULT_RECIPE: QualificationRecipe = {
  requiredFields: ['email', 'company'],
  qualifiedAt: 65,
  disqualifiedAt: 30,
};

const BASE_SCORE = 50;

function norm(s: string | null | undefined): string {
  return (s || '').toLowerCase().trim();
}

/** Parse a company-size band's lower bound ("11-50", "51+", "200") → number|null. */
function employeeLowerBound(band: string | null): number | null {
  if (!band) return null;
  const m = band.replace(/[,\s]/g, '').match(/\d+/);
  return m ? Number.parseInt(m[0], 10) : null;
}

/**
 * Score + verdict for a lead. Deterministic and side-effect free.
 * The verdict bands come from the recipe (or DEFAULT_RECIPE); a missing required
 * field or an absence of any real website evidence forces `review` (or disqualify),
 * never a silent `qualified`.
 */
export function qualifyLead(
  formFields: QualificationFormFields,
  websiteEvidence: WebsiteEvidence,
  recipe?: QualificationRecipe | null,
): QualificationResult {
  const r = { ...DEFAULT_RECIPE, ...(recipe || {}) };
  const evidence: EvidenceItem[] = [];
  const reasonCodes: string[] = [];
  let score = BASE_SCORE;

  const push = (code: string, weight: number, hit: boolean, detail?: string | null) => {
    evidence.push({ code, weight, hit, detail: detail ?? null });
    if (hit) reasonCodes.push(code);
    score += weight;
  };

  // ── contactability signals ────────────────────────────────────────────────
  const hasEmail = !!formFields.email;
  push(hasEmail ? 'has_email' : 'missing_email', hasEmail ? 15 : -30, hasEmail);

  const hasCompany = !!(formFields.companyName || formFields.website || formFields.domain);
  push(hasCompany ? 'has_company' : 'missing_company', hasCompany ? 10 : -20, hasCompany);

  const hasWebsite = websiteEvidence.hasWebsite || !!formFields.domain;
  if (hasWebsite) push('has_website', 15, true, websiteEvidence.domain || formFields.domain);

  // Work-email signal: the email's domain equals the company's registrable domain.
  const emailDomain = formFields.email ? norm(formFields.email.split('@')[1]) : '';
  const bizDomain = norm(websiteEvidence.domain || formFields.domain);
  if (emailDomain && bizDomain && emailDomain === bizDomain) {
    push('work_email', 10, true, emailDomain);
  }

  // ── ICP / geo / company-size signals (only when the recipe declares them) ──
  if (r.icpIndustries?.length) {
    const ind = norm(websiteEvidence.industry);
    const match = ind ? r.icpIndustries.some((w) => ind.includes(norm(w))) : false;
    push(match ? 'icp_industry_match' : 'icp_industry_miss', match ? 15 : -10, match, websiteEvidence.industry);
  }

  if (r.icpCountries?.length) {
    const country = norm(websiteEvidence.country || formFields.country);
    const match = country ? r.icpCountries.some((c) => norm(c) === country || country.includes(norm(c))) : false;
    push(match ? 'icp_country_match' : 'icp_country_miss', match ? 10 : -10, match, websiteEvidence.country || formFields.country);
  }

  if (typeof r.minEmployees === 'number') {
    const size = employeeLowerBound(websiteEvidence.employeeSize);
    const match = size !== null ? size >= r.minEmployees : false;
    if (size !== null) push(match ? 'company_size_match' : 'company_size_below', match ? 10 : -10, match, websiteEvidence.employeeSize);
  }

  // ── required fields (recipe gate) ──────────────────────────────────────────
  const present: Record<string, boolean> = {
    email: hasEmail,
    company: hasCompany,
    website: hasWebsite,
    phone: !!formFields.phone,
    name: !!formFields.fullName,
    country: !!(formFields.country || websiteEvidence.country),
  };
  const missingRequired = (r.requiredFields || []).filter((f) => present[f] === false);
  for (const f of missingRequired) {
    evidence.push({ code: 'missing_required', weight: 0, hit: false, detail: f });
    reasonCodes.push(`missing_required_${f}`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // ── verdict ────────────────────────────────────────────────────────────────
  // No real evidence to score on ⇒ we cannot qualify with confidence ⇒ review.
  const lowConfidence = websiteEvidence.source === 'none';
  if (lowConfidence) reasonCodes.push('low_confidence');

  const qualifiedAt = r.qualifiedAt ?? 65;
  const disqualifiedAt = r.disqualifiedAt ?? 30;

  let verdict: QualificationResult['verdict'];
  if (score <= disqualifiedAt) {
    verdict = 'disqualified';
  } else if (missingRequired.length > 0 || lowConfidence || score < qualifiedAt) {
    // Missing a required field or thin evidence never auto-qualifies — a human decides.
    verdict = 'review';
  } else {
    verdict = 'qualified';
  }

  return { score, verdict, evidence, reasonCodes };
}
