/**
 * TG-LinkedIn Faz 3 — humanized send scheduling (§2).
 *
 * A pure, timezone-aware computation of WHEN an action may fire. Two levers:
 *   1. Working-hours window — only inside the account's local business hours (default
 *      Mon–Fri 09:00–18:00). A 03:00 or Sunday send is a non-human signal (§2).
 *   2. Jitter + min-gap — never a fixed interval; each action lands at a random offset and
 *      no closer than a minimum spacing from the previous one (§2 ~2m30s ±20%).
 *
 * This drives the pull queue: the route stamps research_jobs.scheduled_at with nextSendAt(),
 * so the worker simply doesn't claim the job until its humane moment — no handler-side sleep.
 * The Faz-4 sequence engine reuses these same functions to pace every enrolled step.
 *
 * Timezone math uses Intl (no external date lib). zonedTimeToUtc does a two-pass DST
 * correction. Any invalid tz / malformed working_hours falls back safely (UTC / defaults)
 * rather than throwing — a scheduling helper must never crash an enqueue.
 */

export interface WorkingHours {
    /** ISO weekdays allowed, 1=Mon … 7=Sun. */
    days: number[];
    /** Local hour the window opens (0–23). */
    start: number;
    /** Local hour the window closes (1–24), exclusive. */
    end: number;
}

export const DEFAULT_WORKING_HOURS: WorkingHours = { days: [1, 2, 3, 4, 5], start: 9, end: 18 };

/** ~90s minimum spacing between two actions on the same account (§2). */
export const DEFAULT_MIN_GAP_MS = 90_000;
/** ~150s jitter spread added on top of the min-gap floor (§2 ±20% around ~2m30s). */
export const DEFAULT_JITTER_MS = 150_000;

/** Coerce a stored working_hours JSON blob into a sane WorkingHours (fall back to default). */
export function normalizeWorkingHours(raw: unknown): WorkingHours {
    if (!raw || typeof raw !== 'object') return DEFAULT_WORKING_HOURS;
    const o = raw as Record<string, unknown>;
    const days = Array.isArray(o.days)
        ? [...new Set(o.days.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7))]
        : [];
    const start = Number.isFinite(o.start) ? Math.min(23, Math.max(0, Math.floor(o.start as number))) : DEFAULT_WORKING_HOURS.start;
    const end = Number.isFinite(o.end) ? Math.min(24, Math.max(1, Math.floor(o.end as number))) : DEFAULT_WORKING_HOURS.end;
    if (days.length === 0 || end <= start) return DEFAULT_WORKING_HOURS;
    return { days, start, end };
}

/** Return a usable IANA tz string, or 'UTC' if the input is missing/invalid. */
function safeTz(tz: string | null | undefined): string {
    if (!tz) return 'UTC';
    try {
        // Throws RangeError on an unknown tz.
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return tz;
    } catch {
        return 'UTC';
    }
}

interface ZonedParts { y: number; mo: number; d: number; h: number; mi: number; s: number; weekday: number }

const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Wall-clock parts of a UTC instant in a given tz (ISO weekday). */
function zonedParts(utcMs: number, tz: string): ZonedParts {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
    return {
        y: Number(get('year')), mo: Number(get('month')), d: Number(get('day')),
        h: Number(get('hour')) % 24, mi: Number(get('minute')), s: Number(get('second')),
        weekday: WD[get('weekday')] ?? 1,
    };
}

/** offset(ms) such that local = utc + offset, at the given instant in tz. */
function tzOffsetMs(utcMs: number, tz: string): number {
    const p = zonedParts(utcMs, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - utcMs;
}

/** UTC instant whose local wall-clock in tz is the given Y-M-D H:M (two-pass DST fix). */
function zonedTimeToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
    const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
    const off1 = tzOffsetMs(guess, tz);
    let utc = guess - off1;
    const off2 = tzOffsetMs(utc, tz);
    if (off2 !== off1) utc = guess - off2;
    return utc;
}

/** The local calendar date `i` days after (y,mo,d), with its ISO weekday. */
function addLocalDays(y: number, mo: number, d: number, i: number): { y: number; mo: number; d: number; weekday: number } {
    const t = new Date(Date.UTC(y, mo - 1, d + i));
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), weekday: ((t.getUTCDay() + 6) % 7) + 1 };
}

/** True when the instant falls inside the account's working window (hour granularity). */
export function isWithinWindow(utcMs: number, tz: string, wh: WorkingHours): boolean {
    const p = zonedParts(utcMs, tz);
    return wh.days.includes(p.weekday) && p.h >= wh.start && p.h < wh.end;
}

/**
 * Earliest UTC instant >= `fromMs` that is inside a working window: if we're currently
 * before today's window close on a working day, that's now-or-today's-open; otherwise the
 * open of the next working day (scanning up to 8 days to cross any weekend/holiday gap).
 */
export function nextWindowStart(fromMs: number, tz: string, wh: WorkingHours): number {
    const base = zonedParts(fromMs, tz);
    for (let i = 0; i <= 8; i++) {
        const date = addLocalDays(base.y, base.mo, base.d, i);
        if (!wh.days.includes(date.weekday)) continue;
        const startUtc = zonedTimeToUtc(tz, date.y, date.mo, date.d, wh.start, 0);
        if (i === 0) {
            const endUtc = zonedTimeToUtc(tz, date.y, date.mo, date.d, wh.end, 0);
            if (fromMs < endUtc) return Math.max(fromMs, startUtc);
        } else {
            return startUtc;
        }
    }
    return fromMs; // unreachable for any non-empty days set; safe fallback
}

export interface NextSendOpts {
    timezone: string | null | undefined;
    workingHours: WorkingHours;
    /** ISO timestamp of the account's previous action (for min-gap spacing); null = none. */
    lastActionAt: string | null | undefined;
    now?: number;
    minGapMs?: number;
    jitterMs?: number;
    /** Deterministic jitter fraction [0,1) for tests; omit to use Math.random(). */
    jitterFraction?: number;
}

/**
 * Compute the UTC ms an action should be scheduled for: no sooner than min-gap after the
 * last action, snapped into the working window, plus random jitter. If jitter would spill
 * past the window close, it re-snaps to the next window open.
 */
export function nextSendAt(opts: NextSendOpts): number {
    const now = opts.now ?? Date.now();
    const tz = safeTz(opts.timezone);
    const wh = opts.workingHours;
    const minGap = opts.minGapMs ?? DEFAULT_MIN_GAP_MS;
    const jitterMs = opts.jitterMs ?? DEFAULT_JITTER_MS;

    const last = opts.lastActionAt ? Date.parse(opts.lastActionAt) : NaN;
    const earliest = Number.isFinite(last) ? Math.max(now, last + minGap) : now;

    const slot = isWithinWindow(earliest, tz, wh) ? earliest : nextWindowStart(earliest, tz, wh);
    const frac = opts.jitterFraction ?? Math.random();
    const jittered = slot + Math.floor(frac * jitterMs);
    if (isWithinWindow(jittered, tz, wh)) return jittered;
    // Jitter spilled past the window close: re-snap to the NEXT open, but add fresh jitter there
    // too so sends don't all cluster exactly on the hour (a fixed 09:00:00 is its own signal).
    const open = nextWindowStart(jittered, tz, wh);
    const reJittered = open + Math.floor((opts.jitterFraction ?? Math.random()) * jitterMs);
    return isWithinWindow(reJittered, tz, wh) ? reJittered : open;
}
