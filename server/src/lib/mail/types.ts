/**
 * Canonical Mail Layer — shared domain types + pure helpers.
 *
 * Every provider (PlusVibe, Nango/Gmail/Outlook, Resend) normalizes inbound
 * messages INTO a CanonicalMessage and accepts outbound sends AS a
 * CanonicalSendRequest. App code (matching, storage, display, send) works
 * against these shapes only — provider detail stays inside each adapter.
 */

export type MailProviderName = 'plusvibe' | 'gmail' | 'outlook' | 'resend' | 'smtp' | 'imap';
export type MailDirection = 'inbound' | 'outbound';
export type MailChannel = 'reply' | 'forward' | 'compose' | 'campaign' | 'system';

/** A normalized message, provider-agnostic. Maps 1:1 to an email_replies row. */
export interface CanonicalMessage {
    provider: MailProviderName;
    providerMessageId: string | null;   // PlusVibe email id / Gmail msg id / Resend id
    providerThreadId: string | null;    // PlusVibe thread_id / Gmail threadId
    rfcMessageId: string | null;        // RFC 2822 Message-ID
    inReplyTo: string | null;           // RFC 2822 In-Reply-To
    direction: MailDirection;
    channel: MailChannel | null;        // outbound intent (null for inbound)

    tenantId: string | null;            // null until routed (Faz 2 pending)
    campaignId: string | null;
    campaignName: string | null;

    // parties — the canonical from/to that fix the whole mess
    accountEmail: string | null;        // OUR mailbox on this thread
    fromAddress: string | null;         // who sent THIS message
    toAddress: string | null;           // recipients, comma-separated
    ccAddress: string | null;
    senderEmail: string;                // thread/lead grouping key (legacy)

    subject: string | null;
    bodyText: string | null;
    bodyHtml: string | null;

    label: string | null;
    sentiment: string | null;
    occurredAt: string | null;          // ISO; maps to replied_at

    // provider enrichment hints for matching (not the matched result)
    hints?: { companyName?: string | null; companyWebsite?: string | null };
    // PlusVibe lead id passthrough (matching/import)
    plusvibeLeadId?: string | null;
    // anything else worth keeping raw
    rawPayload?: Record<string, unknown> | null;
}

/** An outbound send, provider-agnostic. The router picks the provider. */
export interface CanonicalSendRequest {
    channel: MailChannel;
    tenantId: string;
    originProvider?: MailProviderName;   // provider of the thread (reply/forward routing)
    inReplyToMessageId?: string | null;  // provider_message_id of the message being replied to/forwarded

    accountEmail?: string | null;        // our mailbox to send FROM (resolved canonically)
    to: string;
    cc?: string[];
    bcc?: string[];
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    replyTo?: string;
    fromName?: string;

    campaignId?: string | null;
    // provider passthrough (e.g. attachment ids already resolved by the caller)
    meta?: Record<string, unknown>;

    // RFC 8058 tek-tık abonelikten çıkma. YALNIZ kampanya gönderimlerinde set edilir
    // (footer'ı taşıyan mailler). Header set edebilen adapter'lar (Gmail MIME, SMTP,
    // Outlook MIME) buradan List-Unsubscribe + List-Unsubscribe-Post üretir. Sadece-JSON
    // sağlayıcılar (Outlook JSON fallback, Resend) bu alanı yok sayar.
    listUnsubscribe?: ListUnsubscribe;

    // Thread'leme (task-3). YALNIZ takip mailleri için (step > 1) set edilir; ilk mailde
    // yoktur (kök). Header set edebilen yollar (Gmail MIME, Outlook MIME, SMTP) In-Reply-To
    // + References üretir; Gmail ayrıca native threadId'i send çağrısına geçer. Message-ID
    // ise her gönderimde adapter tarafından üretilir (SendResult.rfcMessageId ile döner).
    threading?: OutboundThreading;

    // Real-attachment candidates (caller already appended any link-card ones to
    // bodyHtml). The router loads their bytes into `files` before dispatch.
    attachments?: CanonicalAttachment[];
    // Bytes-loaded attachments — set by the router (sendMail), consumed by adapters.
    files?: ResolvedAttachment[];
}

/**
 * RFC 8058 List-Unsubscribe verisi. `httpsUrl` hem tarayıcı GET'ini hem de
 * tek-tık POST'unu karşılar; `mailto` insan/manuel işleme için yedektir.
 */
export interface ListUnsubscribe {
    httpsUrl: string;   // https abonelikten-çıkma ucu (tarayıcı GET + tek-tık POST)
    mailto?: string;    // "mailto:kutu@x.com?subject=..." yedeği (olmayabilir)
}

/**
 * RFC 8058 / RFC 2369 List-Unsubscribe header çiftini üretir. mailto varsa önce
 * o, sonra https gelir; tek-tık için https + List-Unsubscribe-Post zorunludur.
 */
