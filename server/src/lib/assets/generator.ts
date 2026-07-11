/**
 * Asset generator (v3 §9, WP3). Turns a recipe + read-only lead/company/contact
 * evidence into STRUCTURED content JSON (never free-form HTML — the renderer maps
 * the structured JSON onto a fixed template, v3 §9.3).
 *
 * GUARDRAIL: DRY-RUN is the default and the ONLY path that runs unattended. In
 * dry-run the generator synthesizes a deterministic template/stub from the evidence
 * — it makes NO LLM call, so COGS is $0. A `live` path exists strictly behind
 * ASSET_LLM_LIVE=true; it adapts the role-based LLM router (never names a provider),
 * but the flag is off at night so it never runs.
 */
import { z } from 'zod/v4';
import { supabaseAdmin } from '../supabase.js';

export type AssetLlmMode = 'dry_run' | 'live';

/** Effective mode. Default dry_run; only an explicit env opt-in selects live. */
export function assetLlmMode(): AssetLlmMode {
  return process.env.ASSET_LLM_LIVE === 'true' ? 'live' : 'dry_run';
}

// ── structured content contract (renderer input) ─────────────────────────────
// The renderer only ever sees this shape; the LLM (live path) is constrained to
// produce it, and the dry-run path builds it deterministically.
// Bounded so a compromised/verbose LIVE model (or malformed input) can't blow up the
// rendered document or the DB row. Limits mirror the fixed template's real shape.
export const assetSectionSchema = z.object({
  heading: z.string().max(120),
  body: z.string().max(2500),
});
export const structuredContentSchema = z.object({
  title: z.string().max(160),
  subtitle: z.string().max(200).nullable().optional(),
  summary: z.string().max(1500),
  sections: z.array(assetSectionSchema).max(8),
  cta: z.object({
    label: z.string().max(120),
    url: z.string().max(2048).nullable().optional(),
  }).nullable().optional(),
});
export type StructuredContent = z.infer<typeof structuredContentSchema>;

export interface AssetTarget {
  leadId?: string | null;
  companyId?: string | null;
  contactId?: string | null;
}

export interface AssetRecipeInput {
  key: string;
  name: string;
  description?: string | null;
  prompt_template?: string | null;
  cta_config?: { label?: string; url?: string | null; booking_url?: string | null } | null;
}

export interface AssetEvidence {
  companyName: string | null;
  industry: string | null;
  website: string | null;
  location: string | null;
  employeeSize: string | null;
  companySummary: string | null;
  contactName: string | null;
  contactTitle: string | null;
}

export interface EvidenceResult {
  evidence: AssetEvidence;
  /** Raw snapshot persisted (write-once) as source_evidence_snapshot for audit. */
  snapshot: Record<string, unknown>;
}

const EMPTY_EVIDENCE: AssetEvidence = {
  companyName: null, industry: null, website: null, location: null,
  employeeSize: null, companySummary: null, contactName: null, contactTitle: null,
};

/**
 * Gather read-only evidence for an asset from the linked company/contact rows.
 * READ-ONLY: it never writes and never touches the research worker/queue schema.
 * A target with no links yields empty evidence (the dry-run stub still renders).
 */
