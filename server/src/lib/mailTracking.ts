/**
 * Mail Tracking — HMAC imzalı open pixel / click redirect yardımcıları.
 *
 * Token formatı: `{payload}:{hmac(payload)}`. Payload ya çıplak UUID'dir
 * (activity/enrollment — eski format; gönderilmiş drip mailleri ve
 * unsubscribe linkleri çalışmaya devam eder) ya da tekil mail takibi için
 * `r.{uuid}` (email_replies.id). Kind prefix'i HMAC'e dahildir; token bir
 * kind'dan diğerine taşınamaz.
 */

import crypto from 'crypto';
import { createLogger } from './logger.js';

const log = createLogger('mailTracking');

const TRACKING_SECRET = process.env.TRACKING_SECRET || 'dev-tracking-secret-local-only';
if (!process.env.TRACKING_SECRET) {
    log.warn('TRACKING_SECRET env var not set — using insecure default. Set it in production!');
}

export const API_BASE = process.env.API_BASE_URL || '';

/** True when injectTracking will actually embed a pixel (API_BASE_URL is set). */
export function isTrackingConfigured(): boolean {
    return !!API_BASE;
}

/**
 * Tenant'a özel takip alanı (task-7). tenants.settings.tracking_domain içinde
 * saklanır; yalnız `verified` olduğunda kullanılır. Doğrulanmamış/eksik alan →
 * global API_BASE'e düşer (itibar sızıntısını önlemek için asla doğrulanmamış
 * alan üzerinden gönderilmez).
 */
export interface TrackingDomainConfig {
    domain?: string | null;
    verified?: boolean;
    checked_at?: string | null;
}

/**
 * Bu tenant için takip linklerinin (pixel / click / unsubscribe) taban URL'ini
 * çözer: doğrulanmış özel alan varsa `https://<alan>`, aksi halde global API_BASE.
 */
export function resolveTrackingBase(td?: TrackingDomainConfig | null): string {
    if (td?.domain && td.verified) return `https://${td.domain}`;
    return API_BASE;
}

export type TrackingKind = 'activity' | 'reply';

const REPLY_PREFIX = 'r.';

export function createTrackingToken(id: string, kind: TrackingKind = 'activity'): string {
    const payload = kind === 'reply' ? `${REPLY_PREFIX}${id}` : id;
    const hmac = crypto.createHmac('sha256', TRACKING_SECRET).update(payload).digest('hex');
    return `${payload}:${hmac}`;
}

export function verifyTrackingToken(token: string): { id: string; kind: TrackingKind } | null {
    const [payload, hmac] = token.split(':');
    if (!payload || !hmac) return null;
    const expected = crypto.createHmac('sha256', TRACKING_SECRET).update(payload).digest('hex');
    try {
        if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;
    } catch {
        return null; // length mismatch
    }
    return payload.startsWith(REPLY_PREFIX)
        ? { id: payload.slice(REPLY_PREFIX.length), kind: 'reply' }
        : { id: payload, kind: 'activity' };
}

/** Açılma (pixel) ve tıklama (link redirect) takibi ayrı ayrı açılıp kapatılabilir.
 * Varsayılan ikisi de açık (geriye dönük uyum: opts verilmezse eski davranış). */
export function injectTracking(
    html: string, id: string, kind: TrackingKind = 'activity',
    // baseUrl (task-7): tenant'ın doğrulanmış özel takip alanı; verilmezse global API_BASE.
    opts?: { open?: boolean; click?: boolean; baseUrl?: string },
): string {
    const base = opts?.baseUrl || API_BASE;
    if (!base) return html;
    const open = opts?.open !== false;
    const click = opts?.click !== false;
    if (!open && !click) return html;

    const token = createTrackingToken(id, kind);
    let out = html;

    if (click) {
        out = out.replace(
            /href="(https?:\/\/[^"]+)"/gi,
            // href değeri HTML-escaped gelir (& → &amp;); redirect hedefi bozulmasın
            // diye encodeURIComponent öncesi geri çevrilir.
            (_, url) => `href="${base}/api/t/c/${token}?url=${encodeURIComponent(url.replace(/&amp;/g, '&'))}"`,
        );
    }

    if (open) {
        const pixel = `<img src="${base}/api/t/o/${token}" width="1" height="1" style="display:none" alt="" />`;
        out = out.includes('</body>') ? out.replace('</body>', `${pixel}</body>`) : out + pixel;
    }

    return out;
}
