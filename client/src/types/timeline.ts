import type { Activity, ActivityType } from './activity';
import type { EmailDirection } from './emailReply';

/**
 * Unified company timeline event — the common contract emitted by
 * GET /api/companies/:id/timeline. Activities and email replies are both
 * mapped onto this shape so the client can render one chronological stream.
 */
export type TimelineSource = 'activity' | 'email';

export interface TimelineEvent {
    /** Globally-unique row key (source-prefixed) */
    id: string;
    /** Raw source-table id, for deep-linking to the channel's own detail view */
    ref_id: string;
    source: TimelineSource;
    /** Activity type for activities, 'email' for email replies */
    kind: ActivityType | 'email';
    direction: EmailDirection | null;
    occurred_at: string;
    /** Resolved user display name (activities only) — never a raw UUID */
    actor: string | null;
    actor_id: string | null;
    summary: string | null;
    detail: string | null;
    contact_name: string | null;
    outcome: string | null;
    visibility: string | null;
    campaign_name: string | null;
    category: string | null;
    read_status: string | null;
    subject: string | null;
    sender_email: string | null;
    /** System-generated audit line (status_change) vs. genuine human contact */
    is_system: boolean;
    /** Raw activity row (source==='activity' only) — used to prefill the edit form */
    activity?: Activity;
}

/**
 * Channel keys used by the filter Select, the icon/color maps and the
 * "important only" predicate. Derived from source + kind + direction.
 */
export type TimelineChannel =
    | 'not'
    | 'meeting'
    | 'follow_up'
    | 'call'
    | 'campaign_email'
    | 'sonlandirma_raporu'
    | 'status_change'
    | 'email_in'
    | 'email_out';

export function eventChannel(e: TimelineEvent): TimelineChannel {
    if (e.source === 'email') return e.direction === 'OUT' ? 'email_out' : 'email_in';
    return e.kind as TimelineChannel;
}

/**
 * "Only important" view: genuine two-way contact that matters for follow-up —
 * meetings, calls, closing reports and inbound replies. Excludes system audit
 * lines (status_change) and one-way outbound blasts (campaign sends / OUT mail).
 */
export function isImportantEvent(e: TimelineEvent): boolean {
    if (e.source === 'email') return e.direction === 'IN';
    return e.kind === 'meeting' || e.kind === 'call' || e.kind === 'sonlandirma_raporu';
}
