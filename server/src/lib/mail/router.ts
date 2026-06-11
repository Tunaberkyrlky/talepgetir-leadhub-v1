/**
 * MailRouter — single send entry point. Picks the provider by the sending
 * mailbox's type (accountEmail → connection), then the thread's origin provider,
 * then the channel default.
 *
 *   system                       → Resend (brand transactional)
 *   accountEmail is SMTP         → SMTP (tenant's own server)
 *   accountEmail is Gmail/Outlook→ Nango
 *   reply | forward (no account) → thread origin: plusvibe→PlusVibe, gmail/outlook→Nango, smtp→SMTP
 *   campaign | compose default   → Nango
 */
import { createLogger } from '../logger.js';
import type { CanonicalSendRequest, SendResult, MailProvider } from './types.js';
import { plusvibeProvider } from './plusvibeAdapter.js';
import { nangoProvider } from './nangoAdapter.js';
import { resendProvider } from './resendAdapter.js';
import { smtpProvider } from './smtpAdapter.js';
import { getConnectionByEmail } from '../emailConnections.js';

const log = createLogger('mail:router');

async function resolveProvider(req: CanonicalSendRequest): Promise<MailProvider> {
    if (req.channel === 'system') return resendProvider;

    // 1. Explicit sending mailbox → route by its connection type.
    //    (PlusVibe sender addresses aren't in email_connections → conn is null → fall through.)
    if (req.accountEmail) {
        const conn = await getConnectionByEmail(req.tenantId, req.accountEmail);
        if (conn?.provider === 'smtp') return smtpProvider;
        if (conn?.provider === 'google-mail' || conn?.provider === 'microsoft-outlook') return nangoProvider;
    }

    // 2. reply | forward → thread's origin provider
    switch (req.originProvider) {
        case 'smtp': return smtpProvider;
        case 'gmail':
        case 'outlook': return nangoProvider;
        case 'plusvibe': return plusvibeProvider;
    }

    // 3. channel default (campaign/compose without an explicit account)
    if (req.channel === 'campaign' || req.channel === 'compose') return nangoProvider;
    return plusvibeProvider;
}

export async function sendMail(req: CanonicalSendRequest): Promise<SendResult> {
    const provider = await resolveProvider(req);
    log.info(
        { channel: req.channel, origin: req.originProvider, provider: provider.name, to: req.to },
        'Routing outbound mail',
    );
    return provider.send(req);
}
