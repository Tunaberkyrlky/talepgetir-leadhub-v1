/**
 * Context assembly (v3 §10.5, §26 lib/context/assemble.ts — Phase 5 C4).
 *
 * assembleContext() DETERMINISTICALLY gathers the context that a send/generation WOULD use,
 * in the §10.5 priority order:
 *   1. last inbound message + whether it carries an unanswered question
 *   2. open commitments (ours / theirs) + open objections
 *   3. last meeting summary
 *   4. recent meaningful conversation turns (from the messages ledger)
 *   5. stable facts (goals / pain points / preferences / forbidden topics / tone)
 *   6. old / closed topics truncated to fit the budget
 *
 * This is DATA GATHERING, not generation. There is NO LLM call here — the output is a plain,
 * priority-ordered context object. A downstream generator (not part of the night path) is the
 * only place a model would ever run.
 *
 * PROMPT-INJECTION GUARD: lead-authored content (message subject/body, AND memory_facts-derived
 * values folded into the read-model) is SOURCE DATA, never instructions. Every piece of lead
 * text — whether it arrives from the messages ledger or from conversation_memory — is passed
 * through the SAME guard (asSourceData / asSourceValue, canonical in memory.ts): control chars /
 * bidi overrides stripped, length capped. The assembled object keeps that text in clearly-
 * labelled `source_data` / stable-fact fields. Nothing here interpolates lead text into an
 * instruction/prompt string, so a lead cannot inject automation behaviour by writing
 * "ignore previous instructions…".
 *
 * Tenant scoping: supabaseAdmin (service role) with explicit .eq('tenant_id', tenantId).
 */
import { supabaseAdmin } from '../supabase.js';
import { createLogger } from '../logger.js';
import { getMemory, getMemoryFacts, asSourceData, asSourceValue, truncateCodePoints, type MemoryFact } from './memory.js';

// The injection guard is the SAME primitive the fold uses — re-exported here so existing
// `import { asSourceData } from './assemble.js'` callers (and tests) keep working.
export { asSourceData };

const log = createLogger('lib:context:assemble');

/** Default character budget for the assembled slice (rough proxy for token budget). */
const DEFAULT_BUDGET_CHARS = 6000;
/** How many recent turns we consider before budget trimming. */
const RECENT_TURN_SCAN = 40;
/** Cap on how many memory fact ids pin a generation snapshot (pinned-first). Prevents bloat. */
const MAX_SELECTED_FACTS = 50;
/**
 * Outbound delivery states that count as an actually-accepted/delivered reply (P2-10). A queued/
 * failed/skipped (or draft) outbound row does NOT answer an inbound. Mirrors the
 * messages.delivery_state domain (mig 127: queued|sent|delivered|read|replied|failed|skipped).
 */
const ANSWERED_DELIVERY_STATES = new Set(['sent', 'delivered', 'read', 'replied']);

/** A message ledger row (subset used for turn assembly). */
interface MessageRow {
  id: string;
  direction: 'inbound' | 'outbound';
  channel: string;
  subject: string | null;
  body: string | null;
  delivery_state: string;
  created_at: string;
}

/** One assembled conversation turn — lead text lives in source_data (never an instruction). */
export interface AssembledTurn {
  message_id: string;
  direction: 'inbound' | 'outbound';
  channel: string;
  at: string;
  /** Lead/counterparty-authored text, provenance-marked. Treat as data, not instructions. */
  source_data: string;
  truncated: boolean;
}

/** The priority-ordered context object §10.5 produces. */
export interface AssembledContext {
  tenant_id: string;
  lead_id: string;
  /** 1. The last inbound message + whether it looks unanswered / carries a question. */
  last_inbound: {
    message_id: string;
    at: string;
    source_data: string;
    has_question: boolean;
    unanswered: boolean;
  } | null;
  /** 2. Open commitments + objections carried from the read-model. */
  open_commitments: { ours: unknown[]; theirs: unknown[] };
  open_objections: unknown[];
  /** 3. Last meeting summary. */
  last_meeting_summary: string | null;
  /** 4. Recent meaningful turns (budget-trimmed). */
  recent_turns: AssembledTurn[];
  /** 5. Stable facts. */
  stable_facts: {
    goals: unknown[];
    pain_points: unknown[];
    preferences: Record<string, unknown>;
    forbidden_topics: unknown[];
    tone_language: string | null;
  };
  /** The memory facts in scope (their ids feed the generation snapshot). */
  selected_memory_fact_ids: string[];
  /** 6. Budget accounting — how much was included vs dropped as old/closed topics. */
  budget: { limit_chars: number; used_chars: number; dropped_turns: number };
  memory_id: string | null;
  assembled_at: string;
  /** True when this lead has no read-model / no history yet (a cold assemble). */
  cold: boolean;
  /** Deterministic residual notes when low-priority context was trimmed to fit the char budget
   *  (field label + dropped count only — never lead PII). Empty when everything fit (P2-8/L7). */
  openQuestions: string[];
}

