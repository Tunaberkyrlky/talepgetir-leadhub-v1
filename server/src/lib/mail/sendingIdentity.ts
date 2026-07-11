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
 *                         There is NO user→mailbox column on email_connections
 *                         yet (migration 116 pending), so an owner is pinned by
 *                         `accountEmail`; `ownerUserId` ALONE cannot map to a
 *                         mailbox and fails closed (see the input contract).
 *                         Absent both, it resolves the tenant default box.
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

/** The three sending identity classes (MEGA §3.2.1). */
export type SendClass = 'personal_grade' | 'brand_transactional' | 'marketing';

/** Which transport carries the resolved identity. */
export type IdentityTransport = 'owner_mailbox' | 'resend' | 'campaign_mailbox';

/**
 * Minimum identity health, read ONLY from the persisted record / env — no live
 * verify. `ok` = the identity is present and usable (mailbox row is active, or
 * Resend env is configured). `unknown` = present but no freshness signal we can
 * trust (SMTP verify status isn't persisted; only IMAP populates lastPolledAt).
 */
export type IdentityHealthStatus = 'ok' | 'unknown';

export interface IdentityHealth {
    status: IdentityHealthStatus;
    /** Last IMAP poll — freshness hint; null for SMTP-only / Nango mailboxes. */
    lastPolledAt?: string | null;
    /** brand_transactional only: whether RESEND_API_KEY + RESEND_FROM_EMAIL are set. */
    configured?: boolean;
}

/** Why a class could not resolve — the caller pauses; it does NOT fall back. */
export type ResolveFailureReason =
    | 'no_owner_mailbox'                  // personal_grade: tenant has no active mailbox to send AS
    | 'owner_mailbox_mapping_unavailable' // ownerUserId given but no user→mailbox column yet (migration 116)
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
     * Reserved (Phase 5 contract — do NOT remove). There is no user→mailbox
     * column on email_connections yet (migration 116 pending), so an owner CANNOT
     * be mapped to a mailbox from here. Passing `ownerUserId` WITHOUT `accountEmail`
     * fails closed with `owner_mailbox_mapping_unavailable` rather than silently
     * ignoring the pin and dropping to the tenant default (which would send AS the
     * wrong identity). Once migration 116 lands this will resolve the owner's box.
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
    // Lookups already filter is_active=true, so a returned row is active. SMTP
    // verify status isn't persisted; IMAP-backed boxes carry last_polled_at.
    return { status: 'ok', lastPolledAt: conn.last_polled_at };
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
 * Resolve the sending identity for a class. Pure READ: never sends, never
 * re-verifies a mailbox, never probes Nango. Returns a typed { ok:false } on a
 * missing / unmappable identity — the caller decides to pause; it does not fall
 * back to the brand (MEGA §3.2.5).
 */
export async function resolveSendingIdentity(input: ResolveSendingIdentityInput): Promise<ResolveResult> {
    const { tenantId, sendClass, ownerUserId, accountEmail } = input;

    // Fail closed on an owner pin we cannot honor yet: email_connections has no
    // user→mailbox column (migration 116 pending), so an ownerUserId with no
    // accountEmail cannot be resolved to a mailbox. Do NOT ignore the pin and fall
    // to the tenant default — that would send AS the wrong identity (§3.2.5).
    if (ownerUserId && !accountEmail) {
        return {
            ok: false,
            sendClass,
            reason: 'owner_mailbox_mapping_unavailable',
            message: 'email_connections has no owner mapping yet (migration 116 pending)',
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
