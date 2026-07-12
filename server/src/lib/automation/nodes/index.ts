/**
 * Node executor registry (v3 §26). Maps a NodeType → its NodeExecutor, mirroring the
 * research worker's getHandler() lookup (worker/handlers/index.ts). Control + internal
 * CRM executors are real; send-capable types resolve to skipped STUBs this round.
 */
import { NODE_TYPES, type NodeExecutor, type NodeType } from '../types.js';
import { waitExecutor, conditionExecutor, stopExecutor, goalExecutor } from './control.js';
import {
  updateLifecycleExecutor,
  assignOwnerExecutor,
  updateStageExecutor,
  createTaskExecutor,
} from './crmActions.js';
import { stubExecutors } from './stubs.js';

const registry: Record<string, NodeExecutor> = {};
function register(exec: NodeExecutor): void {
  registry[exec.type] = exec;
}

// control flow (sendless)
register(waitExecutor);
register(conditionExecutor);
register(stopExecutor);
register(goalExecutor);
// internal CRM mutations (no external send)
register(updateLifecycleExecutor);
register(assignOwnerExecutor);
register(updateStageExecutor);
register(createTaskExecutor);
// send-capable — skipped stubs until each is wired (email = C3)
for (const stub of stubExecutors) register(stub);

// Exhaustiveness guard (§26): EVERY NodeType in the union must have a registered
// executor. If a new node type is added to NODE_TYPES without wiring an executor (or a
// stub), fail LOUDLY at module load rather than surfacing an unknown_node_type at run
// time. This runs once at import (registry is fully populated above).
{
  const missing = NODE_TYPES.filter((t) => registry[t] === undefined);
  if (missing.length > 0) {
    throw new Error(`automation node registry is missing executors for: ${missing.join(', ')}`);
  }
}

/** Look up the executor for a node type. Undefined ⇒ unknown/unregistered type. */
export function getNodeExecutor(type: string): NodeExecutor | undefined {
  return registry[type];
}

/** Node types the runtime can currently step. */
export function registeredNodeTypes(): NodeType[] {
  return Object.keys(registry) as NodeType[];
}
