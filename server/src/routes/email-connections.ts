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
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('route:email-connections');
const router = Router();

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

// GET /api/email-connections/status
router.get('/status', async (req: Request, res: Response): Promise<void> => {
    try {
        const { data } = await supabaseAdmin
            .from('email_connections')
            .select('provider, email_address, is_active, connected_at')
            .eq('tenant_id', req.tenantId!)
            .single();

        if (!data) { res.json({ connected: false }); return; }

        res.json({
            connected: data.is_active,
            provider: data.provider,
            email: data.email_address,
            connected_at: data.connected_at,
        });
    } catch (err) {
        log.error({ err }, 'Connection status error');
        res.status(500).json({ error: 'Failed to check connection status' });
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
        const result = await nango.createConnectSession({
            end_user: { id: tenantId },
            allowed_integrations: [provider],
        });

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

        const { data, error } = await supabaseAdmin
            .from('email_connections')
            .upsert({
                tenant_id: tenantId,
                provider,
                email_address: emailAddress,
                connection_id: connectionId,
                is_active: true,
                connected_at: new Date().toISOString(),
            }, { onConflict: 'tenant_id' })
            .select()
            .single();

        if (error) {
            log.error({ err: error }, 'Save connection error');
            throw new AppError('Failed to save email connection', 500);
        }

        log.info({ tenantId, provider, email: emailAddress, connectionId }, 'Email connected');
        res.json({ connected: true, provider, email: emailAddress });
        void data;
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Connection callback error');
        res.status(500).json({ error: 'Failed to connect email' });
    }
});

// DELETE /api/email-connections
router.delete('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        const { data: active } = await supabaseAdmin
            .from('campaigns')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('status', 'active')
            .limit(1);

        if (active?.length) {
            res.status(422).json({ error: 'Cannot disconnect while campaigns are active. Pause all campaigns first.' });
            return;
        }

        await supabaseAdmin
            .from('email_connections')
            .update({ is_active: false })
            .eq('tenant_id', tenantId);

        log.info({ tenantId }, 'Email disconnected');
        res.json({ connected: false });
    } catch (err) {
        log.error({ err }, 'Disconnect error');
        res.status(500).json({ error: 'Failed to disconnect email' });
    }
});

export default router;
