/**
 * resolveThreadMailbox — the single source of truth for "which of OUR mailboxes
 * owns this thread". Drives the reply send `from` AND the displayed "Kimden".
 *
 * Priority:
 *   1. account_email column (canonical, set by the adapters going forward)
 *   2. legacy raw_payload heuristics (for rows backfill couldn't fully populate):
 *      - OUT row:        raw_payload.from_address (the account we sent from)
 *      - SMTP webhook:   raw_payload.email_account_name ?? to_email ?? to
 *      - old webhook:    raw_payload.from_address (single mailbox)
 *      - api_import:     recipient list in from_address → the non-lead-domain one
 *
 * The CLIENT mirror lives in client/src/types/emailReply.ts (resolveOurMailbox).
 * Keep the two ladders in sync.
 */
import { extractEmailAddress, extractAllEmailAddresses } from './types.js';

export interface ThreadMailboxRow {
    direction?: string | null;            // 'IN' | 'OUT'
    sender_email?: string | null;
    account_email?: string | null;        // canonical column (preferred)
    raw_payload?: Record<string, unknown> | null;
}

export function resolveThreadMailbox(row: ThreadMailboxRow | null | undefined): string | null {
    if (!row) return null;

    // 1. Canonical column wins
    if (row.account_email) return row.account_email;

    // 2. Legacy raw_payload fallback
    const rp = (row.raw_payload || {}) as Record<string, unknown>;
    const leadDomain = row.sender_email?.split('@')[1]?.toLowerCase();

    if (row.direction === 'OUT') {
        return extractEmailAddress(rp.from_address as string | null);
    }

    if (rp.source === 'SMTP') {
        return extractEmailAddress(
            (rp.email_account_name as string | null) ??
            (rp.to_email as string | null) ??
            (rp.to as string | null),
        );
    }

    const addrs = extractAllEmailAddresses(rp.from_address as string | null);
    if (addrs.length === 1) {
        return addrs[0].split('@')[1]?.toLowerCase() !== leadDomain ? addrs[0] : null;
    }
    if (addrs.length > 1) {
        return addrs.find((a) => a.split('@')[1]?.toLowerCase() !== leadDomain) ?? null;
    }
    return null;
}
