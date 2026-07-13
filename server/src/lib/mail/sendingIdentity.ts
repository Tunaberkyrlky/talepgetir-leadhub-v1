/**
 * Sending Identity — the single source of truth for WHICH identity an outbound
 * message goes out AS. Three send classes, one non-throwing resolver.
 *
 * Golden rule (MEGA §3.2): a message that moves a lead toward the sale leaves
 * from a real HUMAN identity; a system receipt leaves from the BRAND identity.
 *
 *   personal_grade      → the owner's real mailbox (Gmail/Nango or SMTP). The
 *                         message lands in their Sent folder; replies thread
 *                         back over the existing IMAP inbound. No brand fallback.
 *                         An owner is pinned either by `accountEmail` or, absent
 *                         that, by `ownerUserId` via email_connections.owner_user_id
 *                         (migration 117); an ownerUserId with no owned mailbox
 *                         fails closed (see the input contract). Absent both, it
 *                         resolves the tenant default box.
 *   brand_transactional → Resend, verified brand domain (booking receipts,
 *                         "your report link", system notices). Person-looking
 *                         `from` + `reply_to` owner is allowed (§3.2.3 / D7).
 *   marketing           → campaign mailbox. The drip ROTATION picks the box
 *                         upstream; this resolver does NOT run the rotation, so
 *                         marketing REQUIRES `accountEmail` (the rotation's chosen
 *                         box). Without it we return a typed { ok:false,
 *                         reason:'rotation_account_required' } instead of silently
 *                         dropping to the tenant default — which would BYPASS the
 *                         campaign rotation. Never the root domain.
 *
 * WP0 is a FOUNDATION layer: it only READS (email_connections rows + Resend env)
 * — it never sends, never re-runs verifySmtp/verifyImap, never probes Nango. The
 * default-mailbox pick is a single read ordered is_default → oldest-active → id,
 * so the choice is deterministic even on a tie (no DB constraint / migration).
 * §3.2.5 guardrail: personal_grade with no owner mailbox returns a typed
 * { ok: false } — it MUST NOT silently drop to the brand identity.
 */

import { supabaseAdmin } from '../supabase.js';
import { getConnectionByEmail } from '../emailConnections.js';
import type { EmailConnection } from '../emailConnections.js';
import type { MailChannel } from './types.js';
import { isConfigured as isResendConfigured } from '../systemMailer.js';
import { createLogger } from '../logger.js';
import { isMissingColumnError } from '../supabaseErrors.js';

const log = createLogger('mail:sendingIdentity');

/** The three sending identity classes (MEGA §3.2.1). */
export type SendClass = 'personal_grade' | 'brand_transactional' | 'marketing';

/** Which transport carries the resolved identity. */
export type IdentityTransport = 'owner_mailbox' | 'resend' | 'campaign_mailbox';

/**
 * Minimum identity health, read ONLY from the persisted record / env — no live
 * verify. `ok` = the identity is present and usable (mailbox row is active, or
 * Resend env is configured). `unknown` = present but no freshness signal we can
 * trust. SMTP verify status IS now persisted (migration 130) and surfaced via
 * lastVerifiedAt / lastVerifyOk below; IMAP-backed boxes also populate lastPolledAt.
 */
export type IdentityHealthStatus = 'ok' | 'unknown';

export interface IdentityHealth {
    status: IdentityHealthStatus;
    /** Last IMAP poll — freshness hint; null for SMTP-only / Nango mailboxes. */
    lastPolledAt?: string | null;
    /** Last SMTP connection-verify time (migration 130); null for never-verified / Nango boxes. */
    lastVerifiedAt?: string | null;
    /** Whether that last SMTP verify succeeded; null when never verified. */
    lastVerifyOk?: boolean | null;
    /** brand_transactional only: whether RESEND_API_KEY + RESEND_FROM_EMAIL are set. */
    configured?: boolean;
}

/** Why a class could not resolve — the caller pauses; it does NOT fall back. */
export type ResolveFailureReason =
    | 'no_owner_mailbox'                  // personal_grade: tenant has no active mailbox to send AS
    | 'owner_mailbox_mapping_unavailable' // ownerUserId given but no owned mailbox (or the owner_user_id column is absent pre-117) — a mapping GAP, fail closed
    | 'owner_mailbox_lookup_failed'       // ownerUserId given but the mailbox lookup hit a REAL DB error (not a missing column) — a transient/retryable fault, NOT a mapping gap
    | 'resend_unconfigured'               // brand_transactional: RESEND_* env missing
    | 'rotation_account_required'         // marketing: the rotation's accountEmail is mandatory (not passed)
    | 'no_marketing_mailbox';             // marketing: the passed campaign mailbox is not active

