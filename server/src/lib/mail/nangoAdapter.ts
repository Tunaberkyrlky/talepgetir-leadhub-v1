/**
 * Nango adapter — sends via the user's connected Gmail/Outlook mailbox.
 * Wraps the existing emailSender.sendEmail. Inbound (Gmail/Outlook pull) is Faz 3.
 */
import { sendEmail } from '../emailSender.js';
import type { CanonicalSendRequest, SendResult, MailProvider } from './types.js';

export const nangoProvider: MailProvider = {
    name: 'gmail', // logical name; the concrete provider (gmail/outlook) is chosen inside emailSender by the tenant's active connection
    supportsAttachments: () => true,
    // Gmail-safe default. Outlook's Graph inline cap is ~3MB; willSupportAttachments()
    // narrows the cap to the concrete connection so Outlook files >3MB card-fall-back.
    maxAttachmentBytes: 15 * 1024 * 1024,
    async send(req: CanonicalSendRequest): Promise<SendResult> {
        const res = await sendEmail(req.tenantId, req.to, req.subject, req.bodyHtml, {
            fromName: req.fromName,
            cc: req.cc,
            replyTo: req.replyTo,
            accountEmail: req.accountEmail ?? undefined,
            ...(req.files?.length && { attachments: req.files }),
            ...(req.listUnsubscribe && { listUnsubscribe: req.listUnsubscribe }),
            // Thread'leme (task-3): takip mailinin bağları.
            inReplyTo: req.threading?.inReplyTo ?? undefined,
            references: req.threading?.references ?? undefined,
            gmailThreadId: req.threading?.gmailThreadId ?? undefined,
        });
        // emailSender returns the concrete provider ('google-mail' | 'microsoft-outlook')
        const provider = res.provider === 'microsoft-outlook' ? 'outlook' : 'gmail';
        return {
            provider,
            providerMessageId: res.messageId,
            success: res.success,
            rfcMessageId: res.rfcMessageId ?? null,
            providerThreadId: res.providerThreadId ?? null,
            threadIdDropped: res.threadIdDropped ?? false,
        };
    },
};
