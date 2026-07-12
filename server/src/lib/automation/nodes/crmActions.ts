/**
 * Internal CRM action node executors (v3 §10.1). These MUTATE first-party CRM rows
 * (lead lifecycle, owner, pipeline stage, tasks) but perform NO external send. They
 * call the same service layer / tables the routes use, scoped by the run's tenant_id.
 *
 * GUARDRAIL: because runtimeTick is flag-gated OFF this round, these NEVER run at rest
 * — no automation mutates CRM data tonight. They are unit-callable and correct so C3+
 * can drive them once the worker entry is enabled.
 *
 * Actor: automation runs have no human actor. The engine threads the automation's
 * created_by as ctx.actorId. A mutation that strictly needs an actor (stage change
 * timeline) fails CLOSED with retry_reason='no_actor' rather than writing anonymously.
 */
import type { NodeExecutor, NodeContext, NodeResult } from '../types.js';
import { supabaseAdmin } from '../../supabase.js';
import { transitionCompanyStage, type ClosingReportInput } from '../../stageTransition.js';
import { createLogger } from '../../logger.js';
import { isActiveMember, isUuid } from '../../userResolver.js';
import { createTaskSchema } from '../../validation.js';

const log = createLogger('lib:automation:nodes:crm');

/** leads.lifecycle_status CHECK values (mirror 121_leads.sql). */
const LIFECYCLE_STATUSES = new Set([
  'captured',
  'identity_pending',
  'needs_review',
  'processing_error',
]);

/**
 * update_lifecycle — set leads.lifecycle_status. config: { status: <lifecycle> }.
 * Requires the run to be lead-scoped. No external send.
 */
export const updateLifecycleExecutor: NodeExecutor = {
  type: 'update_lifecycle',
  async execute(ctx: NodeContext): Promise<NodeResult> {
    const status = ctx.node.config?.status;
    if (typeof status !== 'string' || !LIFECYCLE_STATUSES.has(status)) {
      return { status: 'failed', retryReason: 'invalid_lifecycle_status', output: { error: 'invalid_lifecycle_status' } };
    }
    if (!ctx.run.lead_id) {
      return { status: 'skipped', output: { skipped: 'no_lead' } };
    }
    const { error } = await supabaseAdmin
      .from('leads')
      .update({ lifecycle_status: status, updated_at: new Date().toISOString() })
      .eq('id', ctx.run.lead_id)
      .eq('tenant_id', ctx.run.tenant_id);
    if (error) {
      log.warn({ err: error, runId: ctx.run.id }, 'update_lifecycle failed');
      return { status: 'failed', output: { error: error.message } };
    }
    return { status: 'succeeded', output: { lifecycle_status: status } };
  },
};

/**
 * assign_owner — set leads.owner_id. config: { owner_id: <uuid> | null }. Lead-scoped.
 */
export const assignOwnerExecutor: NodeExecutor = {
  type: 'assign_owner',
  async execute(ctx: NodeContext): Promise<NodeResult> {
    const rawOwner = ctx.node.config?.owner_id;
    // owner_id is either null (unassign) or a UUID that MUST be an active member of the
    // run's tenant. Anything else fails CLOSED — no silent cross-tenant / non-member owner.
    let ownerId: string | null;
    if (rawOwner === null || rawOwner === undefined) {
      ownerId = null;
    } else if (isUuid(rawOwner)) {
      ownerId = rawOwner;
    } else {
      return { status: 'failed', retryReason: 'invalid_owner_id', output: { error: 'invalid_owner_id' } };
    }
    if (!ctx.run.lead_id) {
      return { status: 'skipped', output: { skipped: 'no_lead' } };
    }
    if (ownerId !== null && !(await isActiveMember(ctx.run.tenant_id, ownerId))) {
      return { status: 'failed', retryReason: 'owner_not_member', output: { error: 'owner_not_active_member' } };
    }
    const { error } = await supabaseAdmin
      .from('leads')
      .update({ owner_id: ownerId, updated_at: new Date().toISOString() })
      .eq('id', ctx.run.lead_id)
      .eq('tenant_id', ctx.run.tenant_id);
    if (error) {
      log.warn({ err: error, runId: ctx.run.id }, 'assign_owner failed');
      return { status: 'failed', output: { error: error.message } };
    }
    return { status: 'succeeded', output: { owner_id: ownerId } };
  },
};

