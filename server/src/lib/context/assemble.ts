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
import { getMemory, getMemoryFacts, asSourceData, asSourceValue, type MemoryFact } from './memory.js';

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

  // 1. Last inbound + unanswered/question detection. "Unanswered" = no outbound turn exists
  //    after the newest inbound (messages are ordered newest-first).
  const lastInboundMsg = messages.find((m) => m.direction === 'inbound') ?? null;
  let lastInbound: AssembledContext['last_inbound'] = null;
  if (lastInboundMsg) {
    const source = asSourceData(lastInboundMsg.body ?? lastInboundMsg.subject);
    const answeredAfter = messages.some(
      (m) => m.direction === 'outbound' && m.created_at > lastInboundMsg.created_at,
    );
    lastInbound = {
      message_id: lastInboundMsg.id,
      at: lastInboundMsg.created_at,
      source_data: source,
      has_question: looksLikeQuestion(source),
      unanswered: !answeredAfter,
    };
  }

  // 2-5. Read-model derived slices. These fields were folded from lead-authored memory_facts,
  //       so — even though the fold already sanitises on persist — re-run the SAME injection
  //       guard here (defense in depth: a row persisted before the guard existed, or written by
  //       another path, still emerges inert). No lead text becomes an instruction.
  const openCommitments = {
    ours: asSourceValue(memory?.our_commitments ?? []) as unknown[],
    theirs: asSourceValue(memory?.their_commitments ?? []) as unknown[],
  };
  const openObjections = asSourceValue(memory?.objections ?? []) as unknown[];
  const lastMeetingSummary = memory?.last_meeting_summary ? asSourceData(memory.last_meeting_summary) : null;
  const stableFacts = {
    goals: asSourceValue(memory?.goals ?? []) as unknown[],
    pain_points: asSourceValue(memory?.pain_points ?? []) as unknown[],
    preferences: asSourceValue(memory?.preferences ?? {}) as Record<string, unknown>,
    forbidden_topics: asSourceValue(memory?.forbidden_topics ?? []) as unknown[],
    tone_language: memory?.tone_language ? asSourceData(memory.tone_language) : null,
  };

  // 4 + 6. Recent meaningful turns, trimmed to the budget (drop OLDEST first — §10.5 "old /
  //        closed topics truncated"). Each turn's lead text is inert source-data.
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
  const { kept, droppedTurns, usedChars } = trimToBudget(candidateTurns, budgetLimit);
  // Present kept turns oldest→newest for a natural reading order.
  kept.reverse();

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
    budget: { limit_chars: budgetLimit, used_chars: usedChars, dropped_turns: droppedTurns },
    memory_id: memory?.id ?? null,
    assembled_at: new Date().toISOString(),
    cold: !memory && messages.length === 0,
  };
}

/** Read the lead's message ledger, newest first, capped to the scan window. */
async function loadRecentMessages(tenantId: string, leadId: string): Promise<MessageRow[]> {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('id, direction, channel, subject, body, delivery_state, created_at')
    .eq('tenant_id', tenantId)
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(RECENT_TURN_SCAN);
  if (error) {
    log.warn({ err: error, tenantId, leadId }, 'assembleContext: message read failed');
    return [];
  }
  return (data as MessageRow[] | null) ?? [];
}

/**
 * Keep newest turns until the char budget is exhausted; the remaining (oldest) turns are the
 * dropped "old / closed topics". `turns` arrives newest-first, so we walk forward and stop.
 */
function trimToBudget(
  turns: AssembledTurn[],
  budgetChars: number,
): { kept: AssembledTurn[]; droppedTurns: number; usedChars: number } {
  const kept: AssembledTurn[] = [];
  let used = 0;
  for (const t of turns) {
    const cost = t.source_data.length + 32; // small per-turn overhead for direction/channel/at
    if (used + cost > budgetChars && kept.length > 0) break;
    kept.push(t);
    used += cost;
  }
  return { kept, droppedTurns: turns.length - kept.length, usedChars: used };
}

/**
 * Which memory facts pin this assemble's generation snapshot. Bounded so a high-volume lead
 * cannot bloat selected_memory_fact_ids (P3-3): human_pinned facts ALWAYS come first (operator-
 * curated, never dropped), then the rest by confidence DESC, observed_at DESC — total capped at
 * MAX_SELECTED_FACTS. facts arrive observed_at DESC from getMemoryFacts; the sort is stable-safe.
 */
function pickFactIds(facts: MemoryFact[]): string[] {
  const pinned = facts.filter((f) => f.human_pinned);
  const rest = facts
    .filter((f) => !f.human_pinned)
    .sort((a, b) => b.confidence - a.confidence || (a.observed_at < b.observed_at ? 1 : -1));
  return [...pinned, ...rest].slice(0, MAX_SELECTED_FACTS).map((f) => f.id);
}
