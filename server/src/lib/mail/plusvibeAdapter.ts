/**
 * PlusVibe adapter — normalizes PlusVibe inbound (webhook + API) into
 * CanonicalMessage, and sends replies/forwards via the PlusVibe API.
 */
import {
    replyToEmail,
    forwardEmail,
    type PlusVibeEmail,
    type PlusVibeCampaignEmail,
} from '../plusvibeClient.js';
import { createLogger } from '../logger.js';
import {
    type CanonicalMessage,
    type CanonicalSendRequest,
    type SendResult,
    type MailProvider,
    extractEmailAddress,
    extractAllEmailAddresses,
} from './types.js';

const log = createLogger('mail:plusvibe');

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Among recipients, the address whose domain isn't the lead's = our mailbox. */
function ourMailboxFromRecipients(recipientList: string | null, leadEmail: string | null): string | null {
    const leadDomain = leadEmail?.split('@')[1]?.toLowerCase();
    const addrs = extractAllEmailAddresses(recipientList);
    if (!leadDomain) return addrs[0] ?? null;
    return addrs.find((a) => a.split('@')[1]?.toLowerCase() !== leadDomain) ?? null;
}

/**
 * Parse a PlusVibe webhook body (SMTP source = rich; older = sparse) into a
 * CanonicalMessage. tenantId is resolved by the caller (URL today, camp_id in Faz 2).
 */
export function parseWebhookInbound(body: Record<string, unknown>, tenantId: string | null): CanonicalMessage {
    const fromEmail = str(body.from_email) ?? str(body.actual_replied_from);
    const toEmail = str(body.to_email) ?? str(body.to);
    const accountName = str(body.email_account_name);
    const senderEmail = fromEmail ?? '';

    return {
        provider: 'plusvibe',
        providerMessageId: str(body.plusvibe_email_id) ?? str(body.email_id),
        providerThreadId: str(body.thread_id) ?? str(body.source_thread_id),
        rfcMessageId: str(body.message_id),
        inReplyTo: str(body.in_reply_to) ?? str(body.references),
        direction: 'inbound',
        channel: null,
        tenantId,
        campaignId: str(body.camp_id),
        campaignName: str(body.campaign_name),
        accountEmail: accountName ?? toEmail ?? ourMailboxFromRecipients(str(body.cc), senderEmail),
        fromAddress: fromEmail,
        toAddress: toEmail,
        ccAddress: str(body.cc),
        senderEmail,
        subject: str(body.subject),
        bodyText: str(body.text_body) ?? str(body.snippet),
        bodyHtml: str(body.body),
        label: str(body.label),
        sentiment: str(body.sentiment),
        occurredAt: str(body.replied_date) ?? null,
        hints: { companyName: str(body.company_name), companyWebsite: str(body.company_website) },
        plusvibeLeadId: str(body.lead_id),
    };
}

/** Parse a PlusVibe API reply (PlusVibeEmail) into a CanonicalMessage. */
export function parseApiReply(reply: PlusVibeEmail, campaignName: string | null): CanonicalMessage {
    const rec = reply as Record<string, unknown>;
    const inbound = reply.direction !== 'OUT';
    const fromAddr = extractEmailAddress(reply.from_address_email);
    // The lead = thread-grouping key. For OUT, the lead is the recipient whose
    // domain isn't ours; if that can't be picked (single-domain / odd recipient
    // list) fall back to the first recipient, NOT our own from-address — using
    // our mailbox would split the thread away from the inbound messages.
    const leadEmail = inbound
        ? fromAddr
        : (ourMailboxFromRecipients(reply.to_address_email_list, fromAddr)
            ?? extractEmailAddress(reply.to_address_email_list));
    const sentiment = str((reply.lead as Record<string, unknown> | undefined)?.sentiment);

    // `eaccount` is PlusVibe's connected account that owns the email (= OUR mailbox),
    // present + clean on both directions — the API equivalent of the webhook's
    // email_account_name. Prefer it; fall back to recipient-list extraction.
    const eaccount = extractEmailAddress(str(rec.eaccount));
    const accountEmail = eaccount
        ?? (inbound ? ourMailboxFromRecipients(reply.to_address_email_list, fromAddr) : fromAddr);

    return {
        provider: 'plusvibe',
        providerMessageId: str(reply.id),
        providerThreadId: str(reply.thread_id),
        rfcMessageId: str(rec.message_id),
        inReplyTo: null,
        direction: inbound ? 'inbound' : 'outbound',
        channel: null,
        tenantId: null, // set by caller
        campaignId: str(reply.campaign_id),
        campaignName,
        accountEmail,
        fromAddress: fromAddr,
        toAddress: str(reply.to_address_email_list),
        ccAddress: str(rec.cc_address_email_list),
        senderEmail: (inbound ? fromAddr : leadEmail) ?? reply.from_address_email,
        subject: str(reply.subject),
        bodyText: str(reply.content_preview) ?? str(reply.body),
        bodyHtml: null,
        label: str(reply.label),
        sentiment,
        occurredAt: str(reply.timestamp_created),
        plusvibeLeadId: str(reply.lead_id),
    };
}

