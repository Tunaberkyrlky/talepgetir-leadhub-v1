/**
 * Deliverability Health — a PURE read-model + compute layer for D4's health panel
 * (MEGA §4.3). It projects the freshness signals that already live on an
 * email_connections row (D3 persisted last_verified_at / last_verify_ok via
 * migration 130; IMAP polling writes last_polled_at) into a deterministic
 * green/yellow/red traffic light plus i18n reason KEYS.
 *
 * This module has NO I/O: it never queries, never sends, never verifies, never
 * touches DNS. The route reads the rows (reusing PUBLIC_COLUMNS) and maps each
 * through here. Everything below is a deterministic function of the row —
 * missing data degrades to 'yellow'/'unknown', never throws (§2.3.1 read-only).
 *
 * Not modelled here (documented, not fabricated):
 *   - sendClass is derived per CHANNEL (defaultSendClassForChannel), not stored
 *     per connection, so we expose `provider` instead of a fake per-row class.
 *   - daily_volume / bounce_rate have NO per-identity source today (campaign
 *     bounces key on activity_id, plusvibe bounces are per-campaign), so they
 *     stay null placeholders rather than inventing a join.
 */

/** Traffic-light verdict for one sending identity. */
export type TrafficLight = 'green' | 'yellow' | 'red';

/** DNS record verdict. Always 'unknown' this slice — real lookup is env-gated + stubbed. */
export type DnsStatus = 'pass' | 'fail' | 'unknown';

/** The row shape this module reads — a subset of PUBLIC_COLUMNS (no secrets). */
export interface DeliverabilityHealthInput {
    email_address: string;
    provider: string;
    is_active: boolean;
    last_verified_at: string | null;
    last_verify_ok: boolean | null;
    last_polled_at: string | null;
}

/** Client-facing projection returned per identity by GET /email-connections/health. */
export interface DeliverabilityHealth {
    email: string;
    provider: string;
    is_active: boolean;
    last_verified_at: string | null;
    last_verify_ok: boolean | null;
    last_polled_at: string | null;
    traffic_light: TrafficLight;
    /** i18n reason KEYS (client maps via t('deliverability.reason.<key>')) — no TR/EN prose here. */
    reasons: string[];
    dns: { spf: DnsStatus; dkim: DnsStatus; dmarc: DnsStatus };
    /** No per-identity source yet — always null placeholder (documented). */
    daily_volume: number | null;
    /** No per-identity source yet — always null placeholder (documented). */
    bounce_rate: number | null;
}

/** A verify older than this is "stale" — active, but the freshness signal has decayed. */
const FRESH_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deterministic traffic light from the persisted row only (no re-verify):
 *   RED    — inactive box, OR the last SMTP verify explicitly failed.
 *   GREEN  — active + last verify succeeded within FRESH_DAYS.
 *   YELLOW — active but attention/unknown: never verified (Nango/OAuth boxes have
 *            null last_verify_ok — verify is SMTP-only), or the verify is stale.
 * Returns i18n reason KEYS; never throws (unparseable date falls through to yellow).
 */
export function computeTrafficLight(row: DeliverabilityHealthInput): { light: TrafficLight; reasons: string[] } {
    // RED: inactive box first, then an explicit verify failure.
    if (row.is_active === false) {
        return { light: 'red', reasons: ['inactive'] };
    }
    if (row.last_verify_ok === false) {
        return { light: 'red', reasons: ['verify_failed'] };
    }

    // Active from here. A successful, dated verify can go green if it's still fresh.
    if (row.last_verify_ok === true && row.last_verified_at) {
        const ageMs = Date.now() - new Date(row.last_verified_at).getTime();
        if (Number.isFinite(ageMs) && ageMs <= FRESH_DAYS * DAY_MS) {
            return { light: 'green', reasons: ['active_recent'] };
        }
        return { light: 'yellow', reasons: ['stale_verify'] };
    }

    // Active but no trustworthy verify signal (Nango/OAuth box, or verify never ran).
    return { light: 'yellow', reasons: ['never_verified'] };
}

/**
 * DNS (SPF/DKIM/DMARC) resolution — an env-gated STUB. This slice makes NO real
 * network/DNS call: with DELIVERABILITY_DNS_CHECK unset we return 'unknown', and
 * even when it IS set the real lookup is deliberately left as a TODO so no
 * dns.resolveTxt / socket ever fires here. (Env-gate mirrors the repo's
 * isTrackingConfigured / isConfigured boolean-guard pattern.)
 */
export function resolveDns(_row: DeliverabilityHealthInput): { spf: DnsStatus; dkim: DnsStatus; dmarc: DnsStatus } {
    const unknown = { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' } as const;
    if (!process.env.DELIVERABILITY_DNS_CHECK) return { ...unknown };
    // TODO(D-future): real dns.resolveTxt SPF/DKIM/DMARC lookup — NOT in this slice.
    // Even behind the flag we return 'unknown' so no live DNS call happens this round.
    return { ...unknown };
}

/** Compose the full per-identity health projection from a row. */
export function buildDeliverabilityHealth(row: DeliverabilityHealthInput): DeliverabilityHealth {
    const { light, reasons } = computeTrafficLight(row);
    return {
        email: row.email_address,
        provider: row.provider,
        is_active: row.is_active,
        last_verified_at: row.last_verified_at,
        last_verify_ok: row.last_verify_ok,
        last_polled_at: row.last_polled_at,
        traffic_light: light,
        reasons,
        dns: resolveDns(row),
        // No per-identity source — placeholders, not fabricated numbers (see file header).
        daily_volume: null,
        bounce_rate: null,
    };
}

/**
 * "Slow-on-red" advice — a PASSIVE, pure helper. Returns a send-rate multiplier
 * (green=1.0, yellow=0.5, red=0) as future guidance for an automation throttle.
 *
 * ADVICE-ONLY: this is wired into NO send/campaign/automation path in this slice.
 * The automation worker is unwired (AUTOMATION_WORKER_ENABLED), so nothing calls
 * this and it changes nothing. It exists as documented scaffolding for D-future.
 */
export function deliverabilitySlowdownFactor(health: Pick<DeliverabilityHealth, 'traffic_light'>): number {
    switch (health.traffic_light) {
        case 'green':
            return 1.0;
        case 'yellow':
            return 0.5;
        case 'red':
        default:
            return 0;
    }
}
