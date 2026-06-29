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
import type { CanonicalSendRequest, SendResult, MailProvider, CanonicalAttachment, ResolvedAttachment } from './types.js';
import { plusvibeProvider } from './plusvibeAdapter.js';
import { nangoProvider } from './nangoAdapter.js';
import { resendProvider } from './resendAdapter.js';
import { smtpProvider } from './smtpAdapter.js';
import { getConnectionByEmail } from '../emailConnections.js';
import { resolveNangoProvider } from '../emailSender.js';
import { supabaseAdmin } from '../supabase.js';

const OUTLOOK_MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024; // Graph inline /sendMail cap

const log = createLogger('mail:router');

const ATTACHMENT_BUCKET = 'email-attachments';

// ext → MIME for the upload whitelist (server ALLOWED_EXTS). octet-stream fallback.
const EXT_MIME: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    txt: 'text/plain',
};

function mimeForExt(ext: string): string {
    return EXT_MIME[ext.toLowerCase().replace(/^\./, '')] || 'application/octet-stream';
}

/**
 * Download each candidate's bytes from Storage into a provider-ready attachment.
 * Returns the loaded files plus the labels of any that could NOT be loaded, so
 * the caller can tell the user which attachments were left off the sent message.
 */
async function loadAttachmentFiles(atts: CanonicalAttachment[]): Promise<{ files: ResolvedAttachment[]; failed: string[] }> {
    const out: ResolvedAttachment[] = [];
    const failed: string[] = [];
    for (const a of atts) {
        if (!a.storagePath) continue; // only uploaded files have bytes
        const { data, error } = await supabaseAdmin.storage.from(ATTACHMENT_BUCKET).download(a.storagePath);
        if (error || !data) {
            log.warn({ err: error, path: a.storagePath }, 'Attachment download failed; skipping file');
            failed.push(a.originalFilename || a.label);
            continue;
        }
        const content = Buffer.from(await data.arrayBuffer());
        const ext = a.fileType.replace(/^\./, '').toLowerCase();
        // The recipient-visible filename MUST carry the real extension — providers
        // (esp. cold-email relays like PlusVibe) silently strip attachments whose
        // name has no recognized extension. Prefer the uploaded original_filename
        // (already has it); otherwise append `.ext` to the label unless it already
        // ends with that exact extension. (The old `/\.[^.]+$/` test wrongly read a
        // trailing token like "06.2026" as an extension and dropped the real one.)
        const base = (a.originalFilename || a.label).trim();
        const filename = (base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`).slice(0, 255);
        out.push({ filename, mimeType: mimeForExt(a.fileType), content });
    }
    return { files: out, failed };
}

export async function resolveProvider(req: CanonicalSendRequest): Promise<MailProvider> {
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

/**
 * Capability probe for callers (route handlers) so they can partition selected
 * attachments into real-file (this provider supports it + fits) vs link-card
 * BEFORE building the body/tracking. Resolves the same provider sendMail will.
 */
export async function willSupportAttachments(req: CanonicalSendRequest): Promise<{ supported: boolean; maxBytes: number }> {
    const provider = await resolveProvider(req);
    let maxBytes = provider.maxAttachmentBytes;
    // Nango covers gmail+outlook with one object; narrow the cap for Outlook.
    if (provider.name === 'gmail') {
        const concrete = await resolveNangoProvider(req.tenantId, req.accountEmail ?? undefined);
        if (concrete === 'microsoft-outlook') maxBytes = OUTLOOK_MAX_ATTACHMENT_BYTES;
    }
    return { supported: provider.supportsAttachments(req), maxBytes };
}

export async function sendMail(req: CanonicalSendRequest): Promise<SendResult> {
    const provider = await resolveProvider(req);
    // Load bytes for real-attachment candidates the caller passed (already
    // partitioned; link-card ones are in bodyHtml). Guard on capability in case
    // a caller passed attachments without probing.
    let dropped: string[] = [];
    if (req.attachments?.length && provider.supportsAttachments(req)) {
        const loaded = await loadAttachmentFiles(req.attachments);
        req.files = loaded.files;
        dropped = loaded.failed;
    }
    log.info(
        { channel: req.channel, origin: req.originProvider, provider: provider.name, to: req.to,
          files: req.files?.length ?? 0, dropped: dropped.length },
        'Routing outbound mail',
    );
    const result = await provider.send(req);
    return dropped.length ? { ...result, droppedAttachments: dropped } : result;
}
