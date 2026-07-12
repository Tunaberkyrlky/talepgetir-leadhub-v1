/**
 * Automation runtime engine (v3 §6.6, §10.1, §10.3, §10.4).
 *
 * The state machine that drives a run through an immutable graph:
 *   claimAndStart(event) — match active automations to a claimed domain event, create
 *                          a run pinned to the automation's current_version, seat it at
 *                          the graph entry node.
 *   stepRun(runId)       — execute the current node exactly once (idempotent via the
 *                          automation_actions ledger), advance the cursor (next / wait /
 *                          stop / goal), and enforce stop_conditions.
 *   runtimeTick()        — FLAG-GATED entry. With AUTOMATION_WORKER_ENABLED unset it is
 *                          a NO-OP: nothing is claimed, no run steps, nothing is sent.
 *                          It is NOT wired into any live loop (see worker guardrail).
 *
 * VERSIONING (§10.3): a run pins automation_versions.version at claim; stepRun reads
 * that frozen graph, so publishing a new version (bumping automations.current_version)
 * never rewrites a run already in flight.
 *
 * IDEMPOTENCY (§10.4): each node execution writes ONE ledger row keyed by
 * (run_id, node_key, idempotency_key). A re-step of the same node collides on the
 * UNIQUE (23505) and short-circuits WITHOUT re-performing the side-effect — so a
 * CRM mutation or a (future) send happens at-most-once.
 *
 * GUARDRAIL: send-capable nodes resolve to skipped stubs (nodes/stubs.ts); no external
 * e-mail/message/call/webhook is triggered this round. The live tick is off by default.
 */
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../supabase.js';
import { createLogger } from '../logger.js';
import { getNodeExecutor } from './nodes/index.js';
import { evaluatePredicate } from './predicate.js';
import { claimBatch, markEvent, type ClaimedEvent } from './outbox.js';
import type {
  AutomationGraph,
  AutomationRunRow,
  GraphNode,
  NodeContext,
  NodeResult,
  PredicateExpr,
} from './types.js';

const log = createLogger('lib:automation:runtime');

/** A run's lease is reclaimable after this idle window (crashed-stepper recovery). */
const LEASE_TTL_MS = 5 * 60 * 1000;

/** Reserved run.context key holding per-run automation meta (actor, stop, goal). */
interface RunMeta {
  actor_id: string | null;
  stop_conditions: PredicateExpr[];
  goal_event: string | null;
}

function readMeta(context: Record<string, unknown>): RunMeta {
  const meta = (context.__automation ?? {}) as Partial<RunMeta>;
  return {
    actor_id: typeof meta.actor_id === 'string' ? meta.actor_id : null,
    stop_conditions: Array.isArray(meta.stop_conditions) ? (meta.stop_conditions as PredicateExpr[]) : [],
    goal_event: typeof meta.goal_event === 'string' ? meta.goal_event : null,
  };
}

/** The deterministic idempotency key for a node execution: one action per (run,node). */
function idempotencyKey(runId: string, nodeKey: string): string {
  return `${runId}:${nodeKey}`;
}

/** Map an event aggregate to the run's subject columns. */
function subjectFromEvent(ev: ClaimedEvent): { lead_id: string | null; company_id: string | null } {
  if (ev.aggregate_type === 'lead' && ev.aggregate_id) return { lead_id: ev.aggregate_id, company_id: null };
  if (ev.aggregate_type === 'company' && ev.aggregate_id) return { lead_id: null, company_id: ev.aggregate_id };
  return { lead_id: null, company_id: null };
}

/** Load the pinned, immutable graph for a run's (automation, version). */
async function loadGraph(automationId: string, version: number): Promise<AutomationGraph | null> {
  const { data, error } = await supabaseAdmin
    .from('automation_versions')
    .select('graph')
    .eq('automation_id', automationId)
    .eq('version', version)
    .maybeSingle();
  if (error || !data) {
    log.warn({ err: error, automationId, version }, 'loadGraph miss');
    return null;
  }
  return data.graph as AutomationGraph;
}

/** Row → the subset the engine carries. */
function toRunRow(r: Record<string, unknown>): AutomationRunRow {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    automation_id: r.automation_id as string,
    version: r.version as number,
    lead_id: (r.lead_id as string | null) ?? null,
    company_id: (r.company_id as string | null) ?? null,
    current_node_key: (r.current_node_key as string | null) ?? null,
    status: r.status as AutomationRunRow['status'],
    goal_reached: !!r.goal_reached,
    context: (r.context as Record<string, unknown>) ?? {},
  };
}

