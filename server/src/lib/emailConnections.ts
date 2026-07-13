/**
 * Email connection lookup — shared across send (emailSender/smtpAdapter),
 * routes (email-connections) and IMAP polling.
 *
 * A tenant can have MULTIPLE connections (Workspace via Nango + SMTP, mixed).
 * One is flagged is_default for compose's "From" default.
 */

import { supabaseAdmin } from './supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from './logger.js';

const log = createLogger('lib:emailConnections');

export type ConnectionProvider = 'google-mail' | 'microsoft-outlook' | 'smtp';

export interface EmailConnection {
    id: string;
    tenant_id: string;
    provider: ConnectionProvider;
    email_address: string;
    connection_id: string | null;
    is_active: boolean;
    is_default: boolean;
    // SMTP/IMAP (null for Nango connections)
    smtp_host: string | null;
    smtp_port: number | null;
    smtp_secure: boolean | null;
    imap_host: string | null;
    imap_port: number | null;
    imap_secure: boolean | null;
    username: string | null;
    encrypted_password: string | null;
    allow_invalid_cert: boolean | null;
    last_polled_at: string | null;
    last_seen_uid: number | null;
    last_uid_validity: number | null;
    // SMTP connection-verify freshness (migration 130). null = never verified.
    last_verified_at: string | null;
    last_verify_ok: boolean | null;
    last_verify_error: string | null;
}

// Columns safe to send to send/poll paths (includes secrets — never return to client)
const FULL_COLUMNS =
    'id, tenant_id, provider, email_address, connection_id, is_active, is_default, ' +
    'smtp_host, smtp_port, smtp_secure, imap_host, imap_port, imap_secure, ' +
    'username, encrypted_password, allow_invalid_cert, last_polled_at, last_seen_uid, last_uid_validity, ' +
    'last_verified_at, last_verify_ok, last_verify_error';

// Columns safe to expose to the client (NO encrypted_password, NO last_verify_error —
// the raw verify error is an info-oracle, kept server-side like the route's generic-error guard)
const PUBLIC_COLUMNS =
    'id, provider, email_address, is_active, is_default, connected_at, ' +
    'smtp_host, smtp_port, imap_host, imap_port, username, last_polled_at, ' +
    'last_verified_at, last_verify_ok';

/** Resolve a specific connection by its sender address. */
export async function getConnectionByEmail(
    tenantId: string,
    accountEmail: string,
): Promise<EmailConnection | null> {
    const { data } = await supabaseAdmin
        .from('email_connections')
        .select(FULL_COLUMNS)
        .eq('tenant_id', tenantId)
        .eq('email_address', accountEmail)
        .eq('is_active', true)
        .maybeSingle();
    return (data as unknown as EmailConnection | null) ?? null;
}

/**
 * Default sending connection: is_default=true, else the oldest active one.
 * Throws 412 when the tenant has no active connection at all.
 */
export async function getDefaultConnection(tenantId: string): Promise<EmailConnection> {
    const { data: def } = await supabaseAdmin
        .from('email_connections')
        .select(FULL_COLUMNS)
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .eq('is_default', true)
        .maybeSingle();

    if (def) return def as unknown as EmailConnection;

    // Fallback: oldest active connection (back-compat for tenants without a default flag)
    const { data: fallback } = await supabaseAdmin
        .from('email_connections')
        .select(FULL_COLUMNS)
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .order('connected_at', { ascending: true })
        .limit(1)
        .maybeSingle();

    if (!fallback) {
        throw new AppError(
            'No active email connection. Connect Gmail, Outlook or an SMTP account in Settings before sending.',
            412,
        );
    }
    return fallback as unknown as EmailConnection;
}

/** All active connections for a tenant (UI dropdown). */
export async function listConnections(tenantId: string): Promise<EmailConnection[]> {
    const { data } = await supabaseAdmin
        .from('email_connections')
        .select(FULL_COLUMNS)
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .order('is_default', { ascending: false })
        .order('connected_at', { ascending: true });
    return (data as unknown as EmailConnection[] | null) ?? [];
}

/** Every active connection (all tenants) that has IMAP configured — for polling. */
export async function listPollableImapConnections(): Promise<EmailConnection[]> {
    const { data } = await supabaseAdmin
        .from('email_connections')
        .select(FULL_COLUMNS)
        .eq('is_active', true)
        .not('imap_host', 'is', null);
    return (data as unknown as EmailConnection[] | null) ?? [];
}

/**
 * Best-effort persist of an SMTP connection-verify outcome (migration 130).
 * Records { last_verified_at, last_verify_ok, last_verify_error } on the box so an
 * SMTP-only sending identity has a freshness signal. Keyed by (tenant_id,
 * email_address) because verifySmtp runs BEFORE the row has an id — for a first-time
 * NEW box the row doesn't exist yet, so this UPDATE is a no-op on the failure path
 * (acceptable: there is no row to attach a signal to). On success the caller invokes
 * this AFTER the upsert, so the row is guaranteed present.
 *
 * NEVER throws: a persist fault must not break the verify response. Writes ONLY the
 * three verify columns — never warmup/deliverability/campaign fields (§2.3.1).
 */
export async function recordSmtpVerify(
    tenantId: string,
    emailAddress: string,
    ok: boolean,
    error: string | null,
    verifiedAt: string,
): Promise<void> {
    try {
        // Conditional freshness update: advance the signal ONLY when this attempt's verifiedAt is
        // newer-or-equal to the stored one (or the box was never verified). Two concurrent verifies
        // of the same box can resolve + persist out of order; without this guard the last writer
        // wins and an OLDER outcome could clobber a newer one. (Raw .or() timestamp is safe — an
        // ISO string has no comma, and PostgREST keeps everything after `lte.` as the value.)
        // Best-effort: any error is swallowed, never a reason to fail the verify.
        await supabaseAdmin
            .from('email_connections')
            .update({
                last_verified_at: verifiedAt,
                last_verify_ok: ok,
                last_verify_error: ok ? null : (error?.slice(0, 500) ?? null),
            })
            .eq('tenant_id', tenantId)
            .eq('email_address', emailAddress)
            .or(`last_verified_at.is.null,last_verified_at.lte.${verifiedAt}`);
    } catch (err) {
        log.warn({ err, tenantId, email: emailAddress }, 'recordSmtpVerify persist failed');
    }
}

export { PUBLIC_COLUMNS };
