/**
 * In-memory record of the most recent API error.
 *
 * Populated by the axios response interceptor on any non-401 failure, then read
 * by the global FeedbackModal so a bug report carries full context (request id,
 * endpoint, status, server message, timestamp, page) without the user having
 * to type any of it.
 */

export interface CapturedError {
    requestId: string | null;
    method: string;
    url: string;
    status: number | null;
    serverMessage: string | null;
    message: string;
    timestamp: string; // ISO
    page: string;      // window.location.pathname + search
}

let current: CapturedError | null = null;

export function recordLastError(err: CapturedError): void {
    current = err;
}

export function getLastError(): CapturedError | null {
    return current;
}

export function clearLastError(): void {
    current = null;
}

/**
 * Build a localized "auto-prefill" payload for FeedbackModal. Returns null when
 * no error has been captured yet (caller should open the modal blank).
 */
export function buildFeedbackPrefill(): { type: 'bug_report'; title: string; description: string } | null {
    if (!current) return null;
    const time = new Date(current.timestamp).toLocaleString('tr-TR');
    const title = current.serverMessage
        ? `[${current.status ?? '?'}] ${current.serverMessage}`.slice(0, 200)
        : `[${current.status ?? '?'}] ${current.method} ${current.url}`.slice(0, 200);
    const description = [
        `Sayfa: ${current.page}`,
        `Zaman: ${time}`,
        `İstek: ${current.method} ${current.url}`,
        `Durum: ${current.status ?? '—'}`,
        current.serverMessage ? `Sunucu mesajı: ${current.serverMessage}` : null,
        current.requestId ? `Request ID: ${current.requestId}` : null,
        '',
        '— Yukarıdaki bilgiler otomatik dolduruldu. Lütfen ne yapmaya çalıştığını birkaç cümleyle anlat:',
        '',
    ].filter(Boolean).join('\n');
    return { type: 'bug_report', title, description };
}

/** Custom event names used to bridge non-React modules and the global FeedbackModal. */
export const FEEDBACK_OPEN_EVENT = 'app:openFeedback';

/** Imperative trigger — opens the global FeedbackModal pre-filled with the last error. */
export function openFeedbackForLastError(): void {
    window.dispatchEvent(new CustomEvent(FEEDBACK_OPEN_EVENT));
}
