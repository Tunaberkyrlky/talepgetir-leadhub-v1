/**
 * Resend adapter — sends brand/system transactional mail (digests, invites,
 * password resets) from a fixed brand address. Wraps systemMailer.sendSystemEmail.
 * Send-only (no inbound).
 */
import { sendSystemEmail } from '../systemMailer.js';
import type { CanonicalSendRequest, SendResult, MailProvider } from './types.js';

export const resendProvider: MailProvider = {
    name: 'resend',
    // System/brand mail (digests, invites) doesn't carry user attachments.
    supportsAttachments: () => false,
    maxAttachmentBytes: 0,
    async send(req: CanonicalSendRequest): Promise<SendResult> {
        const res = await sendSystemEmail({
            to: req.to,
            subject: req.subject,
            html: req.bodyHtml,
            text: req.bodyText,
            replyTo: req.replyTo,
            cc: req.cc,
            bcc: req.bcc,
        });
        return { provider: 'resend', providerMessageId: res.messageId, success: res.success };
    },
};
