/**
 * Lead intake pipeline (v3 §7.1-7.3). One entry point, run synchronously but
 * lightly so the public endpoint answers in milliseconds (enrichment/crawl is
 * Phase 3, deliberately NOT here):
 *
 *   honeypot? → record spam_suspect submission, no lead
 *   → write IMMUTABLE submission (provider-dedup aware)
 *   → provisional lead + link submission
 *   → resolve identity → create-or-match company/contact (never fabricating a domain)
 *   → finalize lead lifecycle, write touchpoint, mark submission processed
 *
 * All writes go through supabaseAdmin (service role) with an explicit tenant_id.
 */
import { createHash } from 'crypto';
import { supabaseAdmin } from '../supabase.js';
import { createLogger } from '../logger.js';
import { normalizeSubmission, normalizeAttribution, normalizeText, escapeLike, type NormalizedLead } from './normalize.js';
import { resolveIdentity } from './identity.js';

const log = createLogger('lib:leads:intake');

export interface LeadFormRow {
  id: string;
  tenant_id: string;
  source_id: string | null;
  field_mapping: unknown;
  honeypot_field: string | null;
}

export interface IntakeInput {
  form: LeadFormRow;
  rawPayload: Record<string, unknown>;
  externalLeadId?: string | null;
  testLead?: boolean;
}

export type IntakeResult =
  | { status: 'ignored'; reason: 'honeypot' }
  | { status: 'duplicate'; leadId: string | null }
  | { status: 'created'; leadId: string; lifecycle: string; needsReview: boolean }
  | { status: 'error'; leadId: string | null };

function str(value: unknown): string | null {
  if (typeof value === 'string') { const t = value.trim(); return t.length ? t : null; }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Deterministic canonical JSON: object keys sorted recursively so two identical
 *  payloads hash the same regardless of key order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    return Object.keys(src).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = canonicalize(src[k]);
      return acc;
    }, {});
  }
  return value;
}

/** Organic-dedup key: sha256 of the canonical raw payload. A same-day re-submit of
 *  an identical body with NO provider id collides on the organic-dedup unique index
 *  (tenant, form, fingerprint, UTC day) ⇒ no second lead. */