// ── claimAndStart ─────────────────────────────────────────────────────────────
/**
 * For a claimed domain event, find every ACTIVE automation whose trigger matches and
 * whose entry_criteria passes, and create one run each (pinned to current_version,
 * seated at the graph entry). Returns the created run ids. Creates runs only — stepping
 * is the tick's job (also flag-gated). De-dups a run per (automation, subject) that is
 * still in flight so a repeat event does not double-enroll.
 */
export async function claimAndStart(ev: ClaimedEvent): Promise<string[]> {
  const { data: autos, error } = await supabaseAdmin
    .from('automations')
    .select('id, current_version, entry_criteria, stop_conditions, goal_event, created_by')
    .eq('tenant_id', ev.tenant_id)
    .eq('trigger_event', ev.event_type)
    .eq('status', 'active');
  if (error) {
    log.warn({ err: error, eventId: ev.id }, 'claimAndStart: automations query failed');
    return [];
  }

  const created: string[] = [];
  const eventCtx = { event: ev.payload ?? {} };
  const subject = subjectFromEvent(ev);

  for (const a of autos ?? []) {
    const version = a.current_version as number | null;
    if (version == null) continue; // draft-only automation, no published graph

    if (!evaluatePredicate(a.entry_criteria as PredicateExpr, eventCtx)) continue;

    const graph = await loadGraph(a.id as string, version);
    if (!graph || !graph.entry || !graph.nodes?.[graph.entry]) {
      log.warn({ automationId: a.id, version }, 'claimAndStart: unusable graph, skipping');
      continue;
    }

    // In-flight de-dup: skip if a non-terminal run for this (automation, subject) exists.
    if (subject.lead_id || subject.company_id) {
      let dq = supabaseAdmin
        .from('automation_runs')
        .select('id')
        .eq('tenant_id', ev.tenant_id)
        .eq('automation_id', a.id)
        .in('status', ['running', 'waiting', 'paused']);
      dq = subject.lead_id ? dq.eq('lead_id', subject.lead_id) : dq.eq('company_id', subject.company_id);
      const { data: existing } = await dq.limit(1);
      if (existing && existing.length > 0) continue;
    }

    const context = {
      event: ev.payload ?? {},
      __automation: {
        actor_id: (a.created_by as string | null) ?? null,
        stop_conditions: (a.stop_conditions as PredicateExpr[]) ?? [],
        goal_event: (a.goal_event as string | null) ?? null,
      },
    };

    const { data: run, error: insErr } = await supabaseAdmin
      .from('automation_runs')
      .insert({
        tenant_id: ev.tenant_id,
        automation_id: a.id,
        version,
        lead_id: subject.lead_id,
        company_id: subject.company_id,
        trigger_event_id: ev.id,
        current_node_key: graph.entry,
        status: 'running',
        context,
      })
      .select('id')
      .maybeSingle();
    if (insErr) {
      // A concurrent event for the same (tenant, automation, subject) may have already
      // opened a non-terminal run; the partial UNIQUE (uq_automation_runs_inflight_*)
      // then rejects this one with 23505. That is the de-dup working — skip benignly,
      // do NOT double-enroll and do NOT treat it as an error.
      if (insErr.code === '23505') {
        log.debug({ automationId: a.id }, 'claimAndStart: in-flight run exists, skipping');
        continue;
      }
      log.warn({ err: insErr, automationId: a.id }, 'claimAndStart: run insert failed');
      continue;
    }
    if (run?.id) created.push(run.id as string);
  }

  return created;
}

// ── stepRun ───────────────────────────────────────────────────────────────────
/**
 * Execute the run's current node exactly once and advance the cursor. Idempotent: the
 * ledger row keyed by (run, node) is inserted first; a collision (already ran) short-
 * circuits without re-performing the side-effect. Returns the run's status after the
 * step (or a terminal marker) — pure orchestration, no scheduling loop.
 */
