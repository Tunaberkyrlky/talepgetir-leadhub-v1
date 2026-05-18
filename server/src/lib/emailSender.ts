/**
 * Email Sender — Nango proxy üzerinden Gmail Send API / Microsoft Graph
 *
 * Drip kampanya mailleri kullanıcının kendi mailbox'ından (Gmail veya Outlook)
 * gönderilir. Bağlantı email_connections tablosunda saklanır; OAuth token
 * refresh'ini Nango proxy'si otomatik yapar.
 *
 * Provider rate limits (her tenant için ayrı):
 *   - Gmail (free):       500/gün  → 450 konservatif
 *   - Gmail (Workspace):  2000/gün
 *   - Outlook:            10000/gün → 9500 konservatif
 *
 * Saniyede en fazla 3 istek (provider başına, tenant başına).
 */

import { supabaseAdmin } from './supabase.js';
import { createLogger } from './logger.js';
import { AppError } from '../middleware/errorHandler.js';

const log = createLogger('emailSender');

// ── Nango client (dynamic import — @nangohq/node is ESM-only) ──────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _nango: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getNango(): Promise<any> {
    if (_nango) return _nango;
    if (!process.env.NANGO_SECRET_KEY) {
        throw new AppError('NANGO_SECRET_KEY not configured', 500);
    }
    const { Nango } = await import('@nangohq/node');
    _nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY });
    return _nango;
}

export function isConfigured(): boolean {
    return !!process.env.NANGO_SECRET_KEY;
}

// ── Email connection lookup ────────────────────────────────────────────────

type Provider = 'google-mail' | 'microsoft-outlook';

interface EmailConnection {
    provider: Provider;
    email_address: string;
    connection_id: string;
}

async function getActiveConnection(tenantId: string): Promise<EmailConnection> {
    const { data } = await supabaseAdmin
        .from('email_connections')
        .select('provider, email_address, connection_id')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .single();

    if (!data) {
        throw new AppError(
            'No active email connection. Connect Gmail or Outlook in Settings before sending campaigns.',
            412,
        );
    }
    return data as EmailConnection;
}

// ── Per-tenant + per-provider rate limiter ─────────────────────────────────

interface TenantRateState {
    timestamps: number[];
    dailyCount: number;
    dailyResetAt: number;
}

const tenantRates = new Map<string, TenantRateState>();
const MAX_PER_SECOND = 3;

function getDailyLimit(provider: Provider): number {
    if (provider === 'google-mail') return 450;       // free Gmail: 500/day
    if (provider === 'microsoft-outlook') return 9500; // Outlook: 10000/day
    return 500;
}

async function waitForRateLimit(tenantId: string, provider: Provider): Promise<void> {
    const key = `${tenantId}:${provider}`;
    let state = tenantRates.get(key);
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const dailyLimit = getDailyLimit(provider);

    if (!state || state.dailyResetAt < todayStart) {
        state = { timestamps: [], dailyCount: 0, dailyResetAt: todayStart };
        tenantRates.set(key, state);
        // Evict stale entries on daily reset
        for (const [k, v] of tenantRates) {
            if (v.dailyResetAt < todayStart) tenantRates.delete(k);
        }
    }

    if (state.dailyCount >= dailyLimit) {
        throw new AppError(`Daily email limit reached (${dailyLimit}). Resets at midnight.`, 429);
    }

    state.timestamps = state.timestamps.filter((t) => now - t < 1000);
    if (state.timestamps.length >= MAX_PER_SECOND) {
        const oldest = state.timestamps[0];
        const waitMs = 1000 - (now - oldest) + 10;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        state.timestamps = state.timestamps.filter((t) => Date.now() - t < 1000);
    }

    state.timestamps.push(Date.now());
    state.dailyCount++;
}

// ── MIME helpers ────────────────────────────────────────────────────────────

