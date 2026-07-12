/**
 * Conversation-memory read-model (v3 §6.10, §26 lib/context/memory.ts — Phase 5 C4).
 *
 * The conversation_memory row is a DERIVED, deterministic summary folded from the raw
 * memory_facts observation ledger. This module exposes:
 *   - getMemory()      — read the current read-model row for a (tenant, lead)
 *   - getMemoryFacts() — read the current (not-superseded) facts for a lead
 *   - rebuildMemory()  — DETERMINISTICALLY fold facts → the read-model shape
 *
 * GUARDRAIL (the night guardrail): rebuildMemory does NO LLM call and NO generation — it is
 * a pure aggregation of already-observed facts. It is also NOT wired into any scheduler /
 * runtime tick, and it defaults to persist=false (returns the derived shape WITHOUT writing).
 * So even an accidental call cannot mutate the DB or run a model at rest.
 *
 * Tenant scoping: every query goes through supabaseAdmin (service role, bypasses RLS) with
 * an explicit .eq('tenant_id', tenantId). The DB-level fence trigger (mig 128) is the backstop.
 */
import { supabaseAdmin } from '../supabase.js';
import { createLogger } from '../logger.js';

const log = createLogger('lib:context:memory');

/** Hard cap on a single piece of lead source-data (injection-guard length clamp). */
export const MAX_SOURCE_FIELD_CHARS = 2000;

/**
 * INJECTION GUARD (canonical). Normalise a piece of lead-authored text into inert source-data:
 * coerce to string, strip control chars / bidi-override / format chars, collapse whitespace, and
 * cap length. The result is DATA to be shown/stored, NEVER concatenated into an instruction.
 * This lives here (the lowest context module) so BOTH the fold (memory.ts) and the assemble
 * (assemble.ts, which re-exports it) run every lead-sourced string through the same guard —
 * memory_facts-derived text no longer bypasses the clamp that message text already gets.
 */
export function asSourceData(input: unknown, maxChars = MAX_SOURCE_FIELD_CHARS): string {
  if (input == null) return '';
  const raw = typeof input === 'string' ? input : String(input);
  // Strip C0 (U+0000-U+001F) + DEL + C1 (U+007F-U+009F) control chars, and the Unicode
  // bidi/format overrides (U+202A-U+202E embedding/override, U+2066-U+2069 isolates) that can
  // visually reorder or spoof text → space; then collapse whitespace. eslint no-control-regex is
  // intentional (that IS the guard).
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

/**
 * Deep variant: run asSourceData over every STRING leaf of an arbitrary structured value
 * (a memory_facts normalized_value object, a folded array entry, a preferences map). Numbers,
 * booleans and null pass through untouched; object keys are preserved. Used so a fact's raw
 * normalized_value can never smuggle control chars / unbounded text into the read-model.
 */
export function asSourceValue(v: unknown, maxChars = MAX_SOURCE_FIELD_CHARS): unknown {
  if (v == null) return v;
  if (typeof v === 'string') return asSourceData(v, maxChars);
  if (Array.isArray(v)) return v.map((x) => asSourceValue(x, maxChars));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = asSourceValue(val, maxChars);
    return out;
  }
  return v;
}

/** The fact_type taxonomy (mirrors memory_facts.fact_type CHECK in mig 128). */
export type FactType =
  | 'goal'
  | 'pain_point'
  | 'objection'
  | 'preference'
  | 'forbidden_topic'
  | 'commitment_ours'
  | 'commitment_theirs'
  | 'qa'
  | 'meeting_summary'
  | 'open_task'
  | 'relationship'
  | 'tone_language';

/** Where a fact was observed (mirrors memory_facts.source CHECK). */
export type FactSource = 'email' | 'whatsapp' | 'sms' | 'form' | 'meeting' | 'task' | 'human_note';

/** One raw observation row from memory_facts. */
export interface MemoryFact {
  id: string;
  tenant_id: string;
  memory_id: string | null;
  lead_id: string | null;
  fact_type: FactType;
  normalized_value: Record<string, unknown>;
  source: FactSource;
  source_ref_id: string | null;
  observed_at: string;
  superseded_by: string | null;
  confidence: number;
  human_pinned: boolean;
}

/** The conversation_memory read-model row shape (subset used by callers). */
export interface ConversationMemory {
  id: string;
  tenant_id: string;
  lead_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  relationship_summary: string | null;
  goals: unknown[];
  pain_points: unknown[];
  objections: unknown[];
  preferences: Record<string, unknown>;
  forbidden_topics: unknown[];
  past_qa: unknown[];
  our_commitments: unknown[];
  their_commitments: unknown[];
  last_meeting_summary: string | null;
  open_tasks: unknown[];
  last_meaningful_touch_at: string | null;
  tone_language: string | null;
  last_rebuilt_at: string | null;
  source_event_watermark: string | null;
}

