import { Router, Request, Response } from 'express';
import { supabaseAuth } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import { setAuthCookies, clearAuthCookies } from '../lib/cookies.js';
import { validateBody, loginSchema } from '../lib/validation.js';
import { resolveUserContext } from '../lib/authResolver.js';

const log = createLogger('route:auth');

const router = Router();

// POST /api/auth/login
router.post('/login', validateBody(loginSchema), async (req: Request, res: Response): Promise<void> => {
    try {
        const { email, password } = req.body;

        const { data, error } = await supabaseAuth.auth.signInWithPassword({
            email,
            password,
        });

        if (error) {
            res.status(401).json({ error: error.message });
            return;
        }

        const user = data.user;
        const ctx = await resolveUserContext(user.id, user.app_metadata);

        // Set httpOnly cookies for secure token storage
        setAuthCookies(res, data.session.access_token, data.session.refresh_token);

        res.json({
            user: {
                id: user.id,
                email: user.email,
                tenantId: ctx.tenantId,
                tenantName: ctx.tenantName,
                tenantTier: ctx.tenantTier,
                role: ctx.role,
                accessibleTenants: ctx.accessibleTenants,
            },
        });
    } catch (err) {
        log.error({ err }, 'Login error');
        res.status(500).json({ error: 'Login failed' });
    }
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
    try {
        // Read refresh token from cookie first, fall back to body
        const refreshToken = req.cookies?.refresh_token || req.body.refreshToken;

        if (!refreshToken) {
            res.status(400).json({ error: 'Refresh token is required' });
            return;
        }

        const { data, error } = await supabaseAuth.auth.refreshSession({
            refresh_token: refreshToken,
        });

        if (error || !data.session) {
            clearAuthCookies(res);
            res.status(401).json({ error: 'Invalid refresh token' });
            return;
        }

        setAuthCookies(res, data.session.access_token, data.session.refresh_token);

        res.json({ ok: true });
    } catch (err) {
        log.error({ err }, 'Token refresh error');
        res.status(500).json({ error: 'Token refresh failed' });
    }
});

// GET /api/auth/me
router.get('/me', async (req: Request, res: Response): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        const token = req.cookies?.access_token
            || (authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null);

        if (!token) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        const { data: { user }, error } = await supabaseAuth.auth.getUser(token);

        if (error || !user) {
            res.status(401).json({ error: 'Invalid token' });
            return;
        }

        const requestedTenantId = req.headers['x-tenant-id'] as string | undefined;
        const ctx = await resolveUserContext(user.id, user.app_metadata, requestedTenantId);

        res.json({
            user: {
                id: user.id,
                email: user.email,
                tenantId: ctx.tenantId,
                tenantName: ctx.tenantName,
                tenantTier: ctx.tenantTier,
                role: ctx.role,
                accessibleTenants: ctx.accessibleTenants,
            },
        });
    } catch (err) {
        log.error({ err }, 'Get user info error');
        res.status(500).json({ error: 'Failed to get user info' });
    }
});

// POST /api/auth/logout — clear auth cookies
router.post('/logout', (_req: Request, res: Response): void => {
    clearAuthCookies(res);
    res.json({ ok: true });
});

export default router;
