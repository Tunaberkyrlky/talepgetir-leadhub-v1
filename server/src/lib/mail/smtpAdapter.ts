/**
 * SMTP adapter — sends via the tenant's own SMTP server (nodemailer).
 *
 * Credentials live in email_connections (provider='smtp'); the password is
 * AES-256-GCM encrypted at rest and decrypted only here, in memory.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { createLogger } from '../logger.js';
import { AppError } from '../../middleware/errorHandler.js';
import { getConnectionByEmail, type EmailConnection } from '../emailConnections.js';
import { decrypt } from '../encryption.js';
import { waitForRateLimit } from '../emailSender.js';
import { resolvePublicHost } from '../ssrfGuard.js';
import type { CanonicalSendRequest, SendResult, MailProvider } from './types.js';
import { listUnsubscribeHeaders } from './types.js';
import { htmlToPlainTextBody } from './plainText.js';

const log = createLogger('mail:smtp');

// Reuse transporters per connection (avoid a fresh TCP handshake every send).
const transporterCache = new Map<string, Transporter>();

async function buildTransporter(conn: EmailConnection): Promise<Transporter> {
    if (!conn.smtp_host || !conn.smtp_port || !conn.username || !conn.encrypted_password) {
        throw new AppError('SMTP connection is missing host/port/username/password', 500);
    }
    const cacheKey = `${conn.id}`;
    const cached = transporterCache.get(cacheKey);
    if (cached) return cached;

    // SSRF guard: resolve to a validated public IP and dial that literal (not the
    // hostname), so a tenant can't DNS-rebind smtp_host to an internal address
    // between save and send. servername keeps TLS cert validation on the hostname.
    const pinned = await resolvePublicHost(conn.smtp_host);
    const transporter = nodemailer.createTransport({
        host: pinned.address,
        port: conn.smtp_port,
        secure: conn.smtp_secure ?? conn.smtp_port === 465,
        auth: { user: conn.username, pass: decrypt(conn.encrypted_password) },
        tls: {
            servername: pinned.servername,
            // Shared hosting often serves a cert for the provider's domain (e.g. *.ihsdnsx50.com),
            // not the customer's mail.* host. allow_invalid_cert keeps TLS encryption but skips
            // hostname/CA validation — same as mail clients' "trust this certificate".
            ...(conn.allow_invalid_cert && { rejectUnauthorized: false }),
        },
    });
    transporterCache.set(cacheKey, transporter);
    return transporter;
}

/** Verify SMTP credentials by opening a connection. Used before saving. */
export async function verifySmtp(params: {
    host: string; port: number; secure: boolean; username: string; password: string;
    allowInvalidCert?: boolean;
}): Promise<void> {
    const pinned = await resolvePublicHost(params.host);
    const transporter = nodemailer.createTransport({
        host: pinned.address,
        port: params.port,
        secure: params.secure,
        auth: { user: params.username, pass: params.password },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        tls: {
            servername: pinned.servername,
            ...(params.allowInvalidCert && { rejectUnauthorized: false }),
        },
    });
    try {
        await transporter.verify();
    } finally {
        transporter.close();
    }
}

export const smtpProvider: MailProvider = {
    name: 'smtp',
    supportsAttachments: () => true,
    maxAttachmentBytes: 10 * 1024 * 1024, // matches the upload limit
    async send(req: CanonicalSendRequest): Promise<SendResult> {
        if (!req.accountEmail) {
            throw new AppError('SMTP send requires an accountEmail (which mailbox to send from)', 400);
        }
        const conn = await getConnectionByEmail(req.tenantId, req.accountEmail);
        if (!conn || conn.provider !== 'smtp') {
            throw new AppError(`SMTP account ${req.accountEmail} not found or inactive`, 412);
        }

        await waitForRateLimit(req.tenantId, 'smtp');

        const transporter = await buildTransporter(conn);
        const fromHeader = req.fromName ? `${req.fromName} <${conn.email_address}>` : conn.email_address;

        log.info(
            { tenantId: req.tenantId, to: req.to, account: conn.email_address, subject: req.subject.slice(0, 50) },
            'Sending email via SMTP',
        );

        try {
            const info = await transporter.sendMail({
                from: fromHeader,
                to: req.to,
                ...(req.cc?.length && { cc: req.cc }),
                ...(req.bcc?.length && { bcc: req.bcc }),
                ...(req.replyTo && { replyTo: req.replyTo }),
                ...(req.listUnsubscribe && { headers: listUnsubscribeHeaders(req.listUnsubscribe) }),
                // Thread'leme (task-3): takip maili aynı konuşmaya bağlanır. nodemailer bu
                // alanlardan In-Reply-To/References header'larını kurar. Message-ID'yi de
                // kendisi üretir (gönderen alan adı) → info.messageId olarak döner.
                ...(req.threading?.inReplyTo && { inReplyTo: req.threading.inReplyTo }),
                ...(req.threading?.references && { references: req.threading.references }),
                subject: req.subject,
                // Deliverability: düz-metin alternatifini HTML'den türet; nodemailer
                // text+html verildiğinde multipart/alternative'i kendisi kurar.
                text: htmlToPlainTextBody(req.bodyHtml),
                html: req.bodyHtml,
                ...(req.files?.length && {
                    attachments: req.files.map((f) => ({
                        filename: f.filename,
                        content: f.content,
                        contentType: f.mimeType,
                    })),
                }),
            });
            log.info({ tenantId: req.tenantId, to: req.to, messageId: info.messageId }, 'Email sent via SMTP');
            return {
                provider: 'smtp',
                providerMessageId: info.messageId || `smtp_${conn.id}`,
                success: true,
                // nodemailer'ın yazdığı RFC Message-ID (köşeli parantezli) → thread durumu için sakla.
                rfcMessageId: info.messageId ?? null,
                // SMTP'de native thread id kavramı yok; thread yalnız header'larla olur.
                providerThreadId: null,
            };
        } catch (err) {
            // Drop a possibly-stale transporter so the next send rebuilds it.
            transporterCache.delete(`${conn.id}`);
            const message = err instanceof Error ? err.message : String(err);
            log.error({ err, to: req.to, account: conn.email_address }, 'SMTP send failed');
            throw new AppError(`Email send failed: ${message}`, 502);
        }
    },
};
