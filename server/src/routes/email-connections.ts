/**
 * Email Connections — Nango OAuth bağlantı yönetimi
 */

import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('route:email-connections');
const router = Router();

let _nango: any = null;
async function getNango(): Promise<any> {
    if (_nango) return _nango;
    const { Nango } = await import('@nangohq/node');
    _nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY || '' });
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

// POST /api/email-connections/callback — after Nango frontend OAuth popup
router.post('/callback', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { provider } = req.body;

        if (!['google-mail', 'microsoft-outlook'].includes(provider)) {
            res.status(400).json({ error: 'Invalid provider. Use google-mail or microsoft-outlook.' });
            return;
        }

        const connectionId = tenantId;
        let connection;
        try {
            const nango = await getNango();
            connection = await nango.getConnection(provider, connectionId);
        } catch {
            res.status(422).json({ error: 'OAuth connection not found. Please try again.' });
            return;
        }

        // Resolve email address from provider
        let emailAddress = '';
        const accessToken = (connection.credentials as any).access_token;

        if (provider === 'google-mail') {
            const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (profileRes.ok) {
                const profile = await profileRes.json() as { emailAddress: string };
                emailAddress = profile.emailAddress;
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

        log.info({ tenantId, provider, email: emailAddress }, 'Email connected');
        res.json({ connected: true, provider, email: emailAddress });
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