function base64url(input: string): string {
    return Buffer.from(input, 'utf-8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function encodeSubject(subject: string): string {
    // RFC 2047 — encode as UTF-8 base64 for non-ASCII safety
    return `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}

function buildRfc2822(params: {
    from: string;
    to: string;
    subject: string;
    htmlBody: string;
    cc?: string[];
    replyTo?: string;
}): string {
    const lines: string[] = [];
    lines.push(`From: ${params.from}`);
    lines.push(`To: ${params.to}`);
    if (params.cc?.length) lines.push(`Cc: ${params.cc.join(', ')}`);
    if (params.replyTo) lines.push(`Reply-To: ${params.replyTo}`);
    lines.push(`Subject: ${encodeSubject(params.subject)}`);
    lines.push('MIME-Version: 1.0');
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(params.htmlBody);
    return lines.join('\r\n');
}

// ── Provider-specific send ─────────────────────────────────────────────────

interface SendParams {
    to: string;
    subject: string;
    htmlBody: string;
    cc?: string[];
    replyTo?: string;
    fromName?: string;
}

async function sendViaGmail(connection: EmailConnection, params: SendParams): Promise<string> {
    const fromHeader = params.fromName
        ? `${params.fromName} <${connection.email_address}>`
        : connection.email_address;

    const rawMessage = buildRfc2822({
        from: fromHeader,
        to: params.to,
        subject: params.subject,
        htmlBody: params.htmlBody,
        cc: params.cc,
        replyTo: params.replyTo,
    });

    const nango = await getNango();
    const response = await nango.proxy({
        method: 'POST',
        baseUrlOverride: 'https://gmail.googleapis.com',
        endpoint: '/gmail/v1/users/me/messages/send',
        providerConfigKey: 'google-mail',
        connectionId: connection.connection_id,
        data: { raw: base64url(rawMessage) },
    });

    const data = response.data as { id?: string } | undefined;
    return data?.id || `gmail_${Date.now()}`;
}

async function sendViaOutlook(connection: EmailConnection, params: SendParams): Promise<string> {
    const message: Record<string, unknown> = {
        subject: params.subject,
        body: { contentType: 'HTML', content: params.htmlBody },
        toRecipients: [{ emailAddress: { address: params.to } }],
    };
    if (params.cc?.length) {
        message.ccRecipients = params.cc.map((e) => ({ emailAddress: { address: e } }));
    }
    if (params.replyTo) {
        message.replyTo = [{ emailAddress: { address: params.replyTo } }];
    }

    const nango = await getNango();
    // Microsoft Graph /sendMail returns 202 with no body, so messageId comes from the response headers
    const response = await nango.proxy({
        method: 'POST',
        baseUrlOverride: 'https://graph.microsoft.com',
        endpoint: '/v1.0/me/sendMail',
        providerConfigKey: 'microsoft-outlook',
        connectionId: connection.connection_id,
        data: { message, saveToSentItems: true },
    });

    const headers = (response.headers || {}) as Record<string, string>;
    return headers['x-ms-request-id'] || headers['request-id'] || `outlook_${Date.now()}`;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface SendResult {
    success: boolean;
    messageId: string;
    provider: Provider;
}

export async function sendEmail(
    tenantId: string,
    to: string,
    subject: string,
    htmlBody: string,
    options?: {
        fromName?: string;
        cc?: string[];
        replyTo?: string;
    },
): Promise<SendResult> {
    const connection = await getActiveConnection(tenantId);
    await waitForRateLimit(tenantId, connection.provider);

    log.info(
        { tenantId, to, subject: subject.slice(0, 50), provider: connection.provider, cc: options?.cc },
        'Sending email via Nango',
    );

    try {
        const messageId =
            connection.provider === 'google-mail'
                ? await sendViaGmail(connection, { to, subject, htmlBody, ...options })
                : await sendViaOutlook(connection, { to, subject, htmlBody, ...options });

        log.info({ tenantId, to, messageId, provider: connection.provider }, 'Email sent');
        return { success: true, messageId, provider: connection.provider };
    } catch (err) {
        if (err instanceof AppError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, to, provider: connection.provider }, 'Email send failed');
        throw new AppError(`Email send failed: ${message}`, 502);
    }
}
