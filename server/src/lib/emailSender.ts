/**
 * Email Sender — Resend API
 *
 * Simple API key auth, built-in tracking (open/click/bounce via webhooks).
 * Pattern: plusvibeClient.ts (rate limiter, error handling, structured logging)
 */

import { Resend } from 'resend';
import { createLogger } from './logger.js';
import { AppError } from '../middleware/errorHandler.js';

const log = createLogger('emailSender');

// ── Resend client ──────────────────────────────────────────────────────────

let _resend: Resend | null = null;

function getResend(): Resend {
    if (_resend) return _resend;
    if (!process.env.RESEND_API_KEY) {
        throw new AppError('RESEND_API_KEY not configured', 500);
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
    return _resend;
}

export function isConfigured(): boolean {
    return !!process.env.RESEND_API_KEY;
}

// ── Tenant-scoped rate limiter (plusvibeClient.ts:25-40 pattern) ────────────

interface TenantRateState {
    timestamps: number[];
    dailyCount: number;
    dailyResetAt: number;
}

const tenantRates = new Map<string, TenantRateState>();
const MAX_PER_SECOND = 3;       // Resend allows 10/sec, we stay conservative
const DAILY_LIMIT = 2900;       // Resend free tier: 3000/month, ~100/day safe

async function waitForRateLimit(tenantId: string): Promise<void> {
    let state = tenantRates.get(tenantId);
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);

    if (!state || state.dailyResetAt < todayStart) {
        state = { timestamps: [], dailyCount: 0, dailyResetAt: todayStart };
        tenantRates.set(tenantId, state);
        // Evict stale entries from other tenants on daily reset
        for (const [key, val] of tenantRates) {
            if (val.dailyResetAt < todayStart) tenantRates.delete(key);
        }
    }

    if (state.dailyCount >= DAILY_LIMIT) {
        throw new AppError(`Daily email limit reached (${DAILY_LIMIT}). Resets at midnight.`, 429);
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

// ── Public API ─────────────────────────────────────────────────────────────

export interface SendResult {
    success: boolean;
    messageId: string;
    provider: 'resend';
}

export async function sendEmail(
    tenantId: string,
    to: string,
    subject: string,
    htmlBody: string,
    options?: {
        fromName?: string;
        cc?: string[];       // CC addresses
        replyTo?: string;
    },
): Promise<SendResult> {
    await waitForRateLimit(tenantId);

    const resend = getResend();
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@mail.leadhub.com';
    const from = options?.fromName ? `${options.fromName} <${fromEmail}>` : fromEmail;

    log.info({ tenantId, to, subject: subject.slice(0, 50), cc: options?.cc }, 'Sending email via Resend');

    const { data, error } = await resend.emails.send({
        from,
        to: [to],
        subject,
        html: htmlBody,
        ...(options?.cc?.length && { cc: options.cc }),
        ...(options?.replyTo && { reply_to: options.replyTo }),
    });

    if (error) {
        log.error({ err: error, to, subject: subject.slice(0, 50) }, 'Resend API error');
        throw new AppError(`Email send failed: ${error.message}`, 502);
    }

    log.info({ tenantId, to, messageId: data?.id }, 'Email sent via Resend');

    return {
        success: true,
        messageId: data?.id || `resend_${Date.now()}`,
        provider: 'resend',
    };
}
