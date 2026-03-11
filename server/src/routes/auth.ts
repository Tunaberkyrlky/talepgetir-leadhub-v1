import { Router, Request, Response } from 'express';
import { supabaseAdmin, supabaseAuth } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('route:auth');

const router = Router();

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            res.status(400).json({ error: 'Email and password are required' });
            return;
        }

        const { data, error } = await supabaseAuth.auth.signInWithPassword({
            email,
            password,
        });

        if (error) {
            res.status(401).json({ error: error.message });
            return;
        }

        const user = data.user;

        // Get ALL memberships to find if user is superadmin ANYWHERE
        const { data: allMemberships } = await supabaseAdmin
            .from('memberships')
            .select('tenant_id, role')
            .eq('user_id', user.id)
            .eq('is_active', true);

        // Check if any of these memberships is superadmin
        const isPlatformSuperadmin = allMemberships?.some(m => m.role === 'superadmin');

        // Resolve tenantId — prefer JWT claim, fall back to first active membership
        const tenantId: string | null = user.app_metadata?.tenant_id
            || allMemberships?.[0]?.tenant_id
            || null;

        // Final role for this session
        const role = isPlatformSuperadmin ? 'superadmin' : (allMemberships?.find(m => m.tenant_id === tenantId)?.role || null);

        let tenantName = null;
        let tenantTier = 'basic';
        if (tenantId) {
            const { data: tenant } = await supabaseAdmin
                .from('tenants')
                .select('name, tier')
                .eq('id', tenantId)
                .single();
            tenantName = tenant?.name;
            tenantTier = tenant?.tier || 'basic';
        }

        // Build accessible tenants list
        let accessibleTenants: { id: string; name: string; slug: string; role: string; tier: string }[] = [];

        if (role === 'superadmin') {
            const { data: allTenants, error: tenantErr } = await supabaseAdmin
                .from('tenants')
                .select('id, name, slug, tier')
                .eq('is_active', true)
                .order('name');
            log.debug({ tenantCount: allTenants?.length, error: tenantErr?.message }, 'Superadmin tenant query');
            accessibleTenants = (allTenants || []).map((t) => ({ ...t, role: 'superadmin' }));
        } else if (role === 'ops_agent') {
            const { data: memberships } = await supabaseAdmin
                .from('memberships')
                .select('tenant_id, role')
                .eq('user_id', user.id)
                .eq('is_active', true);
            if (memberships && memberships.length > 0) {
                const tenantIds = memberships.map((m) => m.tenant_id);
                const { data: tenantData } = await supabaseAdmin
                    .from('tenants')
                    .select('id, name, slug, tier')
                    .in('id', tenantIds)
                    .eq('is_active', true)
                    .order('name');
                accessibleTenants = (tenantData || []).map((t) => {
                    const m = memberships.find((mb) => mb.tenant_id === t.id);
                    return { ...t, role: m?.role || 'ops_agent' };
                });
            }
        } else if (tenantId && tenantName) {
            const { data: tenantInfo } = await supabaseAdmin
                .from('tenants')
                .select('id, name, slug, tier')
                .eq('id', tenantId)
                .single();
            if (tenantInfo) {
                accessibleTenants = [{ ...tenantInfo, role: role || 'client_viewer' }];
            }
        }

        res.json({
            token: data.session.access_token,
            refreshToken: data.session.refresh_token,
            user: {
                id: user.id,
                email: user.email,
                tenantId,
                tenantName,
                tenantTier,
                role,
                accessibleTenants,
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
        const { refreshToken } = req.body;

        if (!refreshToken) {
            res.status(400).json({ error: 'Refresh token is required' });
            return;
        }

        const { data, error } = await supabaseAuth.auth.refreshSession({
            refresh_token: refreshToken,
        });

        if (error || !data.session) {
            res.status(401).json({ error: 'Invalid refresh token' });
            return;
        }

        res.json({
            token: data.session.access_token,
            refreshToken: data.session.refresh_token,
        });
    } catch (err) {
        log.error({ err }, 'Token refresh error');
        res.status(500).json({ error: 'Token refresh failed' });
    }
});

