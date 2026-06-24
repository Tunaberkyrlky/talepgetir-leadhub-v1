/**
 * Digest Scheduler — saat başına bir kez runDailyDigest çalıştırır (Europe/Istanbul).
 *
 * Gün ve saat kapısı tenant başına runDailyDigest içindedir (settings.digest_days +
 * digest_hour). Pattern: campaignScheduler.ts (60s interval, _running guard).
 * Idempotency: daily_digest_log UNIQUE(tenant_id, digest_date) — bkz. [[dailyDigest.ts]].
 */

import { runDailyDigest } from './dailyDigest.js';
import { createLogger } from './logger.js';

const log = createLogger('dailyDigestScheduler');

const TICK_MS = 60_000;
const TZ = 'Europe/Istanbul';

let _interval: ReturnType<typeof setInterval> | null = null;
let _running = false;
let _lastRunKey: string | null = null; // `${dateKey}-${hour}` — saat başına bir kez çalış

function currentTzHourAndDate(): { hour: number; dateKey: string } {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const map: Record<string, string> = {};
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
    return {
        hour: Number(map.hour),
        dateKey: `${map.year}-${map.month}-${map.day}`,
    };
}

export function startDailyDigestScheduler(): void {
    if (_interval) {
        log.warn('Daily digest scheduler already running');
        return;
    }

    log.info({ tz: TZ }, 'Digest scheduler started');

    _interval = setInterval(async () => {
        if (_running) return;

        const { hour, dateKey } = currentTzHourAndDate();
        const key = `${dateKey}-${hour}`;
        // Saat başına bir kez çalış; gün/saat kapısı runDailyDigest içinde per-tenant.
        if (_lastRunKey === key) return;

        _running = true;
        try {
            const result = await runDailyDigest();
            // Sadece başarıda işaretle; geçici hata sonraki tick'te tekrar denenir.
            _lastRunKey = key;
            log.info(result, 'Digest tick complete');
        } catch (err) {
            log.error({ err }, 'Digest tick failed — will retry next tick');
        } finally {
            _running = false;
        }
    }, TICK_MS);

    _interval.unref?.();
}

export function stopDailyDigestScheduler(): void {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
        log.info('Daily digest scheduler stopped');
    }
}
