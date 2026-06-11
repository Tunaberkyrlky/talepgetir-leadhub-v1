/**
 * IMAP Polling Scheduler — 5 minute interval tick.
 * Pattern: campaignScheduler.ts (overlap guard + unref).
 */

import { processImapPolling } from './imapInbound.js';
import { createLogger } from './logger.js';

const log = createLogger('imapPollingScheduler');
// Default 5 min; override with IMAP_POLL_INTERVAL_MS (e.g. 60000 for testing).
const TICK_MS = Number(process.env.IMAP_POLL_INTERVAL_MS) || 5 * 60_000;

let _interval: ReturnType<typeof setInterval> | null = null;
let _running = false;

export function startImapPollingScheduler(): void {
    if (_interval) {
        log.warn('IMAP polling scheduler already running');
        return;
    }

    log.info({ intervalMs: TICK_MS }, 'IMAP polling scheduler started');

    _interval = setInterval(async () => {
        if (_running) {
            log.warn('Previous IMAP poll tick still running, skipping');
            return;
        }
        _running = true;
        try {
            await processImapPolling();
        } catch (err) {
            log.error({ err }, 'IMAP polling tick failed');
        } finally {
            _running = false;
        }
    }, TICK_MS);

    _interval.unref?.();
}

export function stopImapPollingScheduler(): void {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
        log.info('IMAP polling scheduler stopped');
    }
}