// GET /api/auth/me — requires auth middleware to be applied before this route
router.get('/me', async (req: Request, res: Response): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        const token = authHeader.split(' ')[1];
        const { data: { user }, error } = await supabaseAuth.auth.getUser(token);

        if (error || !user) {
            res.status(401).json({ error: 'Invalid token' });
            return;
        }

        // Get ALL memberships to find if user is superadmin ANYWHERE
        const { data: allMemberships } = await supabaseAdmin
            .from('memberships')
            .select('tenant_id, role')
            .eq('user_id', user.id)
            .eq('is_active', true);

        // Check if any of these memberships is superadmin
        const isPlatformSuperadmin = allMemberships?.some(m => m.role === 'superadmin');

        // Resolve tenantId — prefer JWT claim, fall back to first active membership
        const defaultTenantId: string | null = user.app_metadata?.tenant_id
            || allMemberships?.[0]?.tenant_id
            || null;

        // Base role from memberships
        const role = isPlatformSuperadmin ? 'superadmin' : (allMemberships?.find(m => m.tenant_id === defaultTenantId)?.role || null);
        let tenantName = null;
        let tenantTier = 'basic';

        if (defaultTenantId) {
            const { data: tenant } = await supabaseAdmin
                .from('tenants')
                .select('name, slug, tier')
                .eq('id', defaultTenantId)
                .single();
            tenantName = tenant?.name;
            tenantTier = tenant?.tier || 'basic';
        }

        // Handle X-Tenant-Id for effective tenant resolution
        const requestedTenantId = req.headers['x-tenant-id'] as string;
        const effectiveTenantId = requestedTenantId || defaultTenantId;
        let effectiveTenantName = tenantName;
        let effectiveTenantTier = tenantTier;
        let effectiveRole = role;

        if (requestedTenantId && requestedTenantId !== defaultTenantId) {
            const { data: reqTenant } = await supabaseAdmin
                .from('tenants')
                .select('name, tier')
                .eq('id', requestedTenantId)
                .eq('is_active', true)
                .single();
            effectiveTenantName = reqTenant?.name || null;
            effectiveTenantTier = reqTenant?.tier || 'basic';

            if (role === 'superadmin') {
                effectiveRole = 'superadmin';
            } else if (role === 'ops_agent') {
                const { data: targetMembership } = await supabaseAdmin
                    .from('memberships')
                    .select('role')
                    .eq('user_id', user.id)
                    .eq('tenant_id', requestedTenantId)
                    .eq('is_active', true)
                    .single();
                effectiveRole = targetMembership?.role || null;
            }
        }

        // Build accessible tenants
        let accessibleTenants: { id: string; name: string; slug: string; role: string; tier: string }[] = [];

        if (role === 'superadmin') {
            const { data: allTenants } = await supabaseAdmin
                .from('tenants')
                .select('id, name, slug, tier')
                .eq('is_active', true)
                .order('name');
            accessibleTenants = (allTenants || []).map((t) => ({ ...t, role: 'superadmin' }));
        } else if (role === 'ops_agent') {
            const { data: memberships } = await supabaseAdmin
                .from('memberships')
                .select('tenant_id, role')
                .eq('user_id', user.id)
                .eq('is_active', true);
            if (memberships && memberships.length > 0) {
                const tenantIds = memberships.map((m) => m.tenant_id);
                const { data: tenantData } = await supabaseAdmin
                    .from('tenants')
                    .select('id, name, slug, tier')
                    .in('id', tenantIds)
                    .eq('is_active', true)
                    .order('name');
                accessibleTenants = (tenantData || []).map((t) => {
                    const m = memberships.find((mb) => mb.tenant_id === t.id);
                    return { ...t, role: m?.role || 'ops_agent' };
                });
            }
        } else if (effectiveTenantId) {
            const { data: tenantInfo } = await supabaseAdmin
                .from('tenants')
                .select('id, name, slug, tier')
                .eq('id', effectiveTenantId)
                .single();
            if (tenantInfo) {
                accessibleTenants = [{ ...tenantInfo, role: effectiveRole || 'client_viewer' }];
            }
        }

        res.json({
            user: {
                id: user.id,
                email: user.email,
                tenantId: effectiveTenantId,
                tenantName: effectiveTenantName,
                tenantTier: effectiveTenantTier,
                role: effectiveRole,
                accessibleTenants,
            },
        });
    } catch (err) {
        log.error({ err }, 'Get user info error');
        res.status(500).json({ error: 'Failed to get user info' });
    }
});

export default router;