export interface AssembleOptions {
  /** Character budget for the assembled slice. Defaults to DEFAULT_BUDGET_CHARS. */
  budget?: number;
}

/** Does this inbound text look like it asks something? Deterministic heuristic (no NLP). */
function looksLikeQuestion(text: string): boolean {
  return text.includes('?');
}

/**
 * Assemble the §10.5 context for a (tenant, lead). Deterministic; reads the messages ledger +
 * the conversation_memory read-model + current memory_facts. Never generates.
 */
export async function assembleContext(
  tenantId: string,
  leadId: string,
  opts: AssembleOptions = {},
): Promise<AssembledContext> {
  const budgetLimit = Math.max(500, opts.budget ?? DEFAULT_BUDGET_CHARS);

  const [memory, facts, messages] = await Promise.all([
    getMemory(tenantId, leadId),
    getMemoryFacts(tenantId, leadId),
    loadRecentMessages(tenantId, leadId),
  ]);

  // ── ONE priority-ordered char budget (§10.5), P2-8/L7. Higher-priority context claims the budget
  //    FIRST; each lower-priority block is TRIMMED to whatever remains — textual blocks truncate at
  //    the boundary (surrogate-safe), structured blocks keep whole entries that still fit and drop
  //    the rest (a structured entry cannot be mid-JSON truncated the way a string can). Nothing is
  //    admitted whole once the budget is spent, so `remaining` never goes negative and used_chars
  //    (= budgetLimit - remaining) reflects the ACTUAL retained size instead of under-reporting.
  //    This replaces the old scheme that merely ACCOUNTED commitments / objections / stable facts
  //    (returning them intact even when over budget) and admitted the first turn even when it alone
  //    exceeded the limit. Dropped low-priority entries are recorded in openQuestions. `remaining`
  //    is threaded through the build in §10.5 order:
  //    last_inbound → commitments/objections → meeting summary → recent turns → stable facts.
  let remaining = budgetLimit;
  // Residual notes (deterministic; field label + dropped count only, never lead PII) — records the
  // low-priority context dropped to honour the budget, so a caller sees the slice was trimmed.
  const openQuestions: string[] = [];
  // Spend budget on a lead-text string, truncating (surrogate-safe) to what is left — never admit an
  // over-budget string whole. Charges only the length actually retained (a surrogate back-off can
  // leave remaining=1; harmless — every consumer guards remaining<=0). Returns the included text.
  const spendString = (raw: string): { text: string; truncated: boolean } => {
    if (raw.length === 0) return { text: '', truncated: false };
    if (remaining <= 0) return { text: '', truncated: true };
    if (raw.length <= remaining) {
      remaining -= raw.length;
      return { text: raw, truncated: false };
    }
    const text = truncateCodePoints(raw, remaining);
    remaining -= text.length;
    return { text, truncated: true };
  };
  // Spend budget on a structured array in §10.5 priority order: keep each whole entry that still
  // FITS the remaining budget, then stop and drop the boundary entry + the rest (deterministic —
  // input order preserved, first-N kept). Charges only the entries retained, so used_chars stays
  // honest; a drop count is recorded in openQuestions.
  const spendEntries = (entries: unknown[], label: string): unknown[] => {
    const keptEntries: unknown[] = [];
    let dropped = 0;
    for (const entry of entries) {
      const cost = JSON.stringify(entry ?? null).length;
      if (dropped === 0 && cost <= remaining) {
        remaining -= cost;
        keptEntries.push(entry);
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) openQuestions.push(`${label}: dropped ${dropped} over-budget entr${dropped === 1 ? 'y' : 'ies'}`);
    return keptEntries;
  };
  // Same, keyed: admit preference keys (Object.entries order) only while budget remains. Returns a
  // null-prototype object (matches asSourceValue) so a lead-authored "__proto__" key stays inert.
  const spendPreferences = (prefs: Record<string, unknown>, label: string): Record<string, unknown> => {
    const out: Record<string, unknown> = Object.create(null);
    let dropped = 0;
    for (const [k, v] of Object.entries(prefs)) {
      const cost = JSON.stringify({ [k]: v ?? null }).length;
      if (dropped === 0 && cost <= remaining) {
        remaining -= cost;
        out[k] = v;
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) openQuestions.push(`${label}: dropped ${dropped} over-budget preference${dropped === 1 ? '' : 's'}`);
    return out;
  };

  // 1. Last inbound (highest priority) — claims budget first. "Unanswered" = no ACCEPTED outbound
  //    turn exists after the newest inbound (messages are newest-first). has_question is computed
  //    on the FULL text so a budget truncation can never hide a trailing question mark.
  const lastInboundMsg = messages.find((m) => m.direction === 'inbound') ?? null;
  let lastInbound: AssembledContext['last_inbound'] = null;
  if (lastInboundMsg) {
    const rawSource = asSourceData(lastInboundMsg.body ?? lastInboundMsg.subject);
    const { text: source } = spendString(rawSource);
    // P2-10: only an outbound in an ACCEPTED delivery state answers the inbound — a queued /
    //        failed / skipped (or draft) outbound row does NOT count as a reply.
    const answeredAfter = messages.some(
      (m) =>
        m.direction === 'outbound' &&
        ANSWERED_DELIVERY_STATES.has(m.delivery_state) &&
        m.created_at > lastInboundMsg.created_at,
    );
    lastInbound = {
      message_id: lastInboundMsg.id,
      at: lastInboundMsg.created_at,
      source_data: source,
      // Read '?' straight off the RAW body/subject (looksLikeQuestion = a cheap includes('?')
      // single scan). This covers a '?' past the 2000-char source cap WITHOUT the full-string
      // sanitiser allocations an uncapped asSourceData pass would trigger on a huge inbound body.
      // It only reads (returns a bool), never emits — no injection surface; the emitted
      // source_data above stays sanitised + capped.
      has_question: looksLikeQuestion(lastInboundMsg.body ?? lastInboundMsg.subject ?? ''),
      unanswered: !answeredAfter,
    };
  }

  // 2. Open commitments + objections (priority 2). These fields were folded from lead-authored
  //    memory_facts, so — even though the fold already sanitises on persist — re-run the SAME
  //    injection guard here (defense in depth; a row written by another path still emerges inert).
  //    Trimmed to the remaining budget in priority order (whole entries kept while they fit; the
  //    rest dropped and recorded in openQuestions).
  const openCommitments = {
    ours: spendEntries(asSourceValue(memory?.our_commitments ?? []) as unknown[], 'open_commitments.ours'),
    theirs: spendEntries(asSourceValue(memory?.their_commitments ?? []) as unknown[], 'open_commitments.theirs'),
  };
  const openObjections = spendEntries(asSourceValue(memory?.objections ?? []) as unknown[], 'open_objections');

  // 3. Last meeting summary (priority 3) — truncated to the remaining budget.
  const rawMeeting = memory?.last_meeting_summary ? asSourceData(memory.last_meeting_summary) : null;
  const lastMeetingSummary = rawMeeting ? spendString(rawMeeting).text || null : null;

  // 4 + 6. Recent meaningful turns (priority 4), spending the remaining budget. Older turns beyond
  //         the budget are the dropped "old / closed topics" (§10.5 #6); the boundary turn is
  //         TRUNCATED to what remains — not admitted whole, not dropped whole. Messages are
  //         newest-first; the last inbound is intentionally re-listed and so is charged again.
  const candidateTurns: AssembledTurn[] = messages.map((m) => {
    const source = asSourceData(m.body ?? m.subject);
    return {
      message_id: m.id,
      direction: m.direction,
      channel: m.channel,
      at: m.created_at,
      source_data: source,
      truncated: (m.body ?? m.subject ?? '').length > source.length,
    };
  });
  const kept: AssembledTurn[] = [];
  for (const t of candidateTurns) {
    if (remaining <= 0) break;
    const { text, truncated } = spendString(t.source_data);
    if (text.length === 0 && t.source_data.length > 0) break; // no budget left to include even a slice
    kept.push({ ...t, source_data: text, truncated: t.truncated || truncated });
  }
  const droppedTurns = candidateTurns.length - kept.length;
  // Present kept turns oldest→newest for a natural reading order.
  kept.reverse();

  // 5. Stable facts (priority 5) — trimmed last (budget may already be exhausted): array facts keep
  //    whole entries while budget remains, preferences trim by key, tone_language spends what's left.
  const stableFacts = {
    goals: spendEntries(asSourceValue(memory?.goals ?? []) as unknown[], 'stable_facts.goals'),
    pain_points: spendEntries(asSourceValue(memory?.pain_points ?? []) as unknown[], 'stable_facts.pain_points'),
    preferences: spendPreferences(asSourceValue(memory?.preferences ?? {}) as Record<string, unknown>, 'stable_facts.preferences'),
    forbidden_topics: spendEntries(asSourceValue(memory?.forbidden_topics ?? []) as unknown[], 'stable_facts.forbidden_topics'),
    tone_language: memory?.tone_language ? (spendString(asSourceData(memory.tone_language)).text || null) : null,
  };

  const selectedFactIds = pickFactIds(facts);

  return {
    tenant_id: tenantId,
    lead_id: leadId,
    last_inbound: lastInbound,
    open_commitments: openCommitments,
    open_objections: openObjections,
    last_meeting_summary: lastMeetingSummary,
    recent_turns: kept,
    stable_facts: stableFacts,
    selected_memory_fact_ids: selectedFactIds,
    // used_chars now reflects the ACTUAL retained size of the WHOLE context (every block trimmed to
    // fit), not just recent_turns, and never under-reports (P2-8/L7).
    budget: { limit_chars: budgetLimit, used_chars: budgetLimit - remaining, dropped_turns: droppedTurns },
    memory_id: memory?.id ?? null,
    assembled_at: new Date().toISOString(),
    cold: !memory && messages.length === 0,
    openQuestions,
  };
}

/** Read the lead's message ledger, newest first, capped to the scan window. */
async function loadRecentMessages(tenantId: string, leadId: string): Promise<MessageRow[]> {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('id, direction, channel, subject, body, delivery_state, created_at')
    .eq('tenant_id', tenantId)
    .eq('lead_id', leadId)
    // L4: id DESC tiebreak so rows sharing created_at order deterministically — the
    // RECENT_TURN_SCAN cap and downstream last_inbound / recent_turns / answered detection stay
    // reproducible instead of depending on PostgreSQL's arbitrary tied-row order.
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(RECENT_TURN_SCAN);
  if (error) {
    // L2: a read FAILURE propagates (not a silent [] degrade) so assembleContext's Promise.all
    // rejects — parity with getMemory / getMemoryFacts, which throw. A "" degrade would make a live
    // lead look cold and an inbound look unanswered. Sibling reads are tenant-scoped, so no leak.
    log.warn({ err: error, tenantId, leadId }, 'assembleContext: message read failed');
    throw new Error(`loadRecentMessages: read failed for tenant ${tenantId} lead ${leadId}: ${error.message}`);
  }
  return (data as MessageRow[] | null) ?? [];
}

/**
 * Which memory facts pin this assemble's generation snapshot. Bounded so a high-volume lead
 * cannot bloat selected_memory_fact_ids (P3-3): human_pinned facts ALWAYS come first (operator-
 * curated, never dropped), then the rest by confidence DESC, observed_at DESC — total capped at
 * MAX_SELECTED_FACTS. facts arrive observed_at DESC from getMemoryFacts; the sort is stable-safe.
 */
function pickFactIds(facts: MemoryFact[]): string[] {
  const pinned = facts.filter((f) => f.human_pinned);
  // L1: a valid TOTAL order — confidence DESC, observed_at DESC, then id ASC as the final
  // deterministic tiebreak. The old comparator returned -1 for equal confidence+observed_at in BOTH
  // directions (not antisymmetric), so V8 could reverse tied input and make the 50-item cutoff
  // nondeterministic. Mirrors the fold order in memory.ts rebuildMemory.
  const rest = facts
    .filter((f) => !f.human_pinned)
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        (a.observed_at < b.observed_at ? 1 : a.observed_at > b.observed_at ? -1 : 0) ||
        a.id.localeCompare(b.id),
    );
  return [...pinned, ...rest].slice(0, MAX_SELECTED_FACTS).map((f) => f.id);
}