/** Decode the HTML entities that show up in campaign bodies (numeric + common named). */
function decodeEntities(s: string): string {
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&nbsp;/gi, ' ')
        .replace(/&mdash;/gi, '—')
        .replace(/&ndash;/gi, '–')
        .replace(/&hellip;/gi, '…')
        .replace(/&lsquo;/gi, '‘')
        .replace(/&rsquo;/gi, '’')
        .replace(/&ldquo;/gi, '“')
        .replace(/&rdquo;/gi, '”')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&'); // amp last to avoid double-decoding
}

/** Best-effort HTML → plain text for storing a sent campaign body in reply_body. */
function htmlToPlainText(html: string | null): string | null {
    if (!html) return null;
    const text = decodeEntities(
        html
            .replace(/<\s*br\s*\/?>/gi, '\n')
            .replace(/<\s*\/\s*(p|div|tr|li|h[1-6])\s*>/gi, '\n')
            .replace(/<[^>]+>/g, ''),
    )
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
    return text || null;
}

/**
 * Parse a PlusVibe campaign-email record (/unibox/campaign-emails) — an OUTBOUND
 * sequence send (first-touch + steps) — into a CanonicalMessage. senderEmail is
 * the lead (recipient) so it threads with the inbound reply.
 */
export function parseCampaignEmail(rec: PlusVibeCampaignEmail, campaignName: string | null): CanonicalMessage {
    const lead = extractEmailAddress(rec.lead);
    const account = extractEmailAddress(rec.eaccount);
    const isHtml = !rec.is_text;
    return {
        provider: 'plusvibe',
        providerMessageId: str(rec.id),
        providerThreadId: null,
        rfcMessageId: str(rec.message_id),
        inReplyTo: null,
        direction: 'outbound',
        channel: 'campaign',
        tenantId: null, // set by caller
        campaignId: str(rec.campaign_id),
        campaignName,
        accountEmail: account,
        fromAddress: account,
        toAddress: str(rec.lead),
        ccAddress: null,
        senderEmail: (lead ?? str(rec.lead)) ?? '',
        subject: str(rec.subject),
        bodyText: isHtml ? htmlToPlainText(str(rec.body)) : str(rec.body),
        bodyHtml: isHtml ? str(rec.body) : null,
        label: null,
        sentiment: null,
        occurredAt: str(rec.sent_on),
        plusvibeLeadId: str(rec.lead_id),
    };
}

// ─── Send (reply / forward) ────────────────────────────────────────────────

export const plusvibeProvider: MailProvider = {
    name: 'plusvibe',
    async send(req: CanonicalSendRequest): Promise<SendResult> {
        if (!req.inReplyToMessageId) {
            throw new Error('PlusVibe send requires inReplyToMessageId (the original PlusVibe email id)');
        }
        if (!req.accountEmail) {
            throw new Error('PlusVibe send requires accountEmail (the mailbox to send from)');
        }
        const cc = req.cc?.length ? req.cc.join(', ') : undefined;

        const result =
            req.channel === 'forward'
                ? await forwardEmail({
                      reply_to_id: req.inReplyToMessageId,
                      from: req.accountEmail,
                      to: req.to,
                      body: req.bodyHtml,
                      ...(cc && { cc }),
                  })
                : await replyToEmail({
                      reply_to_id: req.inReplyToMessageId,
                      subject: req.subject,
                      from: req.accountEmail,
                      to: req.to,
                      body: req.bodyHtml,
                      ...(cc && { cc }),
                  });

        log.info({ channel: req.channel, from: req.accountEmail, to: req.to, id: result.id }, 'PlusVibe send');
        return { provider: 'plusvibe', providerMessageId: result.id, success: true };
    },
};