function payloadFingerprint(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

function emailLocalPart(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  const local = at > 0 ? email.slice(0, at) : email;
  return local.replace(/[._-]+/g, ' ').trim() || null;
}

/** Title-case the registrable domain's leading label as a display name
 *  ("acme-corp.com" → "Acme corp"). A NAME derived from a real domain — never a
 *  fabricated website. */
function displayNameFromDomain(domain: string): string {
  const label = domain.split('.')[0].replace(/[-_]+/g, ' ').trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : domain;
}

async function createCompany(
  tenantId: string,
  input: { name: string; website: string | null; country: string | null },
): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('companies')
    .insert({
      tenant_id: tenantId,
      name: input.name.slice(0, 500),
      website: input.website,
      country: input.country,
      location: input.country,
      stage: 'cold',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createCompany failed: ${error.message}`);
  return (data as { id: string }).id;
}

/** §7.3 — reuse an existing contact (by email, else by name) in this company;
 *  a repeat form fill must NOT spawn a duplicate contact. */
async function createOrMatchContact(tenantId: string, companyId: string, norm: NormalizedLead): Promise<string> {
  if (norm.email) {
    const { data } = await supabaseAdmin
      .from('contacts')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('company_id', companyId)
      .ilike('email', escapeLike(norm.email))
      .limit(1)
      .maybeSingle();
    if (data) return (data as { id: string }).id;
  }
  if (norm.firstName) {
    const { data } = await supabaseAdmin
      .from('contacts')
      .select('id, first_name, last_name')
      .eq('tenant_id', tenantId)
      .eq('company_id', companyId)
      .ilike('first_name', escapeLike(norm.firstName))
      .limit(10);
    const wantLast = normalizeText(norm.lastName ?? '');
    const hit = ((data as { id: string; first_name: string; last_name: string | null }[]) ?? []).find(
      (r) => normalizeText(r.last_name ?? '') === wantLast,
    );
    if (hit) return hit.id;
  }

  const firstName = norm.firstName || norm.fullName || emailLocalPart(norm.email) || 'Lead';
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .insert({
      tenant_id: tenantId,
      company_id: companyId,
      first_name: firstName.slice(0, 255),
      last_name: norm.lastName ? norm.lastName.slice(0, 255) : null,
      email: norm.email,
      phone_e164: norm.phone,
      title: norm.title ? norm.title.slice(0, 500) : null,
      country: norm.country,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createContact failed: ${error.message}`);
  return (data as { id: string }).id;
}

export async function processIntake(input: IntakeInput): Promise<IntakeResult> {
  const { form, rawPayload } = input;
  const tenantId = form.tenant_id;
  const externalLeadId = input.externalLeadId ?? str(rawPayload.external_lead_id) ?? null;
  const fingerprint = payloadFingerprint(rawPayload);
  const norm = normalizeSubmission(rawPayload, form.field_mapping);
  const attribution = normalizeAttribution(rawPayload);

  // Source defaults (source_type + owner) — one lightweight lookup.
  let sourceType = 'website';
  let ownerId: string | null = null;
  if (form.source_id) {
    const { data: src } = await supabaseAdmin
      .from('lead_sources')
      .select('source_type, default_owner_id')
      .eq('id', form.source_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (src) {
      sourceType = (src as { source_type: string }).source_type || 'website';
      ownerId = (src as { default_owner_id: string | null }).default_owner_id ?? null;
    }
  }

  // ── Honeypot (§MEGA 3.6): a filled hidden field ⇒ bot. Record for audit, no lead.
  const honeypotField = form.honeypot_field || '_hp';
  if (str(rawPayload[honeypotField])) {
    await supabaseAdmin.from('lead_submissions').insert({
      tenant_id: tenantId, lead_form_id: form.id, source_id: form.source_id,
      raw_payload: rawPayload, external_lead_id: externalLeadId,
      normalized: norm as unknown as Record<string, unknown>, utm: attribution as unknown as Record<string, unknown>,
      gclid: attribution.gclid, fbclid: attribution.fbclid,
      landing_url: attribution.landing_url, referrer: attribution.referrer,
      processing_status: 'spam_suspect', dedupe_result: 'spam_suspect',
      test_lead: input.testLead ?? false,
    });
    return { status: 'ignored', reason: 'honeypot' };
  }

  // ── Immutable submission. Provider-dedup unique may reject a repeat event.
  const submissionInsert = {
    tenant_id: tenantId, lead_form_id: form.id, source_id: form.source_id,
    raw_payload: rawPayload, external_lead_id: externalLeadId,
    normalized: norm as unknown as Record<string, unknown>, utm: attribution as unknown as Record<string, unknown>,
    gclid: attribution.gclid, fbclid: attribution.fbclid,
    landing_url: attribution.landing_url, referrer: attribution.referrer,
    processing_status: 'processing', test_lead: input.testLead ?? false,
    payload_fingerprint: fingerprint,
  };
  const { data: submission, error: subErr } = await supabaseAdmin
    .from('lead_submissions')
    .insert(submissionInsert)
    .select('id')
    .single();

  if (subErr) {
    // 23505 ⇒ a dedup unique index rejected a repeat submission ⇒ no second lead.
    // Provider dedup keys on external_lead_id; organic dedup keys on the payload
    // fingerprint (same tenant + form + body + UTC day). Return the prior lead so
    // the caller reports a duplicate rather than erroring.
    if (subErr.code === '23505') {
      let prior: { lead_id: string | null } | null = null;
      if (externalLeadId) {
        const { data } = await supabaseAdmin
          .from('lead_submissions')
          .select('lead_id')
          .eq('tenant_id', tenantId)
          .eq('lead_form_id', form.id)
          .eq('external_lead_id', externalLeadId)
          .limit(1)
          .maybeSingle();
        prior = data as { lead_id: string | null } | null;
      } else {
        const { data } = await supabaseAdmin
          .from('lead_submissions')
          .select('lead_id')
          .eq('tenant_id', tenantId)
          .eq('lead_form_id', form.id)
          .eq('payload_fingerprint', fingerprint)
          .order('submitted_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        prior = data as { lead_id: string | null } | null;
      }
      return { status: 'duplicate', leadId: prior?.lead_id ?? null };
    }
    throw new Error(`submission insert failed: ${subErr.message}`);
  }
  const submissionId = (submission as { id: string }).id;

  // ── Provisional lead (guarantees an inbox row even if resolution errors).
  const { data: leadRow, error: leadErr } = await supabaseAdmin
    .from('leads')
    .insert({
      tenant_id: tenantId, source_type: sourceType, source_id: form.source_id,
      lead_form_id: form.id, external_lead_id: externalLeadId,
      campaign_ref: attribution.utm_campaign,
      lifecycle_status: 'captured', owner_id: ownerId,
      raw_submission_id: submissionId, captured_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (leadErr) {
    await supabaseAdmin.from('lead_submissions').update({ processing_status: 'error', error_reason: leadErr.message }).eq('id', submissionId).eq('tenant_id', tenantId);
    throw new Error(`lead insert failed: ${leadErr.message}`);
  }
  const leadId = (leadRow as { id: string }).id;
  await supabaseAdmin.from('lead_submissions').update({ lead_id: leadId }).eq('id', submissionId).eq('tenant_id', tenantId);

  try {
    const resolution = await resolveIdentity(tenantId, norm);
    let { companyId, contactId } = resolution;
    const { matchMethod, needsReview, reviewReason } = resolution;

    // ── §7.2 create-or-match company (never fabricating a domain).
    if (!companyId && !needsReview) {
      if (norm.website && norm.domain) {
        companyId = await createCompany(tenantId, {
          name: norm.companyName || displayNameFromDomain(norm.domain),
          website: norm.website, country: norm.country,
        });
        // Phase 3 will enqueue a website profile crawl here; B2 stops at capture.
      } else if (norm.companyName) {
        companyId = await createCompany(tenantId, {
          name: norm.companyName, website: null, country: norm.country,
        });
      }
      // else: no company info ⇒ identity_pending (companyId stays null).
    }

    // ── §7.3 contact (only under a company; reuse, never duplicate).
    if (companyId && !contactId && (norm.email || norm.firstName || norm.fullName)) {
      contactId = await createOrMatchContact(tenantId, companyId, norm);
    }

    const lifecycle = needsReview ? 'needs_review' : companyId ? 'captured' : 'identity_pending';
    const dedupeResult = needsReview ? 'needs_review' : matchMethod ? `matched_${matchMethod}` : 'new';

    await supabaseAdmin.from('leads').update({
      company_id: companyId, contact_id: contactId,
      lifecycle_status: lifecycle, match_method: matchMethod, review_reason: reviewReason,
    }).eq('id', leadId).eq('tenant_id', tenantId);

    await supabaseAdmin.from('lead_touchpoints').insert({
      tenant_id: tenantId, lead_id: leadId, company_id: companyId, contact_id: contactId,
      source: attribution.utm_source, medium: attribution.utm_medium, campaign: attribution.utm_campaign,
      content: attribution.utm_content, term: attribution.utm_term,
      gclid: attribution.gclid, fbclid: attribution.fbclid,
      landing_url: attribution.landing_url, referrer: attribution.referrer,
      event_type: 'form_submit',
    });

    await supabaseAdmin.from('lead_submissions').update({
      processing_status: 'processed', company_id: companyId, contact_id: contactId,
      dedupe_result: dedupeResult, review_reason: reviewReason,
    }).eq('id', submissionId).eq('tenant_id', tenantId);

    return { status: 'created', leadId, lifecycle, needsReview };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'intake processing failed';
    log.error({ err, leadId, submissionId }, 'lead intake processing failed');
    await supabaseAdmin.from('leads').update({ lifecycle_status: 'processing_error', review_reason: message }).eq('id', leadId).eq('tenant_id', tenantId);
    await supabaseAdmin.from('lead_submissions').update({ processing_status: 'error', error_reason: message }).eq('id', submissionId).eq('tenant_id', tenantId);
    return { status: 'error', leadId };
  }
}
