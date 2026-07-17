/**
 * Background-work heartbeat registry.
 *
 * Each scheduler records the outcome of its tick so /api/health can surface
 * whether the long-lived process's background work is actually alive: a hung or
 * stopped interval shows up as a stale `lastTickAt`, and a failing tick shows
 * `lastError`. Campaign/IMAP tick frequently (good liveness signals); the daily
 * digest records only on an actual run (hourly gate), so its timestamp is
 * expected to be older.
 */

export interface Heartbeat {
    lastTickAt: string;        // ISO — last time the tick body ran
    lastOkAt: string | null;   // ISO — last time the tick completed without throwing
    lastError: string | null;  // message of the most recent failed tick (cleared on success)
}

const beats: Record<string, Heartbeat> = {};

export function recordTick(name: string, ok: boolean, err?: unknown): void {
    const now = new Date().toISOString();
    const prev = beats[name];
    beats[name] = {
        lastTickAt: now,
        lastOkAt: ok ? now : (prev?.lastOkAt ?? null),
        lastError: ok ? null : (err instanceof Error ? err.message : String(err ?? 'unknown')),
    };
}

export function getHeartbeats(): Record<string, Heartbeat> {
    return beats;
}

/**
 * Public-safe view for the unauthenticated /api/health: timestamps + a boolean
 * ok flag, WITHOUT the raw lastError text (which can embed internal infra detail
 * like DB relation/host names). Full lastError stays available via getHeartbeats()
 * for any future authenticated/admin surface.
 */
export function getHeartbeatsPublic(): Record<string, { lastTickAt: string; lastOkAt: string | null; ok: boolean }> {
    const out: Record<string, { lastTickAt: string; lastOkAt: string | null; ok: boolean }> = {};
    for (const [name, b] of Object.entries(beats)) {
        out[name] = { lastTickAt: b.lastTickAt, lastOkAt: b.lastOkAt, ok: b.lastError === null };
    }
    return out;
}
