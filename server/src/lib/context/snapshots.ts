/**
 * Generation context snapshots (v3 §6.10/§10.5, §26 lib/context/snapshots.ts — Phase 5 C4).
 *
 * writeSnapshot() records the immutable "why was THIS message generated this way" audit row:
 * the exact assembled context (§10.5) + the produced message. It is WRITE-ONCE — the DB
 * immutability trigger (mig 128) blocks any later change to the generative columns, so a
 * snapshot is a faithful, tamper-evident record of a single generation.
 *
 * GUARDRAIL: writing a snapshot performs NO send and NO LLM — it only persists context that
 * was already assembled deterministically. At night nothing calls this (the email node stays
 * unwired); it exists as the audit seam a LIVE path would use.
 *
 * Tenant scoping: supabaseAdmin (service role) with an explicit tenant_id; the mig-128 fence
 * trigger backstops every FK to the same tenant.
 */
import { supabaseAdmin } from '../supabase.js';
import { createLogger } from '../logger.js';

const log = createLogger('lib:context:snapshots');

/** Human decision recorded on a snapshot (mirrors approval_state CHECK in mig 128). */
export type ApprovalState = 'draft' | 'pending' | 'approved' | 'rejected' | 'edited' | 'sent';

/** Everything writeSnapshot persists. Links are all optional (a bare audit row still inserts). */
export interface SnapshotInput {
  tenantId: string;
  messageId?: string | null;
  automationActionId?: string | null;
  leadId?: string | null;
  memoryId?: string | null;
  promptRecipeVersion?: string | null;
  selectedMemoryFactIds?: string[];
  recentTurns?: unknown[];
  meetingSummaryVersion?: string | null;
  assetEngagement?: Record<string, unknown>;
  openCommitments?: unknown[];
  generatedMessage?: string | null;
  humanEditDiff?: Record<string, unknown>;
  approvalState?: ApprovalState;
}

export interface WriteSnapshotResult {
  ok: boolean;
  id: string | null;
  reason?: string;
}

/**
 * Insert one immutable snapshot. Never updates (the generative columns are trigger-protected).
 * Returns the new id; a write miss returns { ok:false } — the caller decides whether an audit
 * gap is tolerable (it never affects the send itself, which does not happen at night).
 */
export async function writeSnapshot(input: SnapshotInput): Promise<WriteSnapshotResult> {
  const { data, error } = await supabaseAdmin
    .from('generation_context_snapshots')
    .insert({
      tenant_id: input.tenantId,
      message_id: input.messageId ?? null,
      automation_action_id: input.automationActionId ?? null,
      lead_id: input.leadId ?? null,
      memory_id: input.memoryId ?? null,
      prompt_recipe_version: input.promptRecipeVersion ?? null,
      selected_memory_fact_ids: input.selectedMemoryFactIds ?? [],
      recent_turns: input.recentTurns ?? [],
      meeting_summary_version: input.meetingSummaryVersion ?? null,
      asset_engagement: input.assetEngagement ?? {},
      open_commitments: input.openCommitments ?? [],
      generated_message: input.generatedMessage ?? null,
      human_edit_diff: input.humanEditDiff ?? {},
      approval_state: input.approvalState ?? 'draft',
    })
    .select('id')
    .maybeSingle();
  if (error) {
    log.warn({ err: error, tenantId: input.tenantId, messageId: input.messageId }, 'writeSnapshot: insert failed');
    return { ok: false, id: null, reason: error.message };
  }
  const id = (data as { id?: string } | null)?.id ?? null;
  return { ok: id != null, id };
}

/** The snapshot row shape (subset an inspector reads back). */
export interface GenerationContextSnapshot {
  id: string;
  tenant_id: string;
  message_id: string | null;
  automation_action_id: string | null;
  lead_id: string | null;
  memory_id: string | null;
  prompt_recipe_version: string | null;
  selected_memory_fact_ids: string[];
  recent_turns: unknown[];
  meeting_summary_version: string | null;
  asset_engagement: Record<string, unknown>;
  open_commitments: unknown[];
  generated_message: string | null;
  human_edit_diff: Record<string, unknown>;
  approval_state: ApprovalState;
  created_at: string;
}

/** Read the snapshot that produced a given message ("why is this message the way it is"). */
export async function getSnapshotForMessage(
  tenantId: string,
  messageId: string,
): Promise<GenerationContextSnapshot | null> {
  const { data, error } = await supabaseAdmin
    .from('generation_context_snapshots')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('message_id', messageId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    log.warn({ err: error, tenantId, messageId }, 'getSnapshotForMessage: read failed');
    return null;
  }
  return (data as GenerationContextSnapshot | null) ?? null;
}

/** Read a lead's snapshot timeline, newest first (audit / inspector view). */
export async function listSnapshotsForLead(
  tenantId: string,
  leadId: string,
  limit = 20,
): Promise<GenerationContextSnapshot[]> {
  const { data, error } = await supabaseAdmin
    .from('generation_context_snapshots')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    log.warn({ err: error, tenantId, leadId }, 'listSnapshotsForLead: read failed');
    return [];
  }
  return (data as GenerationContextSnapshot[] | null) ?? [];
}
