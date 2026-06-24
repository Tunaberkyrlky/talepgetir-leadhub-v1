/**
 * Digest Scheduler — her gün 08:00 (Europe/Istanbul) tetiklenen tick.
 *
 * Tick günlüktür; "haftada 2 gün" gün kapısı tenant başına runDailyDigest içindedir
 * (settings.digest_days). Pattern: campaignScheduler.ts (60s interval, _running guard).
 * Idempotency: daily_digest_log UNIQUE(tenant_id, digest_date) — bkz. [[dailyDigest.ts]].
 */

import { runDailyDigest } from './dailyDigest.js';
import { createLogger } from './logger.js';

const log = createLogger('dailyDigestScheduler');

const TICK_MS = 60_000;
const TZ = 'Europe/Istanbul';
// Override hour for staging/dev testing; defaults to 8 (08:00 TR)
const SEND_HOUR = Number(process.env.DAILY_DIGEST_HOUR ?? 8);

let _interval: ReturnType<typeof setInterval> | null = null;
let _running = false;
let _lastFiredDateKey: string | null = null;

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

    log.info({ sendHour: SEND_HOUR, tz: TZ }, 'Daily digest scheduler started');

    _interval = setInterval(async () => {
        if (_running) return;

        const { hour, dateKey } = currentTzHourAndDate();
        if (hour !== SEND_HOUR) return;
        // Only fire once per day per instance — DB UNIQUE handles cross-instance races.
        if (_lastFiredDateKey === dateKey) return;

        _running = true;
        try {
            const result = await runDailyDigest();
            // Mark the day done only on success, so a transient failure (DB blip,
            // Resend timeout) retries on the next tick instead of skipping the day.
            _lastFiredDateKey = dateKey;
            log.info(result, 'Daily digest tick complete');
        } catch (err) {
            log.error({ err }, 'Daily digest tick failed — will retry next tick');
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
