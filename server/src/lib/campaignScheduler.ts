/**
 * Campaign Scheduler — 60s interval tick
 * Pattern: auth.ts:20-29 (cache cleanup interval)
 */

import { processScheduledEmails } from './campaignEngine.js';
import { createLogger } from './logger.js';

const log = createLogger('campaignScheduler');
const TICK_MS = 60_000;

let _interval: ReturnType<typeof setInterval> | null = null;

export function startCampaignScheduler(): void {
    if (_interval) {
        log.warn('Campaign scheduler already running');
        return;
    }

    log.info({ intervalMs: TICK_MS }, 'Campaign scheduler started');

    _interval = setInterval(async () => {
        try {
            await processScheduledEmails();
        } catch (err) {
            log.error({ err }, 'Campaign scheduler tick failed');
        }
    }, TICK_MS);

    _interval.unref?.();
}

export function stopCampaignScheduler(): void {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
        log.info('Campaign scheduler stopped');
    }
}
