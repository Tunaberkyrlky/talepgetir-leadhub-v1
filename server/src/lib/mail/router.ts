/**
 * MailRouter — single send entry point. Picks the provider by channel and the
 * thread's origin provider, so a reply goes back out the SAME channel it arrived.
 *
 *   system                    → Resend (brand transactional)
 *   campaign                  → Nango (drip from user's own mailbox)
 *   reply | forward           → the thread's origin provider:
 *                                 plusvibe thread → PlusVibe
 *                                 gmail/outlook   → Nango
 */
import { createLogger } from '../logger.js';
import type { CanonicalSendRequest, SendResult, MailProvider } from './types.js';
import { plusvibeProvider } from './plusvibeAdapter.js';
import { nangoProvider } from './nangoAdapter.js';
import { resendProvider } from './resendAdapter.js';

const log = createLogger('mail:router');

function pickProvider(req: CanonicalSendRequest): MailProvider {
    if (req.channel === 'system') return resendProvider;
    if (req.channel === 'campaign') return nangoProvider;

    // reply | forward → route by the thread's origin provider
    switch (req.originProvider) {
        case 'gmail':
        case 'outlook':
            return nangoProvider;
        case 'plusvibe':
        default:
            return plusvibeProvider; // default: PlusVibe (current inbound source)
    }
}

export async function sendMail(req: CanonicalSendRequest): Promise<SendResult> {
    const provider = pickProvider(req);
    log.info(
        { channel: req.channel, origin: req.originProvider, provider: provider.name, to: req.to },
        'Routing outbound mail',
    );
    return provider.send(req);
}
