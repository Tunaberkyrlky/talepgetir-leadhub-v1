/**
 * BEST-EFFORT outbox append writer for the automation runtime (v3 §10.1, §10.4).
 *
 * NOT a real transactional outbox (yet). emitEvent appends one domain-event row to
 * automation_events_outbox on a SEPARATE DB call, AFTER the caller's business write
 * already committed. A crash/restart/transient error between the two loses the event.
 * This function NEVER throws — an emit failure is logged and swallowed so a business
 * write (lead capture, asset publish, …) can never be broken by the outbox. Because
 * it never throws, callers `await emitEvent(...)` on the business path to CLOSE the
 * loss window (the row is durable before the handler responds) while staying safe.
 * A true transactional outbox — the business UPDATE and this INSERT in ONE
 * service-role RPC / single transaction — is DEFERRED to C2 hardening.
 *
 * Idempotency ON RETRY (dedup): pass a dedupKey and a REPEAT emit of the same logical
 * event collides on the partial UNIQUE (tenant_id, dedup_key) → 23505, swallowed as
 * success. This only de-dupes a repeat; it does NOT guarantee the FIRST emit landed,
 * so delivery is best-effort, NOT at-least-once. Without a dedupKey, every call inserts.
 *
 * There is NO consumer in this module. claimBatch() is a skeleton for Phase 5 C2
 * and is intentionally NOT called anywhere this round.
 */
import { supabaseAdmin } from '../supabase.js';
import { createLogger } from '../logger.js';
import type { DomainEventType, EventAggregate } from './events.js';

const log = createLogger('lib:automation:outbox');

export interface EmitOptions {
  /** Idempotency key, unique per (tenant_id, dedupKey). Omit for always-insert. */
  dedupKey?: string;
}

/**
 * Append a domain event (best-effort). Resolves even on failure and NEVER throws;
 * emit failures (including a swallowed 23505 dedup collision) do not affect the
 * caller's business write. Safe to `await` on the business path precisely because it
 * never throws — awaiting narrows the loss window (durable before response) without
 * ever surfacing an outbox error to the caller. Not transactional; see file header.
 */
export async function emitEvent(
  tenantId: string,
  eventType: DomainEventType,
  aggregate: EventAggregate | null,
  payload: Record<string, unknown> = {},
  opts: EmitOptions = {},
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('automation_events_outbox').insert({
      tenant_id: tenantId,
      event_type: eventType,
      aggregate_type: aggregate?.aggregate_type ?? null,
      aggregate_id: aggregate?.aggregate_id ?? null,
      payload,
      dedup_key: opts.dedupKey ?? null,
    });
    // 23505 ⇒ the (tenant_id, dedup_key) partial unique rejected a duplicate emit.
    // That IS the idempotency guarantee working — the event already exists, so it
    // is a benign no-op, not an error.
    if (error && error.code !== '23505') {
      log.warn({ err: error, tenantId, eventType }, 'emitEvent insert failed');
    }
  } catch (err) {
    // Defensive: an unexpected throw must never propagate onto the business path.
    log.warn({ err, tenantId, eventType }, 'emitEvent threw');
  }
}

/** One claimed outbox row handed to a runtime consumer (Phase 5 C2). */
export interface ClaimedEvent {
  id: string;
  tenant_id: string;
  event_type: DomainEventType;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  occurred_at: string;
}

/**
 * SKELETON — Phase 5 C2. The real implementation will atomically claim the oldest
 * queued events (FOR UPDATE SKIP LOCKED via a service-role RPC), stamp status
 * 'claimed'/claimed_at, and return them for processing. It is NOT called anywhere
 * in this round (no consumer runs); it returns an empty batch so an accidental
 * wire-up is inert rather than a crash.
 */
export async function claimBatch(_limit = 20): Promise<ClaimedEvent[]> {
  // TODO(C2): atomic claim + status transition; no-op skeleton until then.
  return [];
}
