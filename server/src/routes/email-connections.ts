/**
 * Email Connections — Nango OAuth bağlantı yönetimi
 *
 * Akış (Mart 2025'ten itibaren Nango session token pattern'i):
 *   1. Frontend POST /start-session → backend, Nango'dan short-lived session token üretir
 *   2. Frontend, token'la new Nango({ connectSessionToken }).auth(provider) çağırır → popup
 *   3. Popup tamamlanınca SDK auto-generated connectionId döner
 *   4. Frontend POST /callback { provider, connectionId } → backend Nango'dan bilgileri çeker,
 *      kullanıcının mail adresini çıkarır, email_connections tablosuna yazar
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { validateBody, smtpConnectionSchema, uuidField } from '../lib/validation.js';
import { listConnections, PUBLIC_COLUMNS } from '../lib/emailConnections.js';
import { verifySmtp } from '../lib/mail/smtpAdapter.js';
import { describeMailVerifyError } from '../lib/mail/verifyErrors.js';
import { verifyImap } from '../lib/imapInbound.js';
import { encrypt } from '../lib/encryption.js';
import { assertPublicHost } from '../lib/ssrfGuard.js';
import { domainFromEmail, isManagedConsumerDomain, getDomainHealth, getManagedDomainResult } from '../lib/domainHealth.js';

const log = createLogger('route:email-connections');
const router = Router();

const idParamSchema = z.object({ id: uuidField('Invalid connection ID') });

/** If the tenant has no default connection yet, mark this id as default. */
async function ensureDefault(tenantId: string, id: string): Promise<void> {
    const { data: existingDefault } = await supabaseAdmin
        .from('email_connections')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('is_default', true)
        .maybeSingle();
    if (!existingDefault) {
        await supabaseAdmin.from('email_connections').update({ is_default: true }).eq('id', id);
    }
}

// Microsoft's well-known tenant id for personal Microsoft Accounts (MSA) — Skype,
// Xbox, and consumer outlook.com/hotmail.com/live.com logins all land here even when
// the account's sign-in alias is a custom work email.
const MSA_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

// Consumer-only Microsoft mail domains. A personal (MSA) account resolving to one of
// these is a legitimate personal mailbox and must stay allowed.
const CONSUMER_MICROSOFT_DOMAINS = new Set([
    'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com',
    'outlook.com.tr', 'outlook.co.uk', 'outlook.de', 'outlook.fr', 'outlook.es', 'outlook.it',
    'outlook.jp', 'outlook.com.br', 'outlook.com.ar', 'outlook.co.id', 'outlook.com.au',
    'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it', 'hotmail.es', 'hotmail.com.tr',
    'hotmail.co.jp', 'hotmail.ca', 'hotmail.com.br', 'hotmail.com.ar', 'hotmail.be', 'hotmail.nl',
    'live.co.uk', 'live.de', 'live.fr', 'live.com.mx', 'live.com.ar', 'live.it', 'live.nl',
]);

function isConsumerMicrosoftDomain(email: string): boolean {
    const domain = email.split('@')[1]?.toLowerCase().trim();
    return !!domain && CONSUMER_MICROSOFT_DOMAINS.has(domain);
}

/** Best-effort decode of a JWT's `tid` claim. Not signature-verified — used only to
 *  distinguish account type, never for authorization. Microsoft Graph access tokens
 *  are usually (but not guaranteed to be) parseable JWTs. */
function decodeJwtTenantId(token: string): string | null {
    try {
        const parts = token.split('.');
        if (parts.length < 2) return null;
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { tid?: string };
        return payload.tid || null;
    } catch {
        return null;
    }
}

/**
 * Determine whether a Microsoft Graph access token belongs to a personal Microsoft
 * Account (MSA) rather than a work/school (Entra ID / M365) account.
 *
 * Primary signal: the JWT `tid` claim — MSA tokens carry the fixed MSA_TENANT_ID.
 * Fallback (when the token isn't a parseable JWT): a work/school account can list
 * its organization via Graph with just User.Read; an MSA cannot, so a non-200
 * response or an empty `value` array is treated as MSA (fail closed toward
 * flagging as personal, since that's the safer default for the spam-risk check
 * this feeds into).
 */
