/**
 * Automation runtime types (v3 §6.6, §10.1, §10.3, §10.4).
 *
 * The shared vocabulary for the channel-agnostic state machine: node types, the
 * immutable graph snapshot shape, run/action lifecycle enums, and the NodeExecutor
 * contract. Pure types — NO runtime, NO side effects. Node executors live in nodes/,
 * the engine in runtime.ts.
 */
import type { DomainEventType } from './events.js';

/** Node kinds the graph can contain. Control + internal-CRM are executed by C2;
 *  send-capable kinds are registry STUBs (skipped) until C3 wires them. */
export const NODE_TYPES = [
  // control flow (sendless)
  'wait',
  'condition',
  'stop',
  'goal',
  // internal CRM mutations (no external send)
  'update_lifecycle',
  'update_stage',
  'assign_owner',
  'create_task',
  // send-capable — STUB this round (C3 wires email)
  'email',
  'whatsapp',
  'sms',
  'generate_asset',
  'publish_asset',
  'booking_link',
  'meeting_bot',
  'webhook',
  'human_approval',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Run lifecycle — mirrors automation_runs.status CHECK. */
export type RunStatus =
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'stopped'
  | 'failed';

/** Action lifecycle — mirrors automation_actions.status CHECK. */
export type ActionStatus = 'pending' | 'succeeded' | 'failed' | 'skipped';

/** One conditional edge: follow `next` when `when` evaluates truthy against context. */
export interface GraphBranch {
  when: PredicateExpr;
  next: string;
}

/** A single node in the immutable graph snapshot. */
export interface GraphNode {
  type: NodeType;
  config?: Record<string, unknown>;
  /** Default successor node_key (linear edge). Omitted on terminal nodes. */
  next?: string;
  /** Conditional successors (condition node). First truthy branch wins; else `next`. */
  branches?: GraphBranch[];
}

/** The frozen graph a run walks. Persisted in automation_versions.graph. */
export interface AutomationGraph {
  entry: string;
  nodes: Record<string, GraphNode>;
}

/**
 * A minimal predicate expression evaluated against the run context (entry criteria,
 * condition branches, stop conditions). Intentionally tiny + safe (no eval): a leaf
 * compares a context path to a value; `all`/`any`/`not` compose. Empty object ⇒ true.
 */
export type PredicateExpr =
  | Record<string, never>
  | { all: PredicateExpr[] }
  | { any: PredicateExpr[] }
  | { not: PredicateExpr }
  | {
      path: string;
      op?: 'eq' | 'ne' | 'in' | 'exists' | 'gt' | 'lt';
      value?: unknown;
    };

/** The run row the runtime carries between steps (subset used by executors). */
export interface AutomationRunRow {
  id: string;
  tenant_id: string;
  automation_id: string;
  version: number;
  lead_id: string | null;
  company_id: string | null;
  current_node_key: string | null;
  status: RunStatus;
  goal_reached: boolean;
  context: Record<string, unknown>;
}

/** Everything a node executor needs to run and to write its ledger row. */
export interface NodeContext {
  run: AutomationRunRow;
  nodeKey: string;
  node: GraphNode;
  /** Assembled run context (C4 enriches; for now = run.context + event payload). */
  context: Record<string, unknown>;
  /** System actor id for CRM writes that need a created_by/actor (nullable). */
  actorId: string | null;
}

/** What an executor tells the engine to do next. */
export interface NodeResult {
  /** Ledger status for this node's action row. */
  status: ActionStatus;
  /** Explicit successor node_key (overrides node.next). NULL/undefined ⇒ use node.next. */
  next?: string | null;
  /** wait node: park the run until this instant (sets run → waiting, wake_at). */
  waitUntil?: string;
  /** stop node: end the run as stopped with this reason. */
  stopReason?: string;
  /** goal node: mark the run goal-reached (and complete it). */
  goalReached?: boolean;
  /** Arbitrary output recorded on the action ledger row. */
  output?: Record<string, unknown>;
  /** Reason recorded on the ledger row when status='failed' (retry_reason column). */
  retryReason?: string;
  /** External provider id, when a (future) send node has one (provider_request_id). */
  providerRequestId?: string;
  /** Merged into run.context after the step (context accumulation). */
  contextPatch?: Record<string, unknown>;
}

/** The executor contract. One per NodeType, registered in nodes/index.ts. */
export interface NodeExecutor {
  type: NodeType;
  execute(ctx: NodeContext): Promise<NodeResult>;
}

/** An active automation matched to an incoming event (claimAndStart). */
export interface MatchedAutomation {
  id: string;
  tenant_id: string;
  version: number;
  graph: AutomationGraph;
  goal_event: DomainEventType | null;
  stop_conditions: PredicateExpr[];
}
