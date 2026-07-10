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

import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { getConnectionByEmail, getDefaultConnection } from './emailConnections.js';
import type { ConnectionProvider, EmailConnection } from './emailConnections.js';
import type { ResolvedAttachment, ListUnsubscribe } from './mail/types.js';
import { listUnsubscribeHeaders } from './mail/types.js';
import { htmlToPlainTextBody } from './mail/plainText.js';

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

/**
 * Which concrete Nango provider a send will use (gmail vs outlook) — so the
 * router can pick the right attachment size cap (Outlook Graph inline ~3MB).
 * Defaults to google-mail if the connection can't be resolved.
 */
export async function resolveNangoProvider(tenantId: string, accountEmail?: string): Promise<ConnectionProvider> {
    try {
        const conn = accountEmail
            ? await getConnectionByEmail(tenantId, accountEmail)
            : await getDefaultConnection(tenantId);
        return conn?.provider ?? 'google-mail';
    } catch {
        return 'google-mail';
    }
}

// ── Per-tenant + per-provider rate limiter (shared with smtpAdapter) ───────

interface TenantRateState {
    timestamps: number[];
    dailyCount: number;
    dailyResetAt: number;
}

const tenantRates = new Map<string, TenantRateState>();
const MAX_PER_SECOND = 3;

function getDailyLimit(provider: ConnectionProvider): number {
    if (provider === 'google-mail') return 450;        // free Gmail: 500/day
    if (provider === 'microsoft-outlook') return 9500; // Outlook: 10000/day
    if (provider === 'smtp') return 300;               // conservative for shared SMTP hosts
    return 500;
}

export async function waitForRateLimit(tenantId: string, provider: ConnectionProvider): Promise<void> {
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

/** RFC 2231 — quote an ASCII filename, or UTF-8 encode a non-ASCII one. */
function dispositionFilename(filename: string): string {
    // eslint-disable-next-line no-control-regex
    return /^[\x20-\x7E]*$/.test(filename)
        ? `filename="${filename.replace(/"/g, '')}"`
        : `filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Kendi RFC 2822 Message-ID'mizi üretiriz: <uuid@gönderen-alanadı>. Gönderen alan adını
// From header'ından ("Ad <mail@x.com>" ya da düz "mail@x.com") çıkarır, güvenli karakterlere
// süzeriz (header injection'a karşı). Gmail API raw send ve Graph MIME send verilen
// Message-ID'yi korur; bu id thread durumunda saklanıp takip maillerinin In-Reply-To/
// References'ında kullanılır.
function generateRfcMessageId(fromHeader: string): string {
    const m = fromHeader.match(/<([^>]+)>/);
    const email = (m ? m[1] : fromHeader).trim();
    const rawDomain = (email.split('@')[1] || 'localhost').trim();
    const domain = rawDomain.replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
    return `<${randomUUID()}@${domain}>`;
}

// Dönüş: hem ham MIME hem de yazdığımız Message-ID (çağıran thread durumunda saklar).
function buildRfc2822(params: {
    from: string;
    to: string;
    subject: string;
    htmlBody: string;
    cc?: string[];
    replyTo?: string;
    attachments?: ResolvedAttachment[];
    // Ekstra RFC 2822 header'ları (ör. List-Unsubscribe). Header adı/değeri tek satır
    // olmalı; çağıran zaten kontrollü değerler geçirir (CRLF injection riski yok).
    extraHeaders?: Record<string, string>;
    // Thread'leme (task-3): takip maillerinde ebeveyn id + zincir. İlk mailde yok.
    inReplyTo?: string | null;
    references?: string | null;
}): { raw: string; messageId: string } {
    const messageId = generateRfcMessageId(params.from);
    const headers: string[] = [];
    headers.push(`From: ${params.from}`);
    headers.push(`To: ${params.to}`);
    if (params.cc?.length) headers.push(`Cc: ${params.cc.join(', ')}`);
    if (params.replyTo) headers.push(`Reply-To: ${params.replyTo}`);
    headers.push(`Subject: ${encodeSubject(params.subject)}`);
    // Kendi Message-ID'miz + (takip mailiyse) thread bağları.
    headers.push(`Message-ID: ${messageId}`);
    if (params.inReplyTo) headers.push(`In-Reply-To: ${params.inReplyTo}`);
    if (params.references) headers.push(`References: ${params.references}`);
    for (const [name, value] of Object.entries(params.extraHeaders || {})) {
        headers.push(`${name}: ${value}`);
    }
    headers.push('MIME-Version: 1.0');

    // Deliverability: her mail multipart/alternative taşır — önce text/plain, sonra
    // text/html. Düz metin HTML'den türetilir (tracking pixel <img> metin üretmez →
    // yalnız HTML part'ta kalır; footer'ın abonelikten-çıkma linki düz metne URL olarak düşer).
    const altBoundary = `=_alt_${randomUUID()}`;
    const altPart: string[] = [
        `--${altBoundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        htmlToPlainTextBody(params.htmlBody),
        `--${altBoundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        params.htmlBody,
        `--${altBoundary}--`,
    ];

    // Ek yoksa → mesajın kendisi multipart/alternative.
    if (!params.attachments?.length) {
        return {
            messageId,
            raw: [
                ...headers,
                `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
                '',
                ...altPart,
            ].join('\r\n'),
        };
    }

    // Ek varsa → multipart/mixed: önce multipart/alternative (metin+html), sonra her ek base64 part.
    const boundary = `=_part_${randomUUID()}`;
    const parts: string[] = [
        ...headers,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
        '',
        ...altPart,
    ];
    for (const a of params.attachments) {
        const b64 = a.content.toString('base64').replace(/(.{76})/g, '$1\r\n'); // RFC 2045 line length
        parts.push(
            `--${boundary}`,
            `Content-Type: ${a.mimeType}`,
            'Content-Transfer-Encoding: base64',
            `Content-Disposition: attachment; ${dispositionFilename(a.filename)}`,
            '',
            b64,
        );
    }
    parts.push(`--${boundary}--`);
    return { messageId, raw: parts.join('\r\n') };
}

