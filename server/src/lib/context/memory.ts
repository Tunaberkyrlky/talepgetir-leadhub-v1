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
 * Code-point-safe truncation (L3). A raw String.slice can cut an astral character's UTF-16
 * surrogate pair, leaving a lone surrogate that Postgres JSONB may reject. When the boundary
 * lands right after a high surrogate (U+D800–U+DBFF), back off one code unit so we never emit a
 * half character. Shared by asSourceData (the source-field cap) and assemble.ts's char budget so
 * both truncate identically; the caller charges only the length actually retained.
 */
export function truncateCodePoints(str: string, max: number): string {
  if (max <= 0) return '';
  if (str.length <= max) return str;
  let end = max;
  const boundary = str.charCodeAt(end - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) end -= 1; // boundary split a surrogate pair
  return str.slice(0, end);
}

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
  // Strip C0 (U+0000-U+001F) + DEL + C1 (U+007F-U+009F) control chars, then EVERY Unicode bidi
  // control (\p{Bidi_Control}: ALM U+061C, LRM U+200E, RLM U+200F, the U+202A-U+202E embedding/
  // overrides and the U+2066-U+2069 isolates) that can visually reorder or spoof text → space;
  // then collapse whitespace. The property escape (u flag) also catches ALM/LRM/RLM, which the
  // old explicit ranges missed. eslint no-control-regex is intentional (that IS the guard).
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ')
    .replace(/\p{Bidi_Control}/gu, ' ')
    // Replace any UNPAIRED UTF-16 surrogate with U+FFFD — a high surrogate not followed by a low
    // one, or a low surrogate not preceded by a high one, is malformed and can break a downstream
    // JSONB write. Well-formed astral pairs are left intact; truncateCodePoints below never splits
    // a valid pair, so the returned string stays well-formed. (No u flag: matches raw code units.)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateCodePoints(cleaned, maxChars);
}

/**
 * Deep variant: run asSourceData over every STRING leaf of an arbitrary structured value
 * (a memory_facts normalized_value object, a folded array entry, a preferences map). Numbers,
 * booleans and null pass through untouched. Object KEYS are lead-authored too, so they run
 * through the SAME guard (P2-1) — a key can no longer smuggle bidi/control chars into the
 * read-model. The result is a null-prototype object so a lead-controlled "__proto__"/
 * "constructor" key cannot pollute a prototype, and two keys that collide AFTER sanitizing are
 * folded deterministically (first-seen in Object.entries order wins; later dupes are dropped).
 */
export function asSourceValue(v: unknown, maxChars = MAX_SOURCE_FIELD_CHARS): unknown {
  if (v == null) return v;
  if (typeof v === 'string') return asSourceData(v, maxChars);
  if (Array.isArray(v)) return v.map((x) => asSourceValue(x, maxChars));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const sk = asSourceData(k);
      if (sk in out) continue; // deterministic collision handling: keep the first-seen key
      out[sk] = asSourceValue(val, maxChars);
    }
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

/**
 * Read the current read-model row for a (tenant, lead). Returns null ONLY when no row exists
 * (never built yet). A DB read FAILURE throws (P2-4): a transient error must not masquerade as
 * "no memory" — that would let a persist path overwrite valid memory, or assembly treat a live
 * lead as cold. Callers distinguish "no rows" (null) from "read failed" (throw).
 */