/** The derived shape a fold produces (the writable subset of conversation_memory). */
export interface DerivedMemory {
  relationship_summary: string | null;
  goals: unknown[];
  pain_points: unknown[];
  objections: unknown[];
  preferences: Record<string, unknown>;
  forbidden_topics: unknown[];
  past_qa: unknown[];
  our_commitments: unknown[];
  their_commitments: unknown[];
  last_meeting_summary: string | null;
  open_tasks: unknown[];
  last_meaningful_touch_at: string | null;
  tone_language: string | null;
  source_event_watermark: string | null;
}

/** Read the current read-model row for a (tenant, lead). Null when none built yet. */
export async function getMemory(tenantId: string, leadId: string): Promise<ConversationMemory | null> {
  const { data, error } = await supabaseAdmin
    .from('conversation_memory')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('lead_id', leadId)
    .maybeSingle();
  if (error) {
    log.warn({ err: error, tenantId, leadId }, 'getMemory: read failed');
    return null;
  }
  return (data as ConversationMemory | null) ?? null;
}

/**
 * Read the CURRENT facts (superseded_by IS NULL) for a lead, newest observation first.
 * With { includeSuperseded } the full history is returned instead (audit views).
 */
export async function getMemoryFacts(
  tenantId: string,
  leadId: string,
  opts: { includeSuperseded?: boolean; sinceObservedAt?: string | null; limit?: number } = {},
): Promise<MemoryFact[]> {
  // Filters first (stay on the filter builder), then order in the terminal await — supabase-js
  // does not expose .is()/.gt() on the post-.order() transform builder.
  let q = supabaseAdmin
    .from('memory_facts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('lead_id', leadId);
  if (!opts.includeSuperseded) q = q.is('superseded_by', null);
  if (opts.sinceObservedAt) q = q.gt('observed_at', opts.sinceObservedAt);
  // Bound the DB read for high-volume leads. Ordering is observed_at DESC, so a cap keeps the
  // NEWEST facts; the caller (pickFactIds) then applies the pinned-first priority + final cap.
  // The fold path deliberately passes no limit so a full rebuild folds every current fact.
  if (opts.limit != null) q = q.limit(Math.max(1, opts.limit));
  const { data, error } = await q.order('observed_at', { ascending: false });
  if (error) {
    log.warn({ err: error, tenantId, leadId }, 'getMemoryFacts: read failed');
    return [];
  }
  return (data as MemoryFact[] | null) ?? [];
}

/** fact_type → which read-model array/field it folds into. */
const ARRAY_TARGETS: Partial<Record<FactType, keyof DerivedMemory>> = {
  goal: 'goals',
  pain_point: 'pain_points',
  objection: 'objections',
  forbidden_topic: 'forbidden_topics',
  qa: 'past_qa',
  commitment_ours: 'our_commitments',
  commitment_theirs: 'their_commitments',
  open_task: 'open_tasks',
};

/**
 * DETERMINISTICALLY fold the current facts of a lead into the read-model shape. NO LLM,
 * NO generation — a pure grouping of observed facts (human-pinned first, then by recency).
 *
 * Incremental: pass the memory's existing source_event_watermark to fold only NEWER facts
 * on top of the prior read-model (the caller supplies `base`). A full rebuild passes no base.
 *
 * persist=false (DEFAULT): return the derived shape WITHOUT touching the DB. This is the
 * night-safe default — nothing writes unless a caller explicitly opts in. rebuildMemory is
 * intentionally NOT wired into any scheduler/tick; the night path never invokes it.
 */
export async function rebuildMemory(
  tenantId: string,
  leadId: string,
  opts: { persist?: boolean; base?: ConversationMemory | null } = {},
): Promise<DerivedMemory> {
  // P3-4: an incremental fold (base + sinceObservedAt) folds only NEWER facts on top of the
  // prior read-model, so it CANNOT retract base entries whose fact was later superseded → stale /
  // duplicate rows. That is only a persistence hazard, so a WRITE always does a clean full rebuild
  // (base=null ⇒ no sinceObservedAt ⇒ fold every current, not-superseded fact). Incremental stays
  // available for a read-only preview (persist=false), which never writes.
  const base = opts.persist ? null : (opts.base ?? null);
  // Incremental: only fold facts observed after the last watermark on top of the base row.
  const facts = await getMemoryFacts(tenantId, leadId, {
    sinceObservedAt: base?.source_event_watermark ?? null,
  });

  const derived: DerivedMemory = {
    relationship_summary: base?.relationship_summary ?? null,
    goals: [...(base?.goals ?? [])],
    pain_points: [...(base?.pain_points ?? [])],
    objections: [...(base?.objections ?? [])],
    preferences: { ...(base?.preferences ?? {}) },
    forbidden_topics: [...(base?.forbidden_topics ?? [])],
    past_qa: [...(base?.past_qa ?? [])],
    our_commitments: [...(base?.our_commitments ?? [])],
    their_commitments: [...(base?.their_commitments ?? [])],
    last_meeting_summary: base?.last_meeting_summary ?? null,
    open_tasks: [...(base?.open_tasks ?? [])],
    last_meaningful_touch_at: base?.last_meaningful_touch_at ?? null,
    tone_language: base?.tone_language ?? null,
    source_event_watermark: base?.source_event_watermark ?? null,
  };

  // Human-pinned facts fold first (they always survive); then newest-observed. getMemoryFacts
  // already returns observed_at DESC, so a stable sort on human_pinned preserves that order.
  const ordered = [...facts].sort((a, b) => Number(b.human_pinned) - Number(a.human_pinned));

  for (const f of ordered) {
    const target = ARRAY_TARGETS[f.fact_type];
    if (target) {
      // P2-1: the raw normalized_value is lead-sourced data — run it through the SAME injection
      // guard message text gets, so no folded fact smuggles control chars / unbounded text.
      (derived[target] as unknown as unknown[]).push({
        value: asSourceValue(f.normalized_value),
        source: f.source,
        observed_at: f.observed_at,
        confidence: f.confidence,
        pinned: f.human_pinned,
        fact_id: f.id,
      });
      continue;
    }
    // Scalar / merge targets: the first fact in `ordered` (pinned, else newest) wins.
    switch (f.fact_type) {
      case 'preference':
        derived.preferences = {
          ...derived.preferences,
          ...(asSourceValue(f.normalized_value ?? {}) as Record<string, unknown>),
        };
        break;
      case 'meeting_summary':
        if (!derived.last_meeting_summary) derived.last_meeting_summary = sanitizedStringValue(f.normalized_value);
        break;
      case 'relationship':
        if (!derived.relationship_summary) derived.relationship_summary = sanitizedStringValue(f.normalized_value);
        break;
      case 'tone_language':
        if (!derived.tone_language) derived.tone_language = sanitizedStringValue(f.normalized_value);
        break;
    }
    // Track the most-recent observation as the meaningful-touch marker.
    if (!derived.last_meaningful_touch_at || f.observed_at > derived.last_meaningful_touch_at) {
      derived.last_meaningful_touch_at = f.observed_at;
    }
  }

  // Advance the watermark to the newest fact folded (facts are observed_at DESC ⇒ [0] is max).
  if (facts.length > 0) {
    const maxObserved = facts[0].observed_at;
    if (!derived.source_event_watermark || maxObserved > derived.source_event_watermark) {
      derived.source_event_watermark = maxObserved;
    }
  }

  if (opts.persist) {
    // Persist path exists for a FUTURE, explicitly-enabled rebuild job. It is never called at
    // night (no scheduler wiring) and defaults off, so this branch does not run at rest.
    const { error } = await supabaseAdmin
      .from('conversation_memory')
      .upsert(
        {
          tenant_id: tenantId,
          lead_id: leadId,
          ...derived,
          last_rebuilt_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,lead_id' },
      );
    if (error) log.warn({ err: error, tenantId, leadId }, 'rebuildMemory: persist failed');
  }

  return derived;
}

/** Pull a display string out of a structured normalized_value (best-effort, deterministic). */
function stringValue(v: Record<string, unknown> | null | undefined): string | null {
  if (!v) return null;
  const candidate = v.text ?? v.summary ?? v.value ?? v.label;
  return typeof candidate === 'string' ? candidate : null;
}

/**
 * P2-1: like stringValue but the result is passed through asSourceData — so the scalar summary
 * fields (relationship_summary / last_meeting_summary / tone_language) folded from lead text are
 * guarded identically to message text. Returns null (not '') when there is no string, so the
 * "first fact wins" guard keeps working.
 */
function sanitizedStringValue(v: Record<string, unknown> | null | undefined): string | null {
  const s = stringValue(v);
  return s == null ? null : asSourceData(s);
}