export function listUnsubscribeHeaders(u: ListUnsubscribe): Record<string, string> {
    const targets = [u.mailto && `<${u.mailto}>`, `<${u.httpsUrl}>`].filter(Boolean);
    return {
        'List-Unsubscribe': targets.join(', '),
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
}

/**
 * Bir takip mailini ilk mailin thread'ine bağlayan giriş verisi. Kampanya engine'i
 * üretir; ilk mail (thread kökü) için hiç geçilmez.
 */
export interface OutboundThreading {
    inReplyTo?: string | null;      // ebeveyn Message-ID → In-Reply-To header'ı
    references?: string | null;     // önceki id'lerin boşlukla ayrılmış zinciri → References
    gmailThreadId?: string | null;  // Gmail native threadId (yalnız aynı Gmail kutusundan)
}

export interface SendResult {
    provider: MailProviderName;
    providerMessageId: string;
    success: boolean;
    // Bu gönderimde gerçekten kullanılan RFC Message-ID (header'a yazılan/nodemailer'ın
    // ürettiği, köşeli parantezli). Thread durumu için engine bunu saklar; header üretemeyen
    // yollar (Outlook JSON fallback, Resend) null döner → o enrollment thread'siz kalır.
    rfcMessageId?: string | null;
    // Gmail send yanıtındaki threadId (varsa). Takip maillerinde native thread için saklanır.
    providerThreadId?: string | null;
    // Labels of real-file attachments the router could NOT load (e.g. storage
    // download failed) and therefore did NOT attach. The message still sent, so
    // the caller must surface this so the user knows the file was left off.
    droppedAttachments?: string[];
}

/**
 * A user-selected attachment, pre-partitioned by the caller as a real-file
 * candidate. URL-only templates and link-fallbacks are appended to bodyHtml as
 * cards by the caller and never reach here. The router loads bytes into `files`.
 */
export interface CanonicalAttachment {
    label: string;
    fileType: string;              // extension without dot, e.g. 'pdf'
    fileSize: string;              // humanized, for the card fallback
    fileUrl: string;               // public URL (card target; always present)
    storagePath?: string | null;   // bucket object path if uploaded → real-attachable
    sizeBytes?: number | null;     // actual byte size (cap check)
    originalFilename?: string | null; // uploaded file's real name WITH extension; the attachment filename
}

/** An attachment with bytes loaded, ready to hand to a provider's send API. */
export interface ResolvedAttachment {
    filename: string;
    mimeType: string;
    content: Buffer;
}

/** A provider adapter. Inbound parsing is provider-specific (not all support it). */
export interface MailProvider {
    readonly name: MailProviderName;
    send(req: CanonicalSendRequest): Promise<SendResult>;
    /** Can this provider deliver a real file attachment for this request's channel? */
    supportsAttachments(req: CanonicalSendRequest): boolean;
    /** Max raw bytes per real attachment; larger → caller falls back to a link card. */
    readonly maxAttachmentBytes: number;
}

// ─── Pure helpers (shared) ────────────────────────────────────────────────

/** "Name <email@x.com>" or "email@x.com" → bare email (or input if no brackets). */
export function extractEmailAddress(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    const m = trimmed.match(/<([^>]+)>/);
    return m ? m[1].trim() : (trimmed || null);
}

/** Comma/whitespace-separated address list → every bare email. */
export function extractAllEmailAddresses(raw: string | null | undefined): string[] {
    if (!raw) return [];
    const angled = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim()).filter(Boolean);
    if (angled.length > 0) return angled;
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Split an email body into the fresh reply vs the quoted history beneath it.
 * Ported from the client (ReplyDetailModal.splitEmailBody) so the webhook can
 * keep only the meaningful text for very large bodies.
 */
export function splitEmailBody(body: string): { fresh: string; quoted: string | null } {
    if (!body) return { fresh: '', quoted: null };
    const patterns = [
        /^From:[ \t]+\S/m,
        /^On .+?wrote:/m,
        /^-{3,}[ \t]*(?:original|forwarded)/im,
        /^[ \t]*>/m,
    ];
    let splitIndex = body.length;
    for (const pattern of patterns) {
        const match = body.match(pattern);
        if (match?.index !== undefined && match.index > 10) {
            splitIndex = Math.min(splitIndex, match.index);
        }
    }
    if (splitIndex === body.length) return { fresh: body, quoted: null };
    const fresh = body.slice(0, splitIndex).trimEnd();
    if (!fresh) return { fresh: body, quoted: null };
    return { fresh, quoted: body.slice(splitIndex) };
}

/** Map a CanonicalMessage to an email_replies insert row (snake_case DB shape). */
export function canonicalToReplyRow(m: CanonicalMessage): Record<string, unknown> {
    return {
        tenant_id: m.tenantId,
        campaign_id: m.campaignId,
        campaign_name: m.campaignName,
        sender_email: m.senderEmail.toLowerCase().trim(),
        reply_body: m.bodyText,
        body_html: m.bodyHtml,
        replied_at: m.occurredAt,
        direction: m.direction === 'inbound' ? 'IN' : 'OUT',
        channel: m.channel,
        provider: m.provider,
        provider_message_id: m.providerMessageId,
        provider_thread_id: m.providerThreadId,
        rfc_message_id: m.rfcMessageId,
        in_reply_to: m.inReplyTo,
        account_email: m.accountEmail,
        from_address: m.fromAddress,
        to_address: m.toAddress,
        cc_address: m.ccAddress,
        subject: m.subject,
        label: m.label,
        sentiment: m.sentiment,
        plusvibe_lead_id: m.plusvibeLeadId ?? null,
        raw_payload: m.rawPayload ?? null,
    };
}
