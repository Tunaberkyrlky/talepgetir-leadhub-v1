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
import { htmlToPlainText } from '../htmlText.js';
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
        // PlusVibe's ALL_EMAIL_REPLIES webhook carries the replied email's PlusVibe id
        // in `last_email_id` (not `plusvibe_email_id`/`email_id`, which it never sends).
        // Capturing it lets replies use this id directly instead of a live unibox lookup.
        providerMessageId: str(body.plusvibe_email_id) ?? str(body.email_id) ?? str(body.last_email_id),
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

/**
 * Parse a PlusVibe campaign-email record (/unibox/campaign-emails) — an OUTBOUND
 * sequence send (first-touch + steps) — into a CanonicalMessage. senderEmail is
 * the lead (recipient) so it threads with the inbound reply.
 */
export function parseCampaignEmail(rec: PlusVibeCampaignEmail, campaignName: string | null): CanonicalMessage {
    const lead = extractEmailAddress(rec.lead);
    const account = extractEmailAddress(rec.eaccount);
    const isHtml = !rec.is_text;
    const rawBody = str(rec.body);
    // Strip NUL bytes — Postgres TEXT columns reject 0x00 and would fail the insert.
    const NUL = String.fromCharCode(0);
    const stripNul = (v: string | null): string | null => (v ? v.split(NUL).join('') || null : null);
    const bodyText = stripNul(isHtml ? htmlToPlainText(rawBody) : rawBody);
    const bodyHtml = isHtml ? stripNul(rawBody) : null;
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
        bodyText,
        bodyHtml,
        label: null,
        sentiment: null,
        occurredAt: str(rec.sent_on),
        plusvibeLeadId: str(rec.lead_id),
    };
}

// ─── Send (reply / forward) ────────────────────────────────────────────────

export const plusvibeProvider: MailProvider = {
    name: 'plusvibe',
    // PlusVibe delivers real attachments via the reply/forward API's attachments[]
    // (file_name + base64 content) — verified end-to-end 2026-06-29: a 59 KB PDF sent
    // through /unibox/emails/reply arrived intact at the recipient. (An earlier note
    // claimed silent non-delivery; that turned out to be wrong.) The 10 MB cap mirrors
    // the upload limit in attachment-templates.ts, so every stored file fits.
    supportsAttachments: () => true,
    maxAttachmentBytes: 10 * 1024 * 1024,
    async send(req: CanonicalSendRequest): Promise<SendResult> {
        if (!req.inReplyToMessageId) {
            throw new Error('PlusVibe send requires inReplyToMessageId (the original PlusVibe email id)');
        }
        if (!req.accountEmail) {
            throw new Error('PlusVibe send requires accountEmail (the mailbox to send from)');
        }
        const cc = req.cc?.length ? req.cc.join(', ') : undefined;
        const attachments = req.files?.length
            ? req.files.map((f) => ({ file_name: f.filename, content: f.content.toString('base64') }))
            : undefined;

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
                      ...(attachments && { attachments }),
                  });

        log.info(
            { channel: req.channel, from: req.accountEmail, to: req.to, id: result.id, files: attachments?.length ?? 0 },
            'PlusVibe send',
        );
        return { provider: 'plusvibe', providerMessageId: result.id, success: true };
    },
};