/**
 * The resolved identity, split by transport so a consumer gets compile-time
 * non-null guarantees per class:
 *   - owner_mailbox / campaign_mailbox → `connection` and `accountEmail` are
 *     REQUIRED and non-null (a real mailbox row we send AS).
 *   - resend → `accountEmail`/`connection` are null (the brand `from` comes from
 *     env at send) and `replyTo` is REQUIRED (the owner reply-to hint, or null).
 * Narrow on `.transport` (or the co-varying `.sendClass`) before use.
 */
interface ResolvedIdentityBase {
    ok: true;
    /** Optional display name override; the transport builds the final `from`. */
    fromName?: string | null;
    health: IdentityHealth;
}

/** personal_grade → the owner's real mailbox. `connection`/`accountEmail` guaranteed. */
export interface OwnerMailboxIdentity extends ResolvedIdentityBase {
    sendClass: 'personal_grade';
    transport: 'owner_mailbox';
    /** The mailbox we send FROM. */
    accountEmail: string;
    /** Underlying mailbox connection (carries the SMTP/Nango credentials). */
    connection: EmailConnection;
}

/** marketing → the rotation's campaign mailbox. `connection`/`accountEmail` guaranteed. */
export interface CampaignMailboxIdentity extends ResolvedIdentityBase {
    sendClass: 'marketing';
    transport: 'campaign_mailbox';
    /** The rotation-selected mailbox we send FROM. */
    accountEmail: string;
    /** Underlying mailbox connection (carries the SMTP/Nango credentials). */
    connection: EmailConnection;
}

/** brand_transactional → Resend. `from` is built from RESEND_FROM_* at send time. */
export interface ResendIdentity extends ResolvedIdentityBase {
    sendClass: 'brand_transactional';
    transport: 'resend';
    /** No mailbox row — the brand `from` comes from env, so this is null. */
    accountEmail: null;
    /** reply_to hint carrying a person-looking owner (§3.2.3 / D7); null when unset. */
    replyTo: string | null;
    /** No underlying mailbox connection for the Resend transport. */
    connection: null;
}

/** Discriminated success result: inspect `.transport` / `.sendClass` before use. */
export type ResolvedIdentity = OwnerMailboxIdentity | CampaignMailboxIdentity | ResendIdentity;

export interface UnresolvedIdentity {
    ok: false;
    sendClass: SendClass;
    reason: ResolveFailureReason;
    /** Human-readable, non-throwing — no silent brand fallback (§3.2.5). */
    message: string;
}

/** Discriminated result: inspect `.ok` before using the identity. */
export type ResolveResult = ResolvedIdentity | UnresolvedIdentity;

export interface ResolveSendingIdentityInput {
    tenantId: string;
    sendClass: SendClass;
    /**
     * Pin the send to a specific human owner. WITHOUT `accountEmail`, a
     * personal_grade send resolves the owner's OWN mailbox via
     * email_connections.owner_user_id (migration 117). If the owner has no owned
     * active box — or the column is absent on a pre-117 DB — it fails closed with
     * `owner_mailbox_mapping_unavailable` rather than silently dropping to the
     * tenant default (which would send AS the wrong identity). WITH `accountEmail`,
     * that explicit box wins and this is ignored.
     */
    ownerUserId?: string | null;
    /**
     * Pin a specific mailbox (an explicit "From", or the rotation's chosen box for
     * marketing). For personal_grade it falls back to the tenant default mailbox
     * when absent; for marketing it is MANDATORY — the rotation picks it upstream
     * and this resolver never runs the rotation itself.
     */
    accountEmail?: string | null;
}

/**
 * Default send class for a channel — the mapping today's callers already imply,
 * captured here so the Phase 5 automation adapter reads ONE source of truth
 * instead of each caller inventing its own. B1 does not wire this into callers
 * (that would only add unread params); it documents + centralizes the mapping.
 *
 *   system            → brand_transactional (Resend, as router.ts does today)
 *   campaign          → marketing (drip; delegates to today's mailbox rotation)
 *   compose|reply|forward → personal_grade (1:1 from the owner mailbox)
 */
export function defaultSendClassForChannel(channel: MailChannel): SendClass {
    switch (channel) {
        case 'system':
            return 'brand_transactional';
        case 'campaign':
            return 'marketing';
        case 'compose':
        case 'reply':
        case 'forward':
        default:
            return 'personal_grade';
    }
}

