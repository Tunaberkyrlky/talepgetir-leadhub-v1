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
import type { CanonicalSendRequest, SendResult, MailProvider } from './types.js';

const log = createLogger('mail:smtp');

// Reuse transporters per connection (avoid a fresh TCP handshake every send).
const transporterCache = new Map<string, Transporter>();

function buildTransporter(conn: EmailConnection): Transporter {
    if (!conn.smtp_host || !conn.smtp_port || !conn.username || !conn.encrypted_password) {
        throw new AppError('SMTP connection is missing host/port/username/password', 500);
    }
    const cacheKey = `${conn.id}`;
    const cached = transporterCache.get(cacheKey);
    if (cached) return cached;

    const transporter = nodemailer.createTransport({
        host: conn.smtp_host,
        port: conn.smtp_port,
        secure: conn.smtp_secure ?? conn.smtp_port === 465,
        auth: { user: conn.username, pass: decrypt(conn.encrypted_password) },
        // Shared hosting often serves a cert for the provider's domain (e.g. *.ihsdnsx50.com),
        // not the customer's mail.* host. allow_invalid_cert keeps TLS encryption but skips
        // hostname/CA validation — same as mail clients' "trust this certificate".
        ...(conn.allow_invalid_cert && { tls: { rejectUnauthorized: false } }),
    });
    transporterCache.set(cacheKey, transporter);
    return transporter;
}

/** Verify SMTP credentials by opening a connection. Used before saving. */
export async function verifySmtp(params: {
    host: string; port: number; secure: boolean; username: string; password: string;
    allowInvalidCert?: boolean;
}): Promise<void> {
    const transporter = nodemailer.createTransport({
        host: params.host,
        port: params.port,
        secure: params.secure,
        auth: { user: params.username, pass: params.password },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        ...(params.allowInvalidCert && { tls: { rejectUnauthorized: false } }),
    });
    try {
        await transporter.verify();
    } finally {
        transporter.close();
    }
}

export const smtpProvider: MailProvider = {
    name: 'smtp',
    async send(req: CanonicalSendRequest): Promise<SendResult> {
        if (!req.accountEmail) {
            throw new AppError('SMTP send requires an accountEmail (which mailbox to send from)', 400);
        }
        const conn = await getConnectionByEmail(req.tenantId, req.accountEmail);
        if (!conn || conn.provider !== 'smtp') {
            throw new AppError(`SMTP account ${req.accountEmail} not found or inactive`, 412);
        }

        await waitForRateLimit(req.tenantId, 'smtp');

        const transporter = buildTransporter(conn);
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
                subject: req.subject,
                html: req.bodyHtml,
            });
            log.info({ tenantId: req.tenantId, to: req.to, messageId: info.messageId }, 'Email sent via SMTP');
            return {
                provider: 'smtp',
                providerMessageId: info.messageId || `smtp_${conn.id}`,
                success: true,
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
