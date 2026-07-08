/**
 * TG-LinkedIn Faz 3 — per-account rate ceilings + warmup ramp (§1).
 *
 * These are pure functions over an account's warmup timestamp. They replace the flat
 * Faz-2 DAILY_CAPS backstop with a real ramp: a new/cold account starts LOW (5 invites/
 * day) and climbs to a conservative plateau over ~2 weeks — the single strongest anti-ban
 * lever (a cold account blasting 40 invites/day is the clearest automation signal, §1).
 *
 * Warmup is CALENDAR-based (days since warmup_started_at), not an activity counter we
 * increment: a timestamp is race-free, survives restarts, and can't be reset by toggling a
 * flag (schema 083 note). The tradeoff — an idle account still "ages" into a higher cap —
 * is acceptable: the cap is a CEILING, not a target, and the scheduler (schedule.ts) plus
 * the weekly window keep actual volume humane regardless of the daily ceiling.
 */

export type ActionType = 'invite' | 'message';

/** Daily plateau (fully warmed) per action — the conservative top of the §1 band. */
export const PLATEAU: Record<ActionType, number> = { invite: 25, message: 60 };

/**
 * Rolling 7-day ceiling per action (§1: invites ~100/week; messages softer). Enforced from
 * the linkedin_actions audit trail (actual landed sends), so it bounds sustained volume even
 * if every day stays under the daily cap. `null` = uncapped (not used for invite/message).
 */
export const WEEKLY_CAP: Record<ActionType, number> = { invite: 100, message: 250 };

/**
 * Warmup step function per action: `start` on day 0, +`step` every `stepDays` days, clamped
 * to PLATEAU. Invites ramp slowest (highest ban risk on cold accounts); messages start higher
 * (1st-degree recipients who already accepted an invite = far lower risk).
 */
const WARMUP: Record<ActionType, { start: number; step: number; stepDays: number }> = {
    invite: { start: 5, step: 3, stepDays: 2 },
    message: { start: 15, step: 5, stepDays: 2 },
};

const DAY_MS = 86_400_000;

/**
 * Whole days elapsed since warmup began. Fail-CLOSED to day 0 (the lowest cap) when the
 * timestamp is missing/unparseable — an unknown warmup age must never grant the plateau.
 * `createdAt` is the fallback origin (older accounts predate the warmup_started_at column).
 */
export function warmupDay(
    warmupStartedAt: string | null | undefined,
    createdAt: string | null | undefined,
    now: number = Date.now(),
): number {
    const src = warmupStartedAt || createdAt || '';
    const started = Date.parse(src);
    if (!Number.isFinite(started)) return 0;
    return Math.max(0, Math.floor((now - started) / DAY_MS));
}

/**
 * The effective daily cap for an action given the account's warmup age. Monotonic in day,
 * never above PLATEAU. This is the value passed to the atomic consume RPC as the daily cap.
 */
export function effectiveDailyCap(
    type: ActionType,
    warmupStartedAt: string | null | undefined,
    createdAt: string | null | undefined,
    now: number = Date.now(),
): number {
    const w = WARMUP[type];
    const day = warmupDay(warmupStartedAt, createdAt, now);
    const ramped = w.start + w.step * Math.floor(day / w.stepDays);
    return Math.min(PLATEAU[type], ramped);
}