async function isPersonalMicrosoftAccount(
    accessToken: string,
): Promise<{ isMsa: boolean; via: 'tid' | 'org-check'; detail: string }> {
    const tid = decodeJwtTenantId(accessToken);
    if (tid) {
        return { isMsa: tid === MSA_TENANT_ID, via: 'tid', detail: tid };
    }
    try {
        const orgRes = await fetch('https://graph.microsoft.com/v1.0/organization', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!orgRes.ok) {
            return { isMsa: true, via: 'org-check', detail: `status=${orgRes.status}` };
        }
        const body = await orgRes.json() as { value?: unknown[] };
        const isMsa = !Array.isArray(body.value) || body.value.length === 0;
        return { isMsa, via: 'org-check', detail: `orgCount=${body.value?.length ?? 0}` };
    } catch (orgErr) {
        log.warn({ err: orgErr }, 'Microsoft organization check failed; treating as MSA (fail closed)');
        return { isMsa: true, via: 'org-check', detail: 'fetch-failed' };
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _nango: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getNango(): Promise<any> {
    if (_nango) return _nango;
    if (!process.env.NANGO_SECRET_KEY) {
        throw new AppError('NANGO_SECRET_KEY not configured', 500);
    }
    const { Nango } = await import('@nangohq/node');
    _nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY });
    return _nango;
}

router.use(requireRole('superadmin', 'ops_agent', 'client_admin'));

// GET /api/email-connections/status — all connections + back-compat single shape
router.get('/status', async (req: Request, res: Response): Promise<void> => {
    try {
        const { data } = await supabaseAdmin
            .from('email_connections')
            .select(PUBLIC_COLUMNS)
            .eq('tenant_id', req.tenantId!)
            .eq('is_active', true)
            .order('is_default', { ascending: false })
            .order('connected_at', { ascending: true });

        const connections = (data as unknown as Array<{
            id: string; provider: string; email_address: string; is_default: boolean;
            smtp_host: string | null; imap_host: string | null; last_polled_at: string | null;
            connected_at: string;
        }> | null) ?? [];

        const primary = connections.find((c) => c.is_default) ?? connections[0];

        res.json({
            // back-compat single-connection shape (older UI)
            connected: !!primary,
            provider: primary?.provider,
            email: primary?.email_address,
            // new multi-account shape
            connections,
        });
    } catch (err) {
        log.error({ err }, 'Connection status error');
        res.status(500).json({ error: 'Failed to check connection status' });
    }
});

// POST /api/email-connections/smtp — connect a tenant's own SMTP/IMAP mailbox
router.post('/smtp', validateBody(smtpConnectionSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const b = req.body as z.infer<typeof smtpConnectionSchema>;

        // SSRF guard: only let tenants point us at public mail hosts, never at
        // internal/loopback/link-local addresses (would be an internal port scanner).
        try {
            await assertPublicHost(b.smtp_host);
            if (b.imap_host) await assertPublicHost(b.imap_host);
        } catch (hostErr) {
            log.warn({ err: hostErr, host: b.smtp_host, imapHost: b.imap_host }, 'SMTP host rejected by SSRF guard');
            res.status(400).json({ error: 'Geçersiz sunucu adresi. Yalnızca genel erişime açık posta sunucularına bağlanılabilir.' });
            return;
        }

        // Verify SMTP credentials BEFORE saving — catch typos/wrong password early.
        // Return a generic message: the raw connection error leaks whether arbitrary
        // host:port pairs are reachable (information oracle). Detail stays in the log.
        try {
            await verifySmtp({
                host: b.smtp_host, port: b.smtp_port, secure: b.smtp_secure,
                username: b.username, password: b.password,
                allowInvalidCert: b.allow_invalid_cert,
            });
        } catch (verifyErr) {
            log.warn({ err: verifyErr, host: b.smtp_host }, 'SMTP verify failed');
            res.status(422).json({ error: describeMailVerifyError(verifyErr, 'smtp') });
            return;
        }

        // When IMAP is configured (reply reading), verify it too — for Gmail
        // app-password connections this is the whole point, and SMTP succeeding
        // doesn't prove IMAP access is enabled.
        if (b.imap_host) {
            try {
                await verifyImap({
                    host: b.imap_host,
                    port: b.imap_port || 993,
                    secure: b.imap_secure ?? true,
                    username: b.username,
                    password: b.password,
                    allowInvalidCert: b.allow_invalid_cert,
                });
            } catch (verifyErr) {
                log.warn({ err: verifyErr, host: b.imap_host }, 'IMAP verify failed');
                res.status(422).json({ error: describeMailVerifyError(verifyErr, 'imap') });
                return;
            }
        }

        const { data, error } = await supabaseAdmin
            .from('email_connections')
            .upsert({
                tenant_id: tenantId,
                provider: 'smtp',
                email_address: b.email_address,
                connection_id: null,
                is_active: true,
                connected_at: new Date().toISOString(),
                smtp_host: b.smtp_host,
                smtp_port: b.smtp_port,
                smtp_secure: b.smtp_secure,
                imap_host: b.imap_host || null,
                imap_port: b.imap_port || null,
                imap_secure: b.imap_secure,
                username: b.username,
                encrypted_password: encrypt(b.password),
                allow_invalid_cert: b.allow_invalid_cert,
            }, { onConflict: 'tenant_id,email_address' })
            .select('id')
            .single();

        if (error || !data) {
            log.error({ err: error }, 'Save SMTP connection error');
            throw new AppError('Failed to save SMTP connection', 500);
        }

        if (b.is_default) {
            await supabaseAdmin.from('email_connections').update({ is_default: false }).eq('tenant_id', tenantId);
            await supabaseAdmin.from('email_connections').update({ is_default: true }).eq('id', data.id);
        } else {
            await ensureDefault(tenantId, data.id);
        }

        log.info({ tenantId, email: b.email_address, host: b.smtp_host }, 'SMTP connection saved');
        res.json({ connected: true, email: b.email_address });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'SMTP connect error');
        res.status(500).json({ error: 'Failed to connect SMTP' });
    }
});

