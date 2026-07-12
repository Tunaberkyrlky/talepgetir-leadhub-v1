/**
 * Control-flow node executors (SENDLESS): wait, condition, stop, goal.
 * Pure decisions over the run context — none touch the outside world or mutate CRM
 * rows; they only tell the engine where to go next. (v3 §10.1, §10.3.)
 */
import type { NodeExecutor, NodeContext, NodeResult } from '../types.js';
import { evaluatePredicate } from '../predicate.js';

/**
 * wait — park the run until an absolute instant or a relative delay, then resume.
 * config: { until?: ISO string } | { delaySeconds?: number }. The engine sets the
 * run to `waiting` with wake_at = the computed instant; a later tick resumes it.
 */
export const waitExecutor: NodeExecutor = {
  type: 'wait',
  async execute(ctx: NodeContext): Promise<NodeResult> {
    const cfg = ctx.node.config ?? {};
    let until: string;
    if (typeof cfg.until === 'string') {
      until = cfg.until;
    } else {
      const delaySeconds = typeof cfg.delaySeconds === 'number' ? cfg.delaySeconds : 0;
      until = new Date(Date.now() + delaySeconds * 1000).toISOString();
    }
    return { status: 'succeeded', waitUntil: until, output: { wake_at: until } };
  },
};

/**
 * condition — evaluate branches against the run context; follow the first truthy
 * branch, else fall through to node.next. config.branches mirrors the graph edges but
 * the engine already has them on node.branches, so we evaluate those directly.
 */
export const conditionExecutor: NodeExecutor = {
  type: 'condition',
  async execute(ctx: NodeContext): Promise<NodeResult> {
    const branches = ctx.node.branches ?? [];
    for (const branch of branches) {
      if (evaluatePredicate(branch.when, ctx.context)) {
        return { status: 'succeeded', next: branch.next, output: { matched: branch.next } };
      }
    }
    // No branch matched ⇒ default edge (node.next); engine falls through.
    return { status: 'succeeded', next: null, output: { matched: null } };
  },
};

/**
 * stop — end the run early with a reason. The engine sets status='stopped' and
 * records stop_reason. config: { reason?: string }.
 */
export const stopExecutor: NodeExecutor = {
  type: 'stop',
  async execute(ctx: NodeContext): Promise<NodeResult> {
    const reason = typeof ctx.node.config?.reason === 'string' ? ctx.node.config.reason : 'stop_node';
    return { status: 'succeeded', stopReason: reason, output: { stop_reason: reason } };
  },
};

/**
 * goal — mark the run goal-reached. The engine sets goal_reached=true and completes
 * the run (a reached goal is a successful terminal state).
 */
export const goalExecutor: NodeExecutor = {
  type: 'goal',
  async execute(): Promise<NodeResult> {
    return { status: 'succeeded', goalReached: true, output: { goal_reached: true } };
  },
};
