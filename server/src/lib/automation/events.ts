/**
 * Domain event catalog for the automation runtime (v3 §10.2).
 *
 * A single, type-safe source of truth for every domain event the best-effort
 * outbox (125_automation_events_outbox — NOT yet transactional; C2 hardens that)
 * can carry. Business writes emit one of
 * these via lib/automation/outbox.ts#emitEvent; a later worker (Phase 5 C2) will
 * consume them. This module is pure types + constants — NO runtime dependencies,
 * NO side effects, NO consumer.
 */

/** Aggregate kinds an event can point at (polymorphic aggregate_id, no FK). This
 *  list is mirrored by the outbox CHECK (aggregate_type IN …) — keep them in sync.
 *  The tenant-consistency trigger tenant-verifies lead/company/contact/asset and
 *  REJECTS any other kind carrying an aggregate_id until its table exists. */
export const AGGREGATE_TYPES = [
  'lead',
  'company',
  'contact',
  'asset',
  'message',
  'booking',
  'deal',
] as const;
export type AggregateType = (typeof AGGREGATE_TYPES)[number];

/**
 * The domain event catalog (v3 §10.2). Namespaced `<aggregate>.<past-tense>`.
 * Only lead.captured / lead.qualified / lead.disqualified / asset.generated /
 * asset.published are wired to emitters in this round; the rest are declared here
 * so C2 (the runtime) and future emitters share one vocabulary.
 */
export const DOMAIN_EVENT_TYPES = [
  // lead.* — capture → identity → enrichment → qualification → routing lifecycle
  'lead.captured',
  'lead.identity_resolved',
  'lead.enriched',
  'lead.qualified',
  'lead.disqualified',
  'lead.owner_assigned',
  'lead.lifecycle_changed',
  // asset.* — personalized report / lead-magnet lifecycle + delivery telemetry
  'asset.requested',
  'asset.generated',
  'asset.approved',
  'asset.published',
  'asset.viewed',
  'asset.cta_clicked',
  // message.* — outbound message lifecycle (delivery is a LATER WP; declared only)
  'message.queued',
  'message.sent',
  'message.delivered',
  'message.opened',
  'message.clicked',
  'message.replied',
  'message.bounced',
  'message.failed',
  // booking.* — meeting / demo lifecycle
  'booking.requested',
  'booking.scheduled',
  'booking.rescheduled',
  'booking.completed',
  'booking.canceled',
  'booking.no_show',
  // deal.* — pipeline / opportunity lifecycle
  'deal.created',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/** A resolved aggregate pointer for an event ({type, id}). */
export interface EventAggregate {
  aggregate_type: AggregateType;
  aggregate_id: string;
}
