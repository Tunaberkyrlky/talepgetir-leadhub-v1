/** Resolve a live PlusVibe campaign mailbox after the stored sender was deleted. */
import { getCampaignAccounts } from './plusvibeClient.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from './logger.js';

const log = createLogger('plusvibe-sender-mailbox');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LiveSenderResult {
    email: string;
    previous: string;
}

export function chooseLiveSenderMailbox(accounts: string[], desired: string): LiveSenderResult | null {
    const wanted = desired.trim().toLowerCase();
    const live = [...new Set(
        accounts
            .map((account) => account.trim())
            .filter((account) => EMAIL_RE.test(account))
            .filter((account) => account.toLowerCase() !== wanted),
    )];
    if (!live.length) return null;

    const localPart = wanted.split('@')[0];
    const samePerson = live.find((account) => account.toLowerCase().split('@')[0] === localPart);
    return { email: samePerson ?? live[0], previous: desired };
}

/** Always fetch fresh accounts: this function is called only after a deleted-mailbox error. */
export async function resolveLiveSenderMailbox(campaignId: string, desired: string): Promise<LiveSenderResult> {
    const replacement = chooseLiveSenderMailbox(await getCampaignAccounts(campaignId), desired);
    if (!replacement) {
        throw new AppError(
            'This campaign has no alternative active PlusVibe sending mailbox, so the reply cannot be sent.',
            409,
        );
    }

    log.info(
        { campaignId, previous: desired, current: replacement.email },
        'Deleted PlusVibe sender replaced with a live campaign account',
    );
    return replacement;
}
