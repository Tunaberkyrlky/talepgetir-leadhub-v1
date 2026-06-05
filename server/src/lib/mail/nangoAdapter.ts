/**
 * Nango adapter — sends via the user's connected Gmail/Outlook mailbox.
 * Wraps the existing emailSender.sendEmail. Inbound (Gmail/Outlook pull) is Faz 3.
 */
import { sendEmail } from '../emailSender.js';
import type { CanonicalSendRequest, SendResult, MailProvider } from './types.js';

export const nangoProvider: MailProvider = {
    name: 'gmail', // logical name; the concrete provider (gmail/outlook) is chosen inside emailSender by the tenant's active connection
    async send(req: CanonicalSendRequest): Promise<SendResult> {
        const res = await sendEmail(req.tenantId, req.to, req.subject, req.bodyHtml, {
            fromName: req.fromName,
            cc: req.cc,
            replyTo: req.replyTo,
        });
        // emailSender returns the concrete provider ('google-mail' | 'microsoft-outlook')
        const provider = res.provider === 'microsoft-outlook' ? 'outlook' : 'gmail';
        return { provider, providerMessageId: res.messageId, success: res.success };
    },
};
