export type MatchStatus = 'matched' | 'unmatched';
export type ReadStatus = 'read' | 'unread';
export type EmailCategory =
    | 'positive'
    | 'negative'
    | 'meeting_request'
    | 'waiting_response'
    | 'not_interested'
    | 'other';

export type EmailDirection = 'IN' | 'OUT';

export interface EmailReply {
    id: string;
    tenant_id: string;
    campaign_name: string | null;
    campaign_id: string | null;
    sender_email: string;
    reply_body: string | null;
    replied_at: string;
    company_id: string | null;
    company_name: string | null;
    company_stage: string | null;
    company_website: string | null;
    company_activity_count: number | null;
    contact_id: string | null;
    contact_name: string | null;
    match_status: MatchStatus;
    read_status: ReadStatus;
    category: EmailCategory | null;
    category_confidence: number | null;
    label: string | null;
    sentiment: string | null;
    subject: string | null;
    created_at: string;
    direction?: EmailDirection;
    parent_reply_id?: string | null;
    // Canonical mail columns (first-class; replace raw_payload heuristics)
    provider?: string | null;
    provider_thread_id?: string | null;
    account_email?: string | null;   // OUR mailbox on this thread
    from_address?: string | null;    // who sent THIS message
    to_address?: string | null;      // recipient(s)
    cc_address?: string | null;
    // Threading fields (present on threaded list responses)
    thread_count?: number;
    has_unread?: boolean;
    raw_payload?: {
        from_address?: string;
        plusvibe_email_id?: string;
        subject?: string;
        source?: string;
        forwarded_to?: string;
        [key: string]: unknown;
    } | null;
}

/**
 * Parse a raw "from" string (may be "Name <email@x.com>" or just "email@x.com").
 * Returns the bare email address, or the input unchanged if no angle brackets.
 */
export function extractEmailAddress(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    const match = trimmed.match(/<([^>]+)>/);
    return match ? match[1].trim() : trimmed;
}

/** Extract every email address from a comma/whitespace-separated address-list string. */
function extractAllEmailAddresses(raw: string | null | undefined): string[] {
    if (!raw) return [];
    const angled = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim()).filter(Boolean);
    if (angled.length > 0) return angled;
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolve WHICH OF OUR MAILBOXES a reply belongs to (the "From" shown in the
 * reply compose panel). PlusVibe stores this differently per source, and the
 * legacy api-import path mis-labeled the recipient list as `from_address`.
 *
 *  - OUT row:            raw_payload.from_address = our mailbox (correct)
 *  - SMTP webhook (IN):  raw_payload.to_email / to = our mailbox
 *  - old webhook (IN):   raw_payload.from_address = our mailbox (single address)
 *  - api-import (IN):    raw_payload.from_address actually held the recipient list;
 *                        our mailbox is the recipient whose domain isn't the lead's
 *
 * Returns null when it cannot be determined (panel then hides the "From" line).
 */
export function resolveOurMailbox(reply: {
    direction?: EmailDirection;
    sender_email?: string;
    account_email?: string | null;
    raw_payload?: Record<string, unknown> | null;
} | null | undefined): string | null {
    if (!reply) return null;

    // 1. Canonical column wins (set by the mail adapters going forward)
    if (reply.account_email) return reply.account_email;

    // 2. Legacy raw_payload fallback (rows backfill couldn't fully populate)
    const rp = (reply.raw_payload || {}) as Record<string, unknown>;
    const leadDomain = reply.sender_email?.split('@')[1]?.toLowerCase();

    // OUT: from_address is our mailbox
    if (reply.direction === 'OUT') {
        return extractEmailAddress(rp.from_address as string | null);
    }

    // SMTP webhook: to_email / to is our mailbox
    if (rp.source === 'SMTP') {
        return extractEmailAddress((rp.to_email as string | null) ?? (rp.to as string | null));
    }

    // Old webhook / fallback: from_address holds our mailbox, UNLESS it's a
    // recipient list (legacy api-import) — then pick the non-lead-domain address.
    const addrs = extractAllEmailAddresses(rp.from_address as string | null);
    if (addrs.length === 1) {
        // Single clean mailbox (old webhook). Guard: if it equals the lead, ignore.
        return addrs[0].split('@')[1]?.toLowerCase() !== leadDomain ? addrs[0] : null;
    }
    if (addrs.length > 1) {
        // Recipient list — our mailbox is the one not on the lead's domain.
        return addrs.find((a) => a.split('@')[1]?.toLowerCase() !== leadDomain) ?? null;
    }
    return null;
}

export interface ThreadHistoryItem {
    id: string;
    sender_email: string;
    reply_body: string | null;
    replied_at: string;
    read_status: ReadStatus;
    campaign_id: string | null;
    direction?: EmailDirection;
    // Canonical address columns
    provider?: string | null;
    account_email?: string | null;
    from_address?: string | null;
    to_address?: string | null;
    cc_address?: string | null;
    raw_payload?: {
        source?: string;
        forwarded_to?: string;
        [key: string]: unknown;
    } | null;
}

export interface EmailReplyStats {
    total: number;
    unread: number;
    matched: number;
    unmatched: number;
}

export interface Campaign {
    campaign_id: string;
    campaign_name: string;
}