// ── Provider-specific send ─────────────────────────────────────────────────

interface SendParams {
    to: string;
    subject: string;
    htmlBody: string;
    cc?: string[];
    replyTo?: string;
    fromName?: string;
    attachments?: ResolvedAttachment[];
    listUnsubscribe?: ListUnsubscribe;  // kampanya sendleri: RFC 8058 header çifti
    // Thread'leme (task-3): takip mailleri. İlk mailde hepsi boştur.
    inReplyTo?: string | null;      // ebeveyn Message-ID → In-Reply-To
    references?: string | null;     // önceki id zinciri → References
    gmailThreadId?: string | null;  // Gmail native threadId (send gövdesine geçer)
}

// Provider send çıktısı: sağlayıcı mesaj id'si + (thread durumu için) yazdığımız RFC
// Message-ID ve varsa native threadId. Message-ID üretemeyen JSON yolu rfcMessageId'yi boş bırakır.
interface ProviderSendOutput {
    providerMessageId: string;         // Gmail message id / Graph request-id
    rfcMessageId?: string | null;      // yazdığımız RFC Message-ID (MIME/Gmail yolları)
    providerThreadId?: string | null;  // Gmail threadId (varsa)
}

async function sendViaGmail(connection: EmailConnection, params: SendParams): Promise<ProviderSendOutput> {
    const fromHeader = params.fromName
        ? `${params.fromName} <${connection.email_address}>`
        : connection.email_address;

    const { raw: rawMessage, messageId } = buildRfc2822({
        from: fromHeader,
        to: params.to,
        subject: params.subject,
        htmlBody: params.htmlBody,
        cc: params.cc,
        replyTo: params.replyTo,
        attachments: params.attachments,
        extraHeaders: params.listUnsubscribe ? listUnsubscribeHeaders(params.listUnsubscribe) : undefined,
        inReplyTo: params.inReplyTo,
        references: params.references,
    });

    const nango = await getNango();
    const response = await nango.proxy({
        method: 'POST',
        baseUrlOverride: 'https://gmail.googleapis.com',
        endpoint: '/gmail/v1/users/me/messages/send',
        providerConfigKey: 'google-mail',
        connectionId: connection.connection_id ?? '',
        // threadId verilince Gmail maili aynı konuşmaya native yerleştirir (In-Reply-To/
        // References başlıkları bu thread'deki bir mesajla eşleştiği için kabul edilir).
        data: { raw: base64url(rawMessage), ...(params.gmailThreadId ? { threadId: params.gmailThreadId } : {}) },
    });

    const data = response.data as { id?: string; threadId?: string } | undefined;
    return {
        providerMessageId: data?.id || `gmail_${Date.now()}`,
        rfcMessageId: messageId,
        providerThreadId: data?.threadId ?? null,
    };
}

