/**
 * Email connection lookup — shared across send (emailSender/smtpAdapter),
 * routes (email-connections) and IMAP polling.
 *
 * A tenant can have MULTIPLE connections (Workspace via Nango + SMTP, mixed).
 * One is flagged is_default for compose's "From" default.
 */

import { supabaseAdmin } from './supabase.js';
import { AppError } from '../middleware/errorHandler.js';

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
}

// Columns safe to send to send/poll paths (includes secrets — never return to client)
const FULL_COLUMNS =
    'id, tenant_id, provider, email_address, connection_id, is_active, is_default, ' +
    'smtp_host, smtp_port, smtp_secure, imap_host, imap_port, imap_secure, ' +
    'username, encrypted_password, allow_invalid_cert, last_polled_at, last_seen_uid, last_uid_validity';

// Columns safe to expose to the client (NO encrypted_password)
const PUBLIC_COLUMNS =
    'id, provider, email_address, is_active, is_default, connected_at, ' +
    'smtp_host, smtp_port, imap_host, imap_port, username, last_polled_at';

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

export { PUBLIC_COLUMNS };