export async function gatherAssetEvidence(tenantId: string, target: AssetTarget): Promise<EvidenceResult> {
  const evidence: AssetEvidence = { ...EMPTY_EVIDENCE };
  const snapshot: Record<string, unknown> = {
    company_id: target.companyId ?? null,
    contact_id: target.contactId ?? null,
    lead_id: target.leadId ?? null,
  };

  if (target.companyId) {
    const { data } = await supabaseAdmin
      .from('companies')
      .select('name, industry, website, location, employee_size, company_summary')
      .eq('id', target.companyId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const row = (data || null) as {
      name?: string; industry?: string | null; website?: string | null;
      location?: string | null; employee_size?: string | null; company_summary?: string | null;
    } | null;
    if (row) {
      evidence.companyName = row.name ?? null;
      evidence.industry = row.industry ?? null;
      evidence.website = row.website ?? null;
      evidence.location = row.location ?? null;
      evidence.employeeSize = row.employee_size ?? null;
      evidence.companySummary = row.company_summary ?? null;
      snapshot.company = {
        name: row.name ?? null, industry: row.industry ?? null, website: row.website ?? null,
        location: row.location ?? null, employee_size: row.employee_size ?? null,
        has_summary: !!row.company_summary,
      };
    }
  }

  if (target.contactId) {
    const { data } = await supabaseAdmin
      .from('contacts')
      .select('first_name, last_name, title')
      .eq('id', target.contactId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const row = (data || null) as { first_name?: string; last_name?: string | null; title?: string | null } | null;
    if (row) {
      evidence.contactName = [row.first_name, row.last_name].filter(Boolean).join(' ') || null;
      evidence.contactTitle = row.title ?? null;
      snapshot.contact = { name: evidence.contactName, title: row.title ?? null };
    }
  }

  return { evidence, snapshot };
}

/** Deterministic dry-run structured content built purely from the evidence. */
function buildDryRunContent(recipe: AssetRecipeInput, evidence: AssetEvidence): StructuredContent {
  const audience = evidence.companyName || 'your company';
  const industry = evidence.industry || 'your industry';
  const sections = [
    {
      heading: 'Snapshot',
      body: [
        evidence.companyName ? `Company: ${evidence.companyName}.` : null,
        evidence.industry ? `Industry: ${evidence.industry}.` : null,
        evidence.location ? `Location: ${evidence.location}.` : null,
        evidence.employeeSize ? `Team size: ${evidence.employeeSize}.` : null,
      ].filter(Boolean).join(' ') || 'A tailored overview will appear here once evidence is linked.',
    },
    {
      heading: 'Why it matters',
      body: `This ${recipe.name} highlights opportunities relevant to ${audience} within ${industry}.`,
    },
    {
      heading: 'Recommended next step',
      body: recipe.description || 'Review the highlights and book a short call to go deeper.',
    },
  ];
  const ctaLabel = recipe.cta_config?.label || 'Book a call';
  const ctaUrl = recipe.cta_config?.url ?? recipe.cta_config?.booking_url ?? null;
  return {
    title: `${recipe.name} — ${audience}`,
    subtitle: evidence.industry ? `Prepared for ${industry}` : null,
    summary: `A personalized ${recipe.name.toLowerCase()} prepared for ${audience}.`,
    sections,
    cta: { label: ctaLabel, url: ctaUrl },
  };
}

/**
 * Produce structured content for an asset. DRY-RUN (default) returns a deterministic
 * stub with no network/LLM call. LIVE (ASSET_LLM_LIVE=true — off at night) adapts the
 * role-based LLM router to fill the SAME structured schema; the renderer never sees
 * free LLM HTML either way.
 */
export async function generateStructuredContent(
  recipe: AssetRecipeInput,
  evidence: AssetEvidence,
): Promise<{ mode: AssetLlmMode; content: StructuredContent }> {
  const mode = assetLlmMode();
  if (mode === 'dry_run') {
    return { mode, content: buildDryRunContent(recipe, evidence) };
  }

  // LIVE seam (flag-gated; never runs unattended). The model is constrained to the
  // structured schema via runLlmJson — it can NOT emit free-form HTML. The router is
  // loaded lazily here so the dry-run path never pulls in the LLM provider layer.
  const { runLlmJson } = await import('../research/llm/router.js');
  const system =
    'You produce a concise, factual B2B lead-magnet as STRUCTURED JSON only. ' +
    'Never include HTML or markdown. Use only the provided evidence; do not invent facts.';
  const user =
    `Recipe: ${recipe.name}\n` +
    `${recipe.prompt_template ? `Instructions: ${recipe.prompt_template}\n` : ''}` +
    `Evidence: ${JSON.stringify(evidence)}`;
  const { value } = await runLlmJson('strategy', structuredContentSchema, {
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 4000,
  });
  return { mode, content: value };
}