// PATCH /api/email-connections/:id/default — set the default sending mailbox
router.patch('/:id/default', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) { res.status(400).json({ error: 'Invalid connection ID' }); return; }
        const tenantId = req.tenantId!;
        const { id } = parsed.data;

        const { data: conn } = await supabaseAdmin
            .from('email_connections')
            .select('id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

        await supabaseAdmin.from('email_connections').update({ is_default: false }).eq('tenant_id', tenantId);
        await supabaseAdmin.from('email_connections').update({ is_default: true }).eq('id', id);
        res.json({ ok: true });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Set default error');
        res.status(500).json({ error: 'Failed to set default' });
    }
});

// POST /api/email-connections/start-session — Nango Connect session token üret
router.post('/start-session', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { provider } = req.body as { provider?: string };

        if (!provider || !['google-mail', 'microsoft-outlook'].includes(provider)) {
            res.status(400).json({ error: 'Invalid provider. Use google-mail or microsoft-outlook.' });
            return;
        }

        const nango = await getNango();
        // The Nango "microsoft" provider (Graph) authorizes against
        // login.microsoftonline.com/${connectionConfig.tenant}. Pin the tenant to
        // `common` so BOTH work/school (M365) and personal accounts can connect.
        // Without this the flow falls through to the consumer-only endpoint
        // (login.live.com) and business/M365 logins fail with unauthorized_client.
        // (Google-mail needs no such config.)
        const sessionParams: Record<string, unknown> = {
            end_user: { id: tenantId },
            allowed_integrations: [provider],
        };
        if (provider === 'microsoft-outlook') {
            sessionParams.integrations_config_defaults = {
                'microsoft-outlook': { connection_config: { tenant: 'common' } },
            };
        }
        const result = await nango.createConnectSession(sessionParams);

        const token = result?.data?.token;
        if (!token) {
            throw new AppError('Nango did not return a session token', 502);
        }

        res.json({ token });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Start session error');
        res.status(500).json({ error: 'Failed to start OAuth session' });
    }
});

