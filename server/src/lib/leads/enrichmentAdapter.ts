/**
 * Lead enrichment adapter (v3 §8, WP2). READ-ONLY bridge to company evidence.
 *
 * GUARDRAIL: DRY-RUN is the default and the ONLY path that runs unattended. In
 * dry-run the adapter synthesizes website evidence from the lead's already-stored
 * companies row — it performs NO network fetch and NEVER touches the research
 * worker/queue schema (research_jobs …). A `live` mode exists strictly behind a
 * flag (LEAD_ENRICHMENT_MODE=live) as the seam where a future read-only website
 * crawler would plug in; it is intentionally NOT wired to any scraper here, so no
 * real scrape is ever triggered (least of all at night).
 */
import { supabaseAdmin } from '../supabase.js';
import { normalizeDomain } from '../research/engine/canonical.js';
import type { QualificationFormFields, WebsiteEvidence } from './qualification.js';

export type EnrichmentMode = 'dry_run' | 'live';

/** Effective mode. Default dry_run; only an explicit env opt-in selects live. */
export function enrichmentMode(): EnrichmentMode {
  return process.env.LEAD_ENRICHMENT_MODE === 'live' ? 'live' : 'dry_run';
}

interface CompanyEvidenceRow {
  website: string | null;
  industry: string | null;
  employee_size: string | null;
  location: string | null;
  company_summary: string | null;
}

export interface EvidenceResult {
  mode: EnrichmentMode;
  websiteEvidence: WebsiteEvidence;
  /** Raw snapshot persisted as source_evidence for audit. */
  sourceEvidence: Record<string, unknown>;
}

const EMPTY_EVIDENCE: WebsiteEvidence = {
  hasWebsite: false, domain: null, industry: null,
  employeeSize: null, country: null, summary: null, source: 'none',
};

/**
 * Gather read-only website evidence for a lead. Dry-run reads the linked companies
 * row (no company ⇒ empty evidence, which qualification treats as low-confidence
 * ⇒ review). Live throws NotConfigured rather than silently scraping.
 */
export async function gatherWebsiteEvidence(
  tenantId: string,
  companyId: string | null,
  _formFields: QualificationFormFields,
): Promise<EvidenceResult> {
  const mode = enrichmentMode();

  if (mode === 'live') {
    // Intentionally unwired: no live website crawler is bound here (guardrail —
    // no real scrape). A future READ-ONLY crawler plugs in at this branch.
    throw new Error('live enrichment is not configured (dry-run only)');
  }

  if (!companyId) {
    return { mode, websiteEvidence: EMPTY_EVIDENCE, sourceEvidence: { reason: 'no_company' } };
  }

  const { data } = await supabaseAdmin
    .from('companies')
    .select('website, industry, employee_size, location, company_summary')
    .eq('id', companyId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  const row = (data || null) as CompanyEvidenceRow | null;
  if (!row) {
    return { mode, websiteEvidence: EMPTY_EVIDENCE, sourceEvidence: { reason: 'company_not_found' } };
  }

  const domain = row.website ? normalizeDomain(row.website) : null;
  const websiteEvidence: WebsiteEvidence = {
    hasWebsite: !!row.website,
    domain,
    industry: row.industry,
    employeeSize: row.employee_size,
    country: row.location,
    summary: row.company_summary,
    source: 'company_row',
  };

  return {
    mode,
    websiteEvidence,
    sourceEvidence: {
      company_id: companyId,
      website: row.website,
      domain,
      industry: row.industry,
      employee_size: row.employee_size,
      location: row.location,
      has_summary: !!row.company_summary,
    },
  };
}
