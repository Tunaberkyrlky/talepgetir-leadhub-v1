import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin, supabaseAuth } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('auth');

// Extend Express Request type
declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                email: string;
                tenantId: string;
                role: string;
            };
            tenantId?: string;
        }
    }
}

export async function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing or invalid authorization header' });
            return;
        }

        const token = authHeader.split(' ')[1];

        // Verify user via Supabase Auth
        const { data: { user }, error } = await supabaseAuth.auth.getUser(token);

        if (error || !user) {
            log.warn({ error: error?.message }, 'Token invalid or user not found');
            res.status(401).json({ error: 'Invalid or expired token' });
            return;
        }

        // Check superadmin from app_metadata (tenant-independent)
        const isPlatformSuperadmin = user.app_metadata?.is_superadmin === true;

        // Get memberships for tenant resolution
        const { data: allMemberships } = await supabaseAdmin
            .from('memberships')
            .select('tenant_id, role')
            .eq('user_id', user.id)
            .eq('is_active', true);

        // Resolve default tenant — prefer JWT claim, fall back to first active membership
        let defaultTenantId: string | undefined = user.app_metadata?.tenant_id;

        if (!defaultTenantId) {
            const firstMembership = allMemberships?.[0];
            if (!firstMembership && !isPlatformSuperadmin) {
                log.warn({ userId: user.id }, 'No tenant_id in app_metadata and no active memberships');
                res.status(403).json({ error: 'User has no tenant assigned' });
                return;
            }
            if (firstMembership) {
                defaultTenantId = firstMembership.tenant_id;
                log.info({ tenantId: defaultTenantId }, 'No app_metadata.tenant_id — resolved tenant from membership');
            }
        }

        const primaryMembership = allMemberships?.find(m => m.tenant_id === defaultTenantId);

        if (!isPlatformSuperadmin && !primaryMembership) {
            log.warn({ userId: user.id, tenantId: defaultTenantId }, 'No active membership for user in default tenant');
            res.status(403).json({ error: 'User has no active membership in this tenant' });
            return;
        }

        const primaryRole = isPlatformSuperadmin ? 'superadmin' : primaryMembership!.role;

        // Check if client is requesting a different tenant via X-Tenant-Id header
        const requestedTenantId = req.headers['x-tenant-id'] as string;
        const effectiveTenantId = requestedTenantId || defaultTenantId!;
        let effectiveRole = primaryRole;

        if (requestedTenantId && requestedTenantId !== defaultTenantId) {
            // Tenant switch requested — validate access
            if (primaryRole === 'superadmin') {
                // Superadmin can access any active tenant
                const { data: tenant } = await supabaseAdmin
                    .from('tenants')
                    .select('id')
                    .eq('id', requestedTenantId)
                    .eq('is_active', true)
                    .single();

                if (!tenant) {
                    res.status(403).json({ error: 'Tenant not found or inactive' });
                    return;
                }
                // Superadmin retains superadmin role across tenants
                effectiveRole = 'superadmin';
            } else if (primaryRole === 'ops_agent') {
                // Ops agent must have an active membership in the requested tenant
                const { data: targetMembership } = await supabaseAdmin
                    .from('memberships')
                    .select('role')
                    .eq('user_id', user.id)
                    .eq('tenant_id', requestedTenantId)
                    .eq('is_active', true)
                    .single();

                if (!targetMembership) {
                    res.status(403).json({ error: 'You do not have access to this tenant' });
                    return;
                }
                effectiveRole = targetMembership.role;
            } else {
                // Client roles cannot switch tenants
                res.status(403).json({ error: 'You do not have permission to switch tenants' });
                return;
            }
        }

        log.info({ email: user.email, role: effectiveRole, tenantId: effectiveTenantId }, 'Auth success');

        // Attach user info to request
        req.user = {
            id: user.id,
            email: user.email || '',
            tenantId: effectiveTenantId,
            role: effectiveRole,
        };
        req.tenantId = effectiveTenantId;

        next();
    } catch (err) {
        log.error({ err }, 'Auth middleware error');
        res.status(500).json({ error: 'Internal authentication error' });
    }
}

// Role check middleware factory
export function requireRole(...roles: string[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }
        if (!roles.includes(req.user.role)) {
            res.status(403).json({ error: 'Insufficient permissions' });
            return;
        }
        next();
    };
}

// Tier check middleware factory. Internal roles (superadmin, ops_agent) are always allowed.
const INTERNAL_ROLES = ['superadmin', 'ops_agent'];

export function requireTier(...tiers: string[]) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (!req.user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        // Internal roles bypass tier checks
        if (INTERNAL_ROLES.includes(req.user.role)) {
            next();
            return;
        }

        // Look up tenant tier
        const { data: tenant } = await supabaseAdmin
            .from('tenants')
            .select('tier')
            .eq('id', req.tenantId!)
            .single();

        const tenantTier = tenant?.tier || 'basic';

        if (!tiers.includes(tenantTier)) {
            res.status(403).json({ error: 'This feature requires a higher plan' });
            return;
        }

        next();
    };
}