// Microsoft Graph /sendMail caps the WHOLE request (HTML body + base64 attachments)
// at ~4 MB. base64 inflates raw bytes ~33%, so total RAW attachments above ~3 MB
// blow the limit. Per-file 3 MB is already enforced in the partition; this guards the
// multi-file TOTAL and fails fast with a clear message instead of an opaque Graph 4xx.
const OUTLOOK_MAX_TOTAL_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/** Toplam ek boyutu Graph tavanını aşarsa net bir 413 fırlat (JSON + MIME ortak). */
function assertOutlookAttachmentSize(attachments?: ResolvedAttachment[]): void {
    if (!attachments?.length) return;
    const totalBytes = attachments.reduce((sum, a) => sum + a.content.length, 0);
    if (totalBytes > OUTLOOK_MAX_TOTAL_ATTACHMENT_BYTES) {
        const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
        throw new AppError(
            `Outlook allows at most ${mb(OUTLOOK_MAX_TOTAL_ATTACHMENT_BYTES)} of attachments per email; the selected files total ${mb(totalBytes)}. Please send fewer or smaller files, or share them as a download link.`,
            413,
        );
    }
}

/** Graph /sendMail 202 döner, gövde yok → messageId response header'ından gelir. */
function outlookMessageId(response: { headers?: unknown }): string {
    const headers = (response.headers || {}) as Record<string, string>;
    return headers['x-ms-request-id'] || headers['request-id'] || `outlook_${Date.now()}`;
}

/**
 * JSON gövdeli klasik gönderim. Custom (X- dışı) header EKLEYEMEZ → List-Unsubscribe taşımaz.
 * Ayrıca Graph `body` tek bir contentType (HTML) alır → text/plain ALTERNATİF taşınamaz;
 * düz-metin alternatifi yalnız MIME modunda (sendViaOutlookMime → buildRfc2822) gider.
 */
async function sendViaOutlookJson(connection: EmailConnection, params: SendParams): Promise<ProviderSendOutput> {
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
    if (params.attachments?.length) {
        assertOutlookAttachmentSize(params.attachments);
        message.attachments = params.attachments.map((a) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: a.filename,
            contentType: a.mimeType,
            contentBytes: a.content.toString('base64'),
        }));
    }

    const nango = await getNango();
    const response = await nango.proxy({
        method: 'POST',
        baseUrlOverride: 'https://graph.microsoft.com',
        endpoint: '/v1.0/me/sendMail',
        providerConfigKey: 'microsoft-outlook',
        connectionId: connection.connection_id ?? '',
        data: { message, saveToSentItems: true },
    });

    // JSON gövdesi custom Message-ID yazamaz (Graph kendi id'sini üretir, yanıtta dönmez)
    // → rfcMessageId boş; bu send thread'e bağlanamaz. Kampanya sendleri MIME'a gider,
    // JSON yalnız kampanya-dışı / MIME-fallback yoludur.
    return { providerMessageId: outlookMessageId(response), rfcMessageId: null, providerThreadId: null };
}

// Graph /sendMail MIME modu: Content-Type text/plain, gövde = base64 kodlu RFC 2822 MIME.
// Sadece bu modda List-Unsubscribe gibi standart header'lar taşınabilir. Microsoft dokümanı:
// MIME gönderiminde mesaj Sent Items'a otomatik kaydedilir (saveToSentItems parametresi yok).
async function sendViaOutlookMime(connection: EmailConnection, params: SendParams): Promise<ProviderSendOutput> {
    assertOutlookAttachmentSize(params.attachments);
    const fromHeader = params.fromName
        ? `${params.fromName} <${connection.email_address}>`
        : connection.email_address;

    const { raw: rawMessage, messageId } = buildRfc2822({
        from: fromHeader,
        to: params.to,
        subject: params.subject,
        htmlBody: params.htmlBody,
        cc: params.cc,
        replyTo: params.replyTo,
        attachments: params.attachments,
        extraHeaders: params.listUnsubscribe ? listUnsubscribeHeaders(params.listUnsubscribe) : undefined,
        inReplyTo: params.inReplyTo,
        references: params.references,
    });

    const nango = await getNango();
    const response = await nango.proxy({
        method: 'POST',
        baseUrlOverride: 'https://graph.microsoft.com',
        endpoint: '/v1.0/me/sendMail',
        providerConfigKey: 'microsoft-outlook',
        connectionId: connection.connection_id ?? '',
        headers: { 'Content-Type': 'text/plain' },
        data: Buffer.from(rawMessage, 'utf-8').toString('base64'),
    });

    // Outlook thread'i In-Reply-To/References header'larıyla olur; native conversationId
    // gerekmez (task: MIME yaklaşımını seç). providerThreadId boş bırakılır.
    return { providerMessageId: outlookMessageId(response), rfcMessageId: messageId, providerThreadId: null };
}