export async function getMemory(tenantId: string, leadId: string): Promise<ConversationMemory | null> {
  const { data, error } = await supabaseAdmin
    .from('conversation_memory')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('lead_id', leadId)
    .maybeSingle();
  if (error) {
    log.warn({ err: error, tenantId, leadId }, 'getMemory: read failed');
    throw new Error(`getMemory: read failed for tenant ${tenantId} lead ${leadId}: ${error.message}`);
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
  // Total, deterministic order (P2-6): observed_at DESC, then id ASC as the final tiebreak so
  // facts sharing an observed_at never reorder between reads (the JS fold applies human_pinned
  // DESC on top of this). facts[0] is still the max observed_at, so the watermark logic holds.
  const { data, error } = await q
    .order('observed_at', { ascending: false })
    .order('id', { ascending: true });
  if (error) {
    // P2-4: a read FAILURE propagates — never silently degrade to an empty fact set, which would
    // let a persisted rebuild erase valid memory or a fold drop real facts on a transient error.
    log.warn({ err: error, tenantId, leadId }, 'getMemoryFacts: read failed');
    throw new Error(`getMemoryFacts: read failed for tenant ${tenantId} lead ${leadId}: ${error.message}`);
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
 * Always a FULL, authoritative fold of the lead's CURRENT facts (no incremental base path):
 * the derived read-model reflects exactly the facts that exist now, so a retraction (deleted
 * facts) correctly clears the corresponding fields rather than leaving stale values behind.
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
  // P3-4 + L8: a rebuild ALWAYS does a clean FULL fold (base=null ⇒ no sinceObservedAt ⇒ fold every
  // current, not-superseded fact). The old persist=false "incremental preview" (fold only NEWER
  // facts on top of opts.base) is dropped for two reasons: an incremental fold cannot retract a base
  // entry whose fact was later superseded → stale/duplicate rows (P3-4), and an incremental base
  // carries no per-key provenance, so a newly-observed pinned/newest preference could not replace an
  // old base value (L8). Full-folding previews too keeps the pinned/newest-wins rule uniform. opts.base
  // is accepted for signature compatibility but no longer consulted.
  // A rebuild always folds every current fact from empty (no base, no sinceObservedAt) — see the
  // L8/P3-4 rationale above. opts.base is accepted for signature compatibility but not consulted.
  const facts = await getMemoryFacts(tenantId, leadId, { sinceObservedAt: null });

  const derived: DerivedMemory = {
    relationship_summary: null,
    goals: [],
    pain_points: [],
    objections: [],
    preferences: {},
    forbidden_topics: [],
    past_qa: [],
    our_commitments: [],
    their_commitments: [],
    last_meeting_summary: null,
    open_tasks: [],
    last_meaningful_touch_at: null,
    tone_language: null,
    source_event_watermark: null,
  };

  // TOTAL order (P2-6) so ties never reorder across rebuilds and scalar winners never flip:
  // human_pinned DESC (operator-curated first), then observed_at DESC (newest), then id ASC as
  // the final deterministic tiebreak. This matches the getMemoryFacts ORDER BY, so the fold is
  // reproducible regardless of sort stability.
  const ordered = [...facts].sort(
    (a, b) =>
      Number(b.human_pinned) - Number(a.human_pinned) ||
      (a.observed_at < b.observed_at ? 1 : a.observed_at > b.observed_at ? -1 : 0) ||
      a.id.localeCompare(b.id),
  );

  for (const f of ordered) {
    // P2-9: advance the meaningful-touch marker for EVERY fact type BEFORE the array-target
    // branch — a lead with only goals/objections/commitments/QA/tasks (all array targets, which
    // `continue` below) must still get a correct last_meaningful_touch_at, not a null/stale one.
    if (!derived.last_meaningful_touch_at || f.observed_at > derived.last_meaningful_touch_at) {
      derived.last_meaningful_touch_at = f.observed_at;
    }
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
        // P2-7: facts are processed highest-priority first, so spread the NEW (lower-priority)
        // fact UNDER the already-accumulated prefs — the earlier (pinned/newest) value wins each
        // key. (The old order spread the new fact ON TOP, letting the LAST-processed, lowest-
        // priority fact clobber a preferred value.) Spread uses [[Define]], so a lead-authored
        // "__proto__" key stays an inert own property and cannot pollute a prototype.
        derived.preferences = {
          ...(asSourceValue(f.normalized_value ?? {}) as Record<string, unknown>),
          ...derived.preferences,
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
    // (last_meaningful_touch_at is advanced at the top of the loop for every fact type — P2-9.)
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
    //
    // rebuildMemory is a FULL, authoritative fold of the lead's CURRENT facts, so the derived
    // read-model is written UNCONDITIONALLY. A watermark-ORDERING guard cannot gate this: a
    // legitimate retraction (the newest facts were deleted) folds to a LOWER-or-null watermark,
    // and skipping that write on `next < stored` (or `next IS NULL`) would strand the deleted
    // facts in the read-model. getMemoryFacts already THROWS on a read failure (P2-4), so a
    // transient DB error aborts the fold BEFORE this point — an empty fold here means the facts
    // really are gone and the read-model must reflect that.
    //
    // BACKLOG TODO (P2-5): concurrent full rebuilds are last-writer-wins. A fully race-free
    // version needs a tenant+lead-scoped RPC doing read/fold/upsert under an advisory lock (or a
    // conditional `ON CONFLICT ... WHERE` upsert, which PostgREST cannot express). persist is
    // false + unwired today, so last-writer-wins is acceptable until that RPC exists.
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
