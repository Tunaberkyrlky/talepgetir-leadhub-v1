/**
 * Live PlusVibe sender-mailbox resolver.
 *
 * Cold-email sending domains rotate: PlusVibe deletes burned mailboxes and adds
 * fresh ones on new domains. A thread's stored `account_email` therefore drifts —
 * it can point at a mailbox that no longer exists in the workspace. Replying/
 * forwarding `from` that deleted mailbox fails with PlusVibe 400
 * "Email Account has been deleted."
 *
 * This resolves the effective LIVE sender for a reply/forward against the
 * campaign's current accounts: if the desired mailbox is still an account, use it;
 * otherwise substitute a live one — preferring the SAME person (local-part) on a
 * fresh domain (y.sener@old.com → y.sener@new.online), falling back to the first
 * live account. Callers surface `substituted` so the user knows the from-address
 * changed (domain quality / rotation).
 */
import { getCampaignAccounts } from './plusvibeClient.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from './logger.js';

const log = createLogger('plusvibe-sender-mailbox');

// Live accounts change slowly (domain rotation is a manual ops step). A short TTL
// cache keeps user-initiated replies from hitting the PlusVibe API on every send.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { accounts: string[]; expires: number }>();

async function liveAccounts(campaignId: string): Promise<string[]> {
    const now = Date.now();
    const hit = cache.get(campaignId);
    if (hit && hit.expires > now) return hit.accounts;
    const accounts = await getCampaignAccounts(campaignId);
    cache.set(campaignId, { accounts, expires: now + CACHE_TTL_MS });
    return accounts;
}

export interface LiveSenderResult {
    email: string;            // the mailbox to actually send from (guaranteed live)
    substituted: boolean;     // true → desired was deleted, we swapped it
    previous: string | null;  // the deleted mailbox we replaced (only when substituted)
}

/**
 * Resolve the live mailbox to send a PlusVibe reply/forward from.
 * @throws AppError(409) when the campaign has no live sending account at all.
 */
export async function resolveLiveSenderMailbox(
    campaignId: string,
    desired: string,
): Promise<LiveSenderResult> {
    const accounts = await liveAccounts(campaignId);

    if (accounts.length === 0) {
        throw new AppError(
            'This campaign has no active PlusVibe sending mailbox, so the reply cannot be sent.',
            409,
        );
    }

    const want = desired.trim().toLowerCase();
    const exact = accounts.find((a) => a.toLowerCase() === want);
    if (exact) return { email: exact, substituted: false, previous: null };

    // Deleted / rotated out. Prefer the SAME person on a live domain so the reply
    // still reads as "y.sener@…"; else fall back to the first live account.
    const localPart = want.split('@')[0];
    const samePerson = accounts.find((a) => a.toLowerCase().split('@')[0] === localPart);
    const chosen = samePerson ?? accounts[0];

    log.info(
        { campaignId, desired, chosen, samePerson: !!samePerson },
        'Sender mailbox deleted in PlusVibe — substituted a live campaign account',
    );
    return { email: chosen, substituted: true, previous: desired };
}