async function sendViaOutlook(connection: EmailConnection, params: SendParams): Promise<ProviderSendOutput> {
    // Kampanya sendleri (List-Unsubscribe ya da thread bağı taşıyan) MIME moduna geçer;
    // standart header'lar (List-Unsubscribe / In-Reply-To / References) JSON modda taşınamaz.
    // MIME beklenmedik şekilde patlarsa JSON'a düşülür (header'lar düşer ama mail yine gider).
    // Kasıtlı hatalar (ör. 413 boyut) fallback'e girmez.
    if (params.listUnsubscribe || params.inReplyTo || params.references) {
        try {
            return await sendViaOutlookMime(connection, params);
        } catch (err) {
            if (err instanceof AppError) throw err;
            log.warn(
                { err, to: params.to },
                'Outlook MIME send failed; falling back to JSON (List-Unsubscribe / threading headers dropped)',
            );
        }
    }
    return sendViaOutlookJson(connection, params);
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface SendResult {
    success: boolean;
    messageId: string;                  // sağlayıcı mesaj id'si (Gmail id / Graph request-id)
    provider: 'google-mail' | 'microsoft-outlook';
    rfcMessageId?: string | null;       // yazdığımız RFC Message-ID (thread durumu için)
    providerThreadId?: string | null;   // Gmail native threadId (varsa)
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
        accountEmail?: string;   // which connected mailbox to send from; default if omitted
        attachments?: ResolvedAttachment[];  // real file attachments (Gmail multipart / Graph)
        listUnsubscribe?: ListUnsubscribe;   // RFC 8058 header çifti (yalnız kampanya)
        // Thread'leme (task-3): takip mailleri. İlk mailde boştur.
        inReplyTo?: string | null;
        references?: string | null;
        gmailThreadId?: string | null;
    },
): Promise<SendResult> {
    const connection: EmailConnection = options?.accountEmail
        ? (await getConnectionByEmail(tenantId, options.accountEmail))
            ?? (() => { throw new AppError(`Email account ${options.accountEmail} not found or inactive`, 412); })()
        : await getDefaultConnection(tenantId);

    // This sender handles Nango (Gmail/Outlook) only; SMTP goes through smtpAdapter.
    if (connection.provider === 'smtp') {
        throw new AppError('SMTP connections must be sent via the SMTP adapter, not the Nango sender', 500);
    }
    const provider = connection.provider;

    await waitForRateLimit(tenantId, provider);

    log.info(
        { tenantId, to, subject: subject.slice(0, 50), provider, cc: options?.cc },
        'Sending email via Nango',
    );

    try {
        const out =
            provider === 'google-mail'
                ? await sendViaGmail(connection, { to, subject, htmlBody, ...options })
                : await sendViaOutlook(connection, { to, subject, htmlBody, ...options });

        log.info({ tenantId, to, messageId: out.providerMessageId, provider }, 'Email sent');
        return {
            success: true,
            messageId: out.providerMessageId,
            provider,
            rfcMessageId: out.rfcMessageId ?? null,
            providerThreadId: out.providerThreadId ?? null,
        };
    } catch (err) {
        if (err instanceof AppError) throw err;
        // Surface the provider's real error message (Gmail/Graph put it in response.data.error.message)
        // instead of the generic axios "Request failed with status code 403".
        const providerMsg =
            (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
        const message = providerMsg || (err instanceof Error ? err.message : String(err));
        log.error({ err, to, provider, providerMsg }, 'Email send failed');
        throw new AppError(`Email send failed: ${message}`, 502);
    }
}
