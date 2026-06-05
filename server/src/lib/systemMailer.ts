/**
 * System Mailer — Resend üzerinden transactional mail gönderimi.
 *
 * Drip kampanyalardan ayrı: bunlar info@tibexa.com gibi marka adresinden
 * giden sistem mailleridir (günlük özet, davet, password reset vb.).
 * Drip için bkz. [[emailSender.ts]] (Nango → kullanıcının kendi mailbox'ı).
 */

import { Resend } from 'resend';
import { createLogger } from './logger.js';
import { AppError } from '../middleware/errorHandler.js';

const log = createLogger('systemMailer');

let _client: Resend | null = null;

function getClient(): Resend {
    if (_client) return _client;
    if (!process.env.RESEND_API_KEY) {
        throw new AppError('RESEND_API_KEY not configured', 500);
    }
    _client = new Resend(process.env.RESEND_API_KEY);
    return _client;
}

export function isConfigured(): boolean {
    return !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

function getFromHeader(): string {
    const email = process.env.RESEND_FROM_EMAIL;
    if (!email) throw new AppError('RESEND_FROM_EMAIL not configured', 500);
    const name = process.env.RESEND_FROM_NAME;
    return name ? `${name} <${email}>` : email;
}

export interface SystemMailOptions {
    to: string | string[];
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
    cc?: string | string[];
    bcc?: string | string[];
    tags?: { name: string; value: string }[];
}

export interface SystemMailResult {
    success: boolean;
    messageId: string;
}

export async function sendSystemEmail(opts: SystemMailOptions): Promise<SystemMailResult> {
    const client = getClient();
    const from = getFromHeader();

    const toList = Array.isArray(opts.to) ? opts.to : [opts.to];
    log.info(
        { to: toList, subject: opts.subject.slice(0, 80), tags: opts.tags },
        'Sending system email via Resend',
    );

    try {
        const { data, error } = await client.emails.send({
            from,
            to: toList,
            subject: opts.subject,
            html: opts.html,
            text: opts.text,
            replyTo: opts.replyTo,
            cc: opts.cc,
            bcc: opts.bcc,
            tags: opts.tags,
        });

        if (error) {
            log.error({ err: error, to: toList }, 'Resend returned error');
            throw new AppError(`Resend error: ${error.message}`, 502);
        }

        const messageId = data?.id || `resend_${Date.now()}`;
        log.info({ to: toList, messageId }, 'System email sent');
        return { success: true, messageId };
    } catch (err) {
        if (err instanceof AppError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, to: toList }, 'System email send failed');
        throw new AppError(`System email send failed: ${message}`, 502);
    }
}
