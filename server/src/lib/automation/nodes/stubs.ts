/**
 * STUB executors for SEND-CAPABLE node types (v3 §10.1). Every one of these could
 * reach the outside world (email/WhatsApp/SMS, asset generation/publishing, booking
 * links, meeting bots, generic webhooks, human approval). In THIS round they are all
 * inert: each returns { status: 'skipped', output: { note: 'not_wired' } } and sends
 * NOTHING. C3 replaces the email stub with a real executor; the rest follow later.
 *
 * GUARDRAIL: no real e-mail/message/call/scrape/webhook is triggered here — the whole
 * point of the stub is that wiring the registry cannot leak a live send this round.
 */
import type { NodeExecutor, NodeType, NodeResult } from '../types.js';

/** Every node type that performs an external side-effect (kept out of C2's scope). */
const SEND_NODE_TYPES: NodeType[] = [
  'email',
  'whatsapp',
  'sms',
  'generate_asset',
  'publish_asset',
  'booking_link',
  'meeting_bot',
  'webhook',
  'human_approval',
];

function makeStub(type: NodeType): NodeExecutor {
  return {
    type,
    async execute(): Promise<NodeResult> {
      // Skipped = "handled, but performed no side-effect". The engine advances past it
      // via node.next so a graph containing a send node still walks to completion.
      return { status: 'skipped', output: { note: 'not_wired', node_type: type } };
    },
  };
}

/** The send-capable stub registry, one skipped executor per type. */
export const stubExecutors: NodeExecutor[] = SEND_NODE_TYPES.map(makeStub);