/** Health of a mailbox connection, read from the row only (no re-verify). */
function mailboxHealth(conn: EmailConnection): IdentityHealth {
    // Lookups already filter is_active=true, so a returned row is active. IMAP-backed
    // boxes carry last_polled_at; SMTP verify freshness now lands in last_verified_at /
    // last_verify_ok (migration 130). Status stays 'ok' for an active row — flipping it
    // to 'unknown' on a stale/failed verify is a resolver-semantics change (D4's health
    // panel consumes these new freshness fields; D3 only exposes them).
    return {
        status: 'ok',
        lastPolledAt: conn.last_polled_at,
        lastVerifiedAt: conn.last_verified_at,
        lastVerifyOk: conn.last_verify_ok,
    };
}

/**
 * Resolve a sending mailbox WITHOUT throwing. With `accountEmail` it pins that
 * exact box; without it, it picks the tenant default the same way
 * getDefaultConnection does (is_default-first, oldest-active) but returns null
 * instead of a 412 so personal_grade can pause cleanly (§3.2.5).
 */
async function resolveMailbox(tenantId: string, accountEmail?: string | null): Promise<EmailConnection | null> {
    if (accountEmail) return getConnectionByEmail(tenantId, accountEmail);
    // Default box: a direct read (not listConnections) because connected_at — the
    // "oldest-active" key — isn't in FULL_COLUMNS, so the list can't be re-sorted
    // client-side. select('*') carries the full row (incl. the secrets the send
    // path needs) PLUS connected_at for ordering. The final `id asc` is the stable
    // tie-break so the pick is deterministic when two boxes share is_default AND
    // connected_at (P3-2) — no DB constraint / migration.
    const { data } = await supabaseAdmin
        .from('email_connections')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .order('is_default', { ascending: false })
        .order('connected_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();
    return (data as unknown as EmailConnection | null) ?? null;
}

/**
 * Outcome of an owner-mailbox lookup, so the resolver can tell a legitimate
 * "no box mapped" apart from a real DB fault:
 *   - ok       → an owned active mailbox was found.
 *   - unmapped → no owned active box, OR the owner_user_id column is absent
 *                (pre-117 DB) — an expected mapping GAP; the caller fails closed.
 *   - error    → a real DB/permission error — surfaced typed so it is NOT
 *                misreported as a mapping gap.
 */
type OwnerMailboxLookup =
    | { kind: 'ok'; conn: EmailConnection }
    | { kind: 'unmapped' }
    | { kind: 'error'; message: string };

/**
 * Resolve the owner's OWN mailbox via email_connections.owner_user_id (migration
 * 117). Same deterministic pick as resolveMailbox (is_default → oldest-active →
 * id). Returns a typed OwnerMailboxLookup so the caller can distinguish an owned
 * box (ok), a mapping gap / pre-117 missing column (unmapped → fail closed), and a
 * real DB fault (error → typed lookup failure, NOT masked as a mapping gap). Never
 * re-verifies / probes.
 */
async function resolveOwnerMailbox(tenantId: string, ownerUserId: string): Promise<OwnerMailboxLookup> {
    try {
        const { data, error } = await supabaseAdmin
            .from('email_connections')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('owner_user_id', ownerUserId)
            .eq('is_active', true)
            .order('is_default', { ascending: false })
            .order('connected_at', { ascending: true })
            .order('id', { ascending: true })
            .limit(1)
            .maybeSingle();
        if (error) {
            // ONLY a missing owner_user_id column (pre-117 DB) is an expected "unmapped"
            // fail-closed. Any OTHER error is a real fault — surface it typed instead of
            // pretending the owner simply has no box.
            if (isMissingColumnError(error, 'owner_user_id')) return { kind: 'unmapped' };
            log.error({ err: error, tenantId, ownerUserId }, 'resolveOwnerMailbox query failed');
            return { kind: 'error', message: error.message ?? 'owner mailbox lookup failed' };
        }
        if (!data) return { kind: 'unmapped' }; // no owned active box → fail closed
        return { kind: 'ok', conn: data as unknown as EmailConnection };
    } catch (e) {
        log.error({ err: e, tenantId, ownerUserId }, 'resolveOwnerMailbox threw');
        return { kind: 'error', message: e instanceof Error ? e.message : 'owner mailbox lookup failed' };
    }
}

/**
 * Resolve the sending identity for a class. Pure READ: never sends, never
 * re-verifies a mailbox, never probes Nango. Returns a typed { ok:false } on a
 * missing / unmappable identity — the caller decides to pause; it does not fall
 * back to the brand (MEGA §3.2.5).
 */
export async function resolveSendingIdentity(input: ResolveSendingIdentityInput): Promise<ResolveResult> {
    const { tenantId, sendClass, ownerUserId, accountEmail } = input;

    // Owner pin without an explicit accountEmail: resolve the owner's OWN mailbox via
    // email_connections.owner_user_id (migration 117). Only meaningful for a
    // personal-grade (1:1) send. On a DB where the column doesn't exist yet, or where
    // the owner has no owned active mailbox, fail closed with the typed reason — do
    // NOT ignore the pin and fall to the tenant default (that would send AS the wrong
    // identity, §3.2.5).
    if (ownerUserId && !accountEmail) {
        if (sendClass === 'personal_grade') {
            const lookup = await resolveOwnerMailbox(tenantId, ownerUserId);
            if (lookup.kind === 'ok') {
                const conn = lookup.conn;
                return {
                    ok: true,
                    sendClass: 'personal_grade',
                    transport: 'owner_mailbox',
                    accountEmail: conn.email_address,
                    connection: conn,
                    health: mailboxHealth(conn),
                };
            }
            if (lookup.kind === 'error') {
                // A REAL DB fault (not a missing column) — pause with a DISTINCT typed reason
                // so a transient lookup failure isn't misreported as a permanent mapping gap.
                return {
                    ok: false,
                    sendClass,
                    reason: 'owner_mailbox_lookup_failed',
                    message:
                        `Owner mailbox lookup failed (transient DB error): ${lookup.message}. ` +
                        'Automation pauses — this is a lookup fault, not a mapping gap; retry is safe (§3.2.5).',
                };
            }
            // lookup.kind === 'unmapped' → fall through to the mapping_unavailable return below.
        }
        return {
            ok: false,
            sendClass,
            reason: 'owner_mailbox_mapping_unavailable',
            message:
                'No mailbox is mapped to this owner (email_connections.owner_user_id). ' +
                'Automation pauses — the brand identity is not a substitute (§3.2.5).',
        };
    }

    switch (sendClass) {
        case 'personal_grade': {
            const conn = await resolveMailbox(tenantId, accountEmail);
            if (!conn) {
                return {
                    ok: false,
                    sendClass,
                    reason: 'no_owner_mailbox',
                    message:
                        'No connected owner mailbox for personal-grade send. ' +
                        'Automation pauses — the brand identity is not a substitute (§3.2.5).',
                };
            }
            return {
                ok: true,
                sendClass: 'personal_grade',
                transport: 'owner_mailbox',
                accountEmail: conn.email_address,
                connection: conn,
                health: mailboxHealth(conn),
            };
        }

        case 'brand_transactional': {
            if (!isResendConfigured()) {
                return {
                    ok: false,
                    sendClass,
                    reason: 'resend_unconfigured',
                    message: 'Resend is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL missing).',
                };
            }
            // Person-looking from + reply_to owner (§3.2.3 / D7): if the caller
            // passed an owner address, carry it as reply_to so replies thread to
            // the human. The brand `from` itself is built from RESEND_FROM_* at send.
            return {
                ok: true,
                sendClass: 'brand_transactional',
                transport: 'resend',
                accountEmail: null,
                replyTo: accountEmail ?? null,
                connection: null,
                health: { status: 'ok', configured: true },
            };
        }

        case 'marketing': {
            // Marketing MUST send from the rotation's chosen box. This resolver does
            // NOT run the rotation — Phase 5's caller runs campaignEngine's rotation
            // first and passes the winner as accountEmail. Absent it we fail closed
            // rather than dropping to the tenant default (which would bypass rotation).
            if (!accountEmail) {
                return {
                    ok: false,
                    sendClass,
                    reason: 'rotation_account_required',
                    message:
                        'Marketing send requires the rotation-selected mailbox (accountEmail). ' +
                        'Run the campaign rotation first and pass the chosen box.',
                };
            }
            const conn = await getConnectionByEmail(tenantId, accountEmail);
            if (!conn) {
                return {
                    ok: false,
                    sendClass,
                    reason: 'no_marketing_mailbox',
                    message: 'No active campaign mailbox for marketing send.',
                };
            }
            return {
                ok: true,
                sendClass: 'marketing',
                transport: 'campaign_mailbox',
                accountEmail: conn.email_address,
                connection: conn,
                health: mailboxHealth(conn),
            };
        }
    }
}