export async function stepRun(runId: string): Promise<{ status: string; node?: string }> {
  const { data: rawRun, error: runErr } = await supabaseAdmin
    .from('automation_runs')
    .select('id')
    .eq('id', runId)
    .maybeSingle();
  if (runErr || !rawRun) {
    log.warn({ err: runErr, runId }, 'stepRun: run not found');
    return { status: 'missing' };
  }

  // ── Run-level lease (P1) ───────────────────────────────────────────────────
  // Claim the run BEFORE touching it, so at most ONE stepper advances a given run at a
  // time. Claimable only if the run is runnable (running/waiting) AND its lease is free
  // or stale (>LEASE_TTL_MS, i.e. a crashed stepper). A 0-row claim ⇒ another stepper
  // holds it (or it went terminal) ⇒ benign SKIP, not an error. This is what makes the
  // idempotent-recovery path (advanceFromLedger) safe: the run cursor cannot be advanced
  // by a second stepper between finalizeAction and applyResult.
  const stepperId = randomUUID();
  const staleCutoff = new Date(Date.now() - LEASE_TTL_MS).toISOString();
  const { data: claimedRows, error: claimErr } = await supabaseAdmin
    .from('automation_runs')
    .update({ locked_at: new Date().toISOString(), locked_by: stepperId })
    .eq('id', runId)
    .in('status', ['running', 'waiting'])
    .or(`locked_at.is.null,locked_at.lt.${staleCutoff}`)
    .select('*');
  if (claimErr) {
    log.warn({ err: claimErr, runId }, 'stepRun: lease claim failed');
    return { status: 'error' };
  }
  if (!claimedRows || claimedRows.length === 0) {
    // Held by another stepper or no longer runnable — skip without side-effects.
    return { status: 'locked' };
  }
  const run = toRunRow(claimedRows[0]);

  // Everything below runs UNDER the lease; the finally releases it on every exit path.
  try {
    if (!run.current_node_key) {
      await completeRun(run.id, 'completed', run.goal_reached);
      return { status: 'completed' };
    }

    const graph = await loadGraph(run.automation_id, run.version);
    if (!graph) {
      await failRun(run.id, 'graph_missing');
      return { status: 'failed' };
    }
    const nodeKey = run.current_node_key;
    const node: GraphNode | undefined = graph.nodes[nodeKey];
    if (!node) {
      await failRun(run.id, `unknown_node:${nodeKey}`);
      return { status: 'failed' };
    }
    const executor = getNodeExecutor(node.type);
    if (!executor) {
      await failRun(run.id, `unknown_node_type:${node.type}`);
      return { status: 'failed' };
    }

    const meta = readMeta(run.context);
    const idemKey = idempotencyKey(run.id, nodeKey);

    // Idempotent ledger claim: insert a pending row. A 23505 means this node already has
    // an action — we already executed (or a prior stepper crashed post-finalize). Never
    // re-run; recover the persisted result instead.
    const { error: ledgerErr } = await supabaseAdmin.from('automation_actions').insert({
      tenant_id: run.tenant_id,
      run_id: run.id,
      node_key: nodeKey,
      node_type: node.type,
      idempotency_key: idemKey,
      input_snapshot: { config: node.config ?? {} },
      status: 'pending',
      started_at: new Date().toISOString(),
    });
    if (ledgerErr) {
      if (ledgerErr.code === '23505') {
        // Already actioned. Replay the FULL persisted NodeResult through applyResult so
        // the side-effect is not repeated but wait/stop/goal/context still land exactly
        // once. A still-pending prior action ⇒ left untouched (no re-run, no double).
        return await advanceFromLedger(run, graph, nodeKey);
      }
      log.warn({ err: ledgerErr, runId, nodeKey }, 'stepRun: ledger insert failed');
      return { status: run.status };
    }

    // Fresh action row — run the executor exactly once.
    const ctx: NodeContext = {
      run,
      nodeKey,
      node,
      context: run.context,
      actorId: meta.actor_id,
    };
    let result: NodeResult;
    try {
      result = await executor.execute(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finalizeAction(run, nodeKey, idemKey, { status: 'failed', retryReason: message, output: { error: message } }, null);
      await failRun(run.id, `node_threw:${message}`);
      return { status: 'failed' };
    }

    // Resolve the successor edge (explicit result.next wins; else node.next).
    const resolvedNext = result.next !== undefined && result.next !== null ? result.next : node.next ?? null;
    await finalizeAction(run, nodeKey, idemKey, result, resolvedNext);

    return await applyResult(run, meta, node, nodeKey, result, resolvedNext);
  } finally {
    await releaseLease(runId, stepperId);
  }
}

/** Release a run's lease iff we still hold it (locked_by match). Harmless on a terminal
 *  run — locked_at is simply nulled; the row is already done. */
async function releaseLease(runId: string, stepperId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('automation_runs')
    .update({ locked_at: null, locked_by: null })
    .eq('id', runId)
    .eq('locked_by', stepperId);
  if (error) log.warn({ err: error, runId }, 'releaseLease failed');
}

/**
 * Advance a run whose current node was already actioned (idempotent re-step / crash
 * recovery). The ledger row carries the FULL NodeResult the executor produced (see
 * finalizeAction, output.__result). Replaying it through applyResult means a crash
 * between finalizeAction and applyResult still lands EVERY effect exactly once —
 * wait_until, stop_reason, goal_reached, context_patch and the resolved successor — not
 * just the next-cursor. The run-level lease guarantees only one stepper reaches here, so
 * this replay cannot race a concurrent advance.
 */
async function advanceFromLedger(
  run: AutomationRunRow,
  graph: AutomationGraph,
  nodeKey: string,
): Promise<{ status: string; node?: string }> {
  const { data: action } = await supabaseAdmin
    .from('automation_actions')
    .select('status, output')
    .eq('run_id', run.id)
    .eq('node_key', nodeKey)
    .maybeSingle();
  if (!action || action.status === 'pending') {
    // Still in flight (or unreadable) — do not re-run; leave the cursor as-is.
    return { status: run.status };
  }
  const out = (action.output as Record<string, unknown>) ?? {};
  const node = graph.nodes[nodeKey];
  const meta = readMeta(run.context);
  const persisted = out.__result as Record<string, unknown> | undefined;

  // Full recovery via the persisted NodeResult (preferred path).
  if (persisted && typeof persisted === 'object' && node) {
    const result: NodeResult = {
      status: (persisted.status as NodeResult['status']) ?? 'succeeded',
      waitUntil: (persisted.wait_until as string | null) ?? undefined,
      stopReason: (persisted.stop_reason as string | null) ?? undefined,
      goalReached: (persisted.goal_reached as boolean | undefined) ?? undefined,
      contextPatch: (persisted.context_patch as Record<string, unknown> | null) ?? undefined,
      output: out,
    };
    const resolvedNext = (persisted.next as string | null) ?? node.next ?? null;
    return applyResult(run, meta, node, nodeKey, result, resolvedNext);
  }

  // Backward-compat fallback (pre-__result ledger rows): resolved_next / status only.
  if (action.status === 'failed') {
    await failRun(run.id, 'prior_action_failed');
    return { status: 'failed' };
  }
  const resolvedNext = (out.resolved_next as string | null) ?? node?.next ?? null;
  if (!resolvedNext || !graph.nodes[resolvedNext]) {
    await completeRun(run.id, 'completed', run.goal_reached);
    return { status: 'completed' };
  }
  await supabaseAdmin
    .from('automation_runs')
    .update({ current_node_key: resolvedNext, status: 'running' })
    .eq('id', run.id);
  return { status: 'running', node: resolvedNext };
}

/** Write the final action-ledger row state (status, output+resolved_next, provider id). */
async function finalizeAction(
  run: AutomationRunRow,
  nodeKey: string,
  idemKey: string,
  result: NodeResult,
  resolvedNext: string | null,
): Promise<void> {
  // Persist the FULL NodeResult semantics (not just resolved_next) so a crash between
  // here and applyResult is fully recoverable by advanceFromLedger (§10.4).
  const output = {
    ...(result.output ?? {}),
    resolved_next: resolvedNext,
    __result: {
      status: result.status,
      next: resolvedNext,
      wait_until: result.waitUntil ?? null,
      stop_reason: result.stopReason ?? null,
      goal_reached: result.goalReached ?? false,
      context_patch: result.contextPatch ?? null,
    },
  };
  const { error } = await supabaseAdmin
    .from('automation_actions')
    .update({
      status: result.status,
      output,
      provider_request_id: result.providerRequestId ?? null,
      retry_reason: result.retryReason ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq('run_id', run.id)
    .eq('node_key', nodeKey)
    .eq('idempotency_key', idemKey);
  if (error) log.warn({ err: error, runId: run.id, nodeKey }, 'finalizeAction failed');
}

/** Apply a fresh executor result to the run cursor + status (wait/stop/goal/next). */
async function applyResult(
  run: AutomationRunRow,
  meta: RunMeta,
  node: GraphNode,
  nodeKey: string,
  result: NodeResult,
  resolvedNext: string | null,
): Promise<{ status: string; node?: string }> {
  const now = new Date().toISOString();

  // Merge any context patch (context accumulation) before terminal checks.
  const mergedContext = result.contextPatch
    ? { ...run.context, ...result.contextPatch }
    : run.context;

  // stop node → terminal stopped.
  if (result.stopReason !== undefined) {
    await stopRunRow(run.id, result.stopReason, mergedContext);
    return { status: 'stopped' };
  }
  // goal node → terminal completed + goal_reached.
  if (result.goalReached) {
    await supabaseAdmin
      .from('automation_runs')
      .update({ status: 'completed', goal_reached: true, current_node_key: null, completed_at: now, context: mergedContext })
      .eq('id', run.id);
    return { status: 'completed' };
  }
  // failed executor → terminal failed (retry/backoff is a later hardening).
  if (result.status === 'failed') {
    await failRun(run.id, result.retryReason ?? `node_failed:${nodeKey}`, mergedContext);
    return { status: 'failed' };
  }

  // Global stop_conditions: any truthy predicate ends the run before advancing.
  for (const cond of meta.stop_conditions) {
    if (evaluatePredicate(cond, mergedContext)) {
      await stopRunRow(run.id, 'stop_condition', mergedContext);
      return { status: 'stopped' };
    }
  }

  // wait node → park the run at the successor until wake_at.
  if (result.waitUntil) {
    await supabaseAdmin
      .from('automation_runs')
      .update({ status: 'waiting', wake_at: result.waitUntil, current_node_key: resolvedNext, context: mergedContext })
      .eq('id', run.id);
    return { status: 'waiting', node: resolvedNext ?? undefined };
  }

  // Normal advance. No successor ⇒ the run has walked to the end.
  if (!resolvedNext) {
    await completeRun(run.id, 'completed', run.goal_reached, mergedContext);
    return { status: 'completed' };
  }
  await supabaseAdmin
    .from('automation_runs')
    .update({ status: 'running', current_node_key: resolvedNext, wake_at: null, context: mergedContext })
    .eq('id', run.id);
  return { status: 'running', node: resolvedNext };
}

async function completeRun(
  runId: string,
  status: 'completed',
  goalReached: boolean,
  context?: Record<string, unknown>,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status,
    goal_reached: goalReached,
    current_node_key: null,
    completed_at: new Date().toISOString(),
  };
  if (context) patch.context = context;
  await supabaseAdmin.from('automation_runs').update(patch).eq('id', runId);
}

async function stopRunRow(runId: string, reason: string, context?: Record<string, unknown>): Promise<void> {
  const patch: Record<string, unknown> = {
    status: 'stopped',
    stop_reason: reason,
    current_node_key: null,
    completed_at: new Date().toISOString(),
  };
  if (context) patch.context = context;
  await supabaseAdmin.from('automation_runs').update(patch).eq('id', runId);
}

async function failRun(runId: string, reason: string, context?: Record<string, unknown>): Promise<void> {
  const patch: Record<string, unknown> = {
    status: 'failed',
    stop_reason: reason,
    completed_at: new Date().toISOString(),
  };
  if (context) patch.context = context;
  await supabaseAdmin.from('automation_runs').update(patch).eq('id', runId);
}

// ── runtimeTick (FLAG-GATED) ────────────────────────────────────────────────────
/**
 * The live runtime entry: claim queued events, start matching runs, step runnable
 * runs. GUARDRAIL: this is a NO-OP unless AUTOMATION_WORKER_ENABLED is set, and it is
 * NOT wired into the research worker loop — so no night tick claims, steps, or sends.
 * When eventually enabled it should be driven by a dedicated poll loop (its own
 * process), never from an unrelated worker's tick.
 */
export async function runtimeTick(batchLimit = 20): Promise<{ enabled: boolean; claimed: number; stepped: number }> {
  // Explicit allow-list: ONLY the literal 'true' enables the tick. A stray 'false'/'0'/''
  // (all truthy-ish as strings under a bare check) must NOT switch the worker on.
  if (process.env.AUTOMATION_WORKER_ENABLED !== 'true') {
    return { enabled: false, claimed: 0, stepped: 0 };
  }

  // 1) Claim queued domain events and start matching runs.
  const events = await claimBatch(batchLimit);
  for (const ev of events) {
    try {
      await claimAndStart(ev);
      await markEvent(ev.id, 'processed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, eventId: ev.id }, 'runtimeTick: claimAndStart failed');
      await markEvent(ev.id, 'failed', message);
    }
  }

  // 2) Step runnable runs (running now, or waiting whose wake_at has arrived).
  const nowIso = new Date().toISOString();
  const { data: runnable } = await supabaseAdmin
    .from('automation_runs')
    .select('id, status, wake_at')
    .in('status', ['running', 'waiting'])
    .or(`status.eq.running,wake_at.lte.${nowIso}`)
    .limit(batchLimit);

  let stepped = 0;
  for (const r of runnable ?? []) {
    if (r.status === 'waiting' && (!r.wake_at || (r.wake_at as string) > nowIso)) continue;
    try {
      await stepRun(r.id as string);
      stepped += 1;
    } catch (err) {
      log.warn({ err, runId: r.id }, 'runtimeTick: stepRun failed');
    }
  }

  return { enabled: true, claimed: events.length, stepped };
}