/**
 * update_stage — move the run's company to a pipeline stage via the single stage-
 * transition entry point (CAS + timeline). config: { stage: <slug>, closing_report?,
 * reopen_reason? }. Company-scoped and actor-required (the timeline line needs a
 * created_by); fails closed without an actor.
 */
export const updateStageExecutor: NodeExecutor = {
  type: 'update_stage',
  async execute(ctx: NodeContext): Promise<NodeResult> {
    const stage = ctx.node.config?.stage;
    if (typeof stage !== 'string' || !stage) {
      return { status: 'failed', output: { error: 'invalid_stage' } };
    }
    if (!ctx.run.company_id) {
      return { status: 'skipped', output: { skipped: 'no_company' } };
    }
    if (!ctx.actorId) {
      return { status: 'failed', retryReason: 'no_actor', output: { error: 'no_actor' } };
    }
    try {
      const result = await transitionCompanyStage({
        tenantId: ctx.run.tenant_id,
        userId: ctx.actorId,
        companyId: ctx.run.company_id,
        targetStage: stage,
        closingReport: (ctx.node.config?.closing_report as ClosingReportInput | undefined) ?? undefined,
        reopenReason: (ctx.node.config?.reopen_reason as string | undefined) ?? null,
      });
      return { status: 'succeeded', output: { stage, kind: result.kind } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, runId: ctx.run.id }, 'update_stage failed');
      return { status: 'failed', output: { error: message } };
    }
  },
};

/**
 * create_task — insert a CRM task for the run's company. config: { title, detail?,
 * priority?, due_at (ISO or {delaySeconds}), assigned_to? }. Company-scoped. Mirrors
 * routes/tasks.ts validation shapes (createTaskSchema); no external send.
 */
export const createTaskExecutor: NodeExecutor = {
  type: 'create_task',
  async execute(ctx: NodeContext): Promise<NodeResult> {
    const cfg = ctx.node.config ?? {};
    if (!ctx.run.company_id) {
      return { status: 'skipped', output: { skipped: 'no_company' } };
    }
    // due_at: an explicit ISO string, else a relative delay (due_in_seconds), else +1d.
    // The final value is validated as ISO by createTaskSchema below.
    let dueAt: unknown = cfg.due_at;
    if (typeof dueAt !== 'string') {
      const delaySeconds = typeof cfg.due_in_seconds === 'number' ? cfg.due_in_seconds : 86400;
      dueAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    }
    // Validate the SAME way routes/tasks.ts does (createTaskSchema): company_id from the
    // run, everything else config-supplied. No silent truncation — an over-length title
    // or a non-UUID contact/assignee makes the ACTION fail, it is never quietly coerced.
    const parsed = createTaskSchema.safeParse({
      company_id: ctx.run.company_id,
      contact_id: cfg.contact_id ?? undefined,
      title: cfg.title,
      detail: cfg.detail ?? undefined,
      priority: cfg.priority,
      due_at: dueAt,
      assigned_to: cfg.assigned_to ?? undefined,
    });
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? 'invalid_task_config';
      return { status: 'failed', retryReason: 'invalid_task_config', output: { error: reason } };
    }
    const t = parsed.data;
    // Assignee must be an active member of the run's tenant (no cross-tenant assignee).
    if (t.assigned_to && !(await isActiveMember(ctx.run.tenant_id, t.assigned_to))) {
      return { status: 'failed', retryReason: 'assignee_not_member', output: { error: 'assignee_not_active_member' } };
    }
    const { data, error } = await supabaseAdmin
      .from('tasks')
      .insert({
        tenant_id: ctx.run.tenant_id,
        company_id: t.company_id,
        contact_id: t.contact_id ?? null,
        title: t.title,
        detail: t.detail ?? null,
        priority: t.priority,
        due_at: t.due_at,
        assigned_to: t.assigned_to ?? null,
        created_by: ctx.actorId,
      })
      .select('id')
      .maybeSingle();
    if (error) {
      log.warn({ err: error, runId: ctx.run.id }, 'create_task failed');
      return { status: 'failed', output: { error: error.message } };
    }
    return { status: 'succeeded', output: { task_id: data?.id ?? null } };
  },
};
