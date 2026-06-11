/**
 * IMAP adapter — normalizes a fetched message into a CanonicalMessage.
 * Sending is not supported here (IMAP is read-only); polling lives in imapInbound.ts.
 */
import type { ParsedMail, AddressObject } from 'mailparser';
import type { CanonicalMessage } from './types.js';
import { extractEmailAddress } from './types.js';

function addressText(addr: AddressObject | AddressObject[] | undefined): string | null {
    if (!addr) return null;
    if (Array.isArray(addr)) return addr.map((a) => a.text).filter(Boolean).join(', ') || null;
    return addr.text || null;
}

/**
 * Map a parsed IMAP message to a CanonicalMessage (inbound).
 * The caller sets providerMessageId from the IMAP UID afterwards.
 */
export function parseImapInbound(
    parsed: ParsedMail,
    accountEmail: string,
    tenantId: string,
): CanonicalMessage {
    const fromAddress =
        parsed.from?.value?.[0]?.address
        ?? extractEmailAddress(parsed.from?.text)
        ?? '';

    return {
        provider: 'imap',
        providerMessageId: null,         // set to UID by the poller
        providerThreadId: 'INBOX',
        rfcMessageId: parsed.messageId ?? null,
        inReplyTo: typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : null,
        direction: 'inbound',
        channel: null,
        tenantId,
        campaignId: null,
        campaignName: null,
        accountEmail,
        fromAddress,
        toAddress: addressText(parsed.to),
        ccAddress: addressText(parsed.cc),
        senderEmail: fromAddress,
        subject: parsed.subject ?? null,
        bodyText: parsed.text ?? null,
        bodyHtml: typeof parsed.html === 'string' ? parsed.html : null,
        label: null,
        sentiment: null,
        occurredAt: parsed.date ? parsed.date.toISOString() : null,
    };
}
