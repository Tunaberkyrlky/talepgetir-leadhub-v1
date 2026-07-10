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

// ── Otomatik ramp-up (task-6) ────────────────────────────────────────────────
// Kutu-başı otomatik gönderim rampası: yeni bağlanan bir kutu 20/gün ile başlar,
// bağlantıdan (connected_at) itibaren geçen her 3 günde tavan +5 artar ve 50/gün
// normal tavanında durur. Bu bir ÜRÜN güvenlik limitidir (sağlayıcı limiti değil);
// amaç yeni bir kutunun itibarını erken yüksek hacimle yakmamaktır. Politika:
// 05-mailbox-onboarding-and-safety-policy.md ("Conservative initial sending
// profiles") ve 00-EYLEM-PLANI-SPAM-COZUMU.md §4.
export const RAMP_START_CAP = 20; // yeni kutunun ilk günlük otomatik tavanı
export const RAMP_STEP = 5;       // her adımdaki artış
export const RAMP_STEP_DAYS = 3;  // kaç günde bir artar
export const RAMP_MAX_CAP = 50;   // normal tavan

/**
 * Bağlantı yaşına göre kutu-başı otomatik günlük tavanı hesaplar (saf fonksiyon).
 * connected_at bilinmiyorsa (null/geçersiz) kutu "oturmuş" kabul edilir ve tam tavan
 * (RAMP_MAX_CAP) döner — bu sayede bu özellik ÖNCESİ bağlanmış eski kutular anında
 * 50/gün olur, sıfırdan rampa girmez.
 */
export function computeRampCap(
    connectedAt: string | Date | null | undefined,
    nowMs: number = Date.now(),
): number {
    if (!connectedAt) return RAMP_MAX_CAP;
    const connectedMs = connectedAt instanceof Date ? connectedAt.getTime() : Date.parse(connectedAt);
    if (!Number.isFinite(connectedMs)) return RAMP_MAX_CAP;
    const elapsedDays = Math.floor((nowMs - connectedMs) / 86_400_000);
    // Gelecek tarihli/negatif yaş (saat kayması) → 0 adım, en düşük tavan (savunmacı).
    const steps = Math.max(0, Math.floor(elapsedDays / RAMP_STEP_DAYS));
    return Math.min(RAMP_MAX_CAP, RAMP_START_CAP + RAMP_STEP * steps);
}

/**
 * Belirli bir gönderen adresi için güncel ramp tavanı (connected_at'i okur).
 * Aktif bağlantı bulunamazsa (yarış/silinme) RAMP_MAX_CAP döner: ramp fazladan bir
 * kısıt eklemez, gönderim zaten kendi bağlantı kapısında düşer.
 */
export async function getRampCapForAccount(tenantId: string, accountEmail: string): Promise<number> {
    const { data } = await supabaseAdmin
        .from('email_connections')
        .select('connected_at')
        .eq('tenant_id', tenantId)
        .eq('email_address', accountEmail)
        .eq('is_active', true)
        .maybeSingle();
    return computeRampCap((data as { connected_at?: string | null } | null)?.connected_at ?? null);
}

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

export { PUBLIC_COLUMNS };