// POST /api/email-connections/callback — Nango popup sonrası connectionId ile çağrılır
router.post('/callback', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { provider, connectionId } = req.body as { provider?: string; connectionId?: string };

        if (!provider || !['google-mail', 'microsoft-outlook'].includes(provider)) {
            res.status(400).json({ error: 'Invalid provider. Use google-mail or microsoft-outlook.' });
            return;
        }
        if (!connectionId || typeof connectionId !== 'string' || connectionId.length > 200) {
            res.status(400).json({ error: 'Missing or invalid connectionId' });
            return;
        }

        const nango = await getNango();
        let connection;
        try {
            connection = await nango.getConnection(provider, connectionId);
        } catch {
            res.status(422).json({ error: 'OAuth connection not found. Please try again.' });
            return;
        }

        // Resolve email address from provider
        let emailAddress = '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const accessToken = (connection.credentials as any)?.access_token;

        if (!accessToken) {
            res.status(422).json({ error: 'OAuth connection missing access token' });
            return;
        }

        if (provider === 'google-mail') {
            // OpenID userinfo endpoint — works with `userinfo.email` scope.
            // Gmail's /users/me/profile would require `gmail.readonly`, which is broader than we need.
            const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (profileRes.ok) {
                const profile = await profileRes.json() as { email?: string };
                emailAddress = profile.email || '';
            } else {
                const errBody = await profileRes.text();
                log.warn({ status: profileRes.status, body: errBody.slice(0, 200) }, 'Google userinfo fetch failed');
            }
        } else {
            const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (profileRes.ok) {
                const profile = await profileRes.json() as { mail: string; userPrincipalName: string };
                emailAddress = profile.mail || profile.userPrincipalName;
            }
        }

        if (!emailAddress) {
            res.status(422).json({ error: 'Could not retrieve email address from provider.' });
            return;
        }

        // Guard against personal Microsoft accounts (MSA) whose sign-in alias is a
        // custom work domain. Their real transport mailbox is an auto-generated
        // outlook_...@outlook.com address, so mail sent through them goes out via
        // consumer outlook.com infra with Sender != From — no SPF/DKIM alignment
        // with the custom domain, and recipients see "on behalf of" / land in spam.
        // A genuine personal mailbox on a consumer Microsoft domain is unaffected
        // and stays allowed.
        if (provider === 'microsoft-outlook') {
            const { isMsa, via, detail } = await isPersonalMicrosoftAccount(accessToken);
            const isConsumerDomain = isConsumerMicrosoftDomain(emailAddress);
            if (isMsa && !isConsumerDomain) {
                log.warn(
                    { tenantId, email: emailAddress, via, detail },
                    'Rejected Microsoft connection: personal (MSA) account on a custom domain',
                );
                res.status(422).json({
                    error: `${emailAddress} kişisel bir Microsoft hesabı olarak bağlandı. Kurumsal adresler kişisel hesapla bağlanırsa mailler 'outlook.com üzerinden / on behalf of' görünür ve spam klasörüne düşer. Lütfen tekrar bağlanın ve Microsoft giriş ekranında 'İş veya okul hesabı' seçeneğini seçin.`,
                });
                return;
            }
            log.info({ tenantId, email: emailAddress, isMsa, via, detail }, 'Microsoft account type check passed');
        }

        const { data, error } = await supabaseAdmin
            .from('email_connections')
            .upsert({
                tenant_id: tenantId,
                provider,
                email_address: emailAddress,
                connection_id: connectionId,
                is_active: true,
                connected_at: new Date().toISOString(),
            }, { onConflict: 'tenant_id,email_address' })
            .select('id')
            .single();

        if (error || !data) {
            log.error({ err: error }, 'Save connection error');
            throw new AppError('Failed to save email connection', 500);
        }

        await ensureDefault(tenantId, data.id);

        log.info({ tenantId, provider, email: emailAddress, connectionId }, 'Email connected');
        res.json({ connected: true, provider, email: emailAddress });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Connection callback error');
        res.status(500).json({ error: 'Failed to connect email' });
    }
});

// GET /api/email-connections/:id/domain-health — MX/SPF/DKIM/DMARC diagnostics
router.get('/:id/domain-health', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) { res.status(400).json({ error: 'Invalid connection ID' }); return; }
        const tenantId = req.tenantId!;
        const { id } = parsed.data;

        const { data: conn } = await supabaseAdmin
            .from('email_connections')
            .select('id, email_address')
            .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

        const domain = domainFromEmail((conn as { email_address: string }).email_address);
        if (!domain) { res.status(422).json({ error: 'Connection has no valid email domain' }); return; }

        if (isManagedConsumerDomain(domain)) {
            res.json(getManagedDomainResult(domain));
            return;
        }

        const refresh = req.query.refresh === 'true';
        const result = await getDomainHealth(domain, { refresh });
        res.json(result);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Domain health check error');
        res.status(500).json({ error: 'Failed to check domain health' });
    }
});

// DELETE /api/email-connections/:id — disconnect one mailbox
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) { res.status(400).json({ error: 'Invalid connection ID' }); return; }
        const tenantId = req.tenantId!;
        const { id } = parsed.data;

        const { data: conn } = await supabaseAdmin
            .from('email_connections')
            .select('id, is_default')
            .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

        // Block disconnecting if any active campaign depends on a connection existing.
        const { data: active } = await supabaseAdmin
            .from('campaigns')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('status', 'active')
            .limit(1);
        const { count: remaining } = await supabaseAdmin
            .from('email_connections')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .eq('is_active', true)
            .neq('id', id);
        if (active?.length && (remaining ?? 0) === 0) {
            res.status(422).json({ error: 'Cannot disconnect the last mailbox while campaigns are active. Pause campaigns first.' });
            return;
        }

        await supabaseAdmin.from('email_connections').update({ is_active: false, is_default: false }).eq('id', id);

        // Promote another mailbox to default if we just removed the default.
        if (conn.is_default) {
            const { data: next } = await supabaseAdmin
                .from('email_connections')
                .select('id').eq('tenant_id', tenantId).eq('is_active', true)
                .order('connected_at', { ascending: true }).limit(1).maybeSingle();
            if (next) await supabaseAdmin.from('email_connections').update({ is_default: true }).eq('id', next.id);
        }

        log.info({ tenantId, id }, 'Email disconnected');
        res.json({ ok: true });
    } catch (err) {
        log.error({ err }, 'Disconnect error');
        res.status(500).json({ error: 'Failed to disconnect email' });
    }
});

export default router;
