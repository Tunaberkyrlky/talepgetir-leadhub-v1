import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin, supabaseAuth } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import { isInternalRole } from '../lib/roles.js';

const log = createLogger('auth');

// ─── Auth cache (per token, 60s TTL) ───
interface CachedAuth {
    user: { id: string; email: string; tenantId: string; role: string };
    ts: number;
}
const authCache = new Map<string, CachedAuth>();
const AUTH_CACHE_TTL = 60_000; // 60 seconds
const MAX_AUTH_CACHE_SIZE = 1000;

// Clean stale entries lazily — started on first auth request.
// Storing the reference prevents duplicate intervals when the module is re-evaluated
// (e.g. on Vercel serverless cold starts in the same process lifetime).
let _cacheCleanupInterval: ReturnType<typeof setInterval> | null = null;

function ensureCacheCleanupRunning(): void {
    if (_cacheCleanupInterval) return;
    _cacheCleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, val] of authCache) {
            if (now - val.ts > AUTH_CACHE_TTL * 2) authCache.delete(key);
        }
    }, 120_000);
}

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
            /** Raw JWT access token — use with createUserClient() to enforce RLS */
            accessToken?: string;
        }
    }
}

export async function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    ensureCacheCleanupRunning();
    try {
        // Read token from httpOnly cookie first, fall back to Authorization header
        const authHeader = req.headers.authorization;
        const token = req.cookies?.access_token
            || (authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null);

        if (!token) {
            res.status(401).json({ error: 'Please sign in to continue' });
            return;
        }

        // Attach raw token so route handlers can create RLS-enforcing user clients
        req.accessToken = token;

        // Check tenant override header for cache key
        const requestedTenantId = req.headers['x-tenant-id'] as string | undefined;
        const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 32);
        const cacheKey = requestedTenantId ? `${tokenHash}:${requestedTenantId}` : tokenHash;

        // Check auth cache
        const cached = authCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < AUTH_CACHE_TTL) {
            req.user = cached.user;
            req.tenantId = cached.user.tenantId;
            next();
            return;
        }

        // Verify user via Supabase Auth
        const { data: { user }, error } = await supabaseAuth.auth.getUser(token);

        if (error || !user) {
            log.warn({ error: error?.message }, 'Token invalid or user not found');
            res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
            return;
        }

        // Check superadmin from app_metadata (tenant-independent)
        const isPlatformSuperadmin = user.app_metadata?.is_superadmin === true;

        // Get memberships for tenant resolution
        const { data: allMemberships, error: membershipErr } = await supabaseAdmin
            .from('memberships')
            .select('tenant_id, role')
            .eq('user_id', user.id)
            .eq('is_active', true);

        if (membershipErr) {
            log.error({ err: membershipErr, userId: user.id }, 'Failed to fetch memberships');
            res.status(500).json({ error: 'Internal server error' });
            return;
        }

        // Resolve default tenant — prefer JWT claim, fall back to first active membership.
        // Validate the JWT-claimed tenant exists; stale seed/deleted tenant IDs in
        // app_metadata would otherwise scope every request to a phantom tenant.
        const jwtTenantId: string | undefined = user.app_metadata?.tenant_id;
        let defaultTenantId: string | undefined;

        if (jwtTenantId) {
            const { data: jwtTenant } = await supabaseAdmin
                .from('tenants')
                .select('id')
                .eq('id', jwtTenantId)
                .eq('is_active', true)
                .single();
            if (jwtTenant) {
                defaultTenantId = jwtTenant.id;
            } else {
                log.warn({ userId: user.id, jwtTenantId }, 'app_metadata.tenant_id points to non-existent tenant — falling back to memberships');
                defaultTenantId = allMemberships?.[0]?.tenant_id;
            }
        } else {
            defaultTenantId = allMemberships?.[0]?.tenant_id;
        }

        if (!defaultTenantId) {
            if (!isPlatformSuperadmin) {
                log.warn({ userId: user.id }, 'No valid tenant resolved and no active memberships');
                res.status(403).json({ error: 'Your account is not set up yet. Please contact your administrator.' });
                return;
            }
            log.info({ userId: user.id }, 'Superadmin with no default tenant — will rely on X-Tenant-Id');
        }

        const primaryMembership = allMemberships?.find(m => m.tenant_id === defaultTenantId);

        if (!isPlatformSuperadmin && !primaryMembership) {
            log.warn({ userId: user.id, tenantId: defaultTenantId }, 'No active membership for user in default tenant');
            res.status(403).json({ error: 'You don\'t have access to this workspace. Please contact your administrator.' });
            return;
        }

        const primaryRole = isPlatformSuperadmin ? 'superadmin' : primaryMembership!.role;

        // Check if client is requesting a different tenant via X-Tenant-Id header
        let effectiveTenantId = requestedTenantId || defaultTenantId;
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
                    // Stale X-Tenant-Id (e.g. deleted seed tenant still in localStorage).
                    // For superadmin, ignore the override rather than 403 — the client
                    // will re-sync to a valid tenant on the next /auth/me call.
                    log.warn({ requestedTenantId }, 'Superadmin requested non-existent tenant — ignoring override');
                    effectiveTenantId = defaultTenantId; // revert to default (may be undefined)
                } else {
                    // Superadmin retains superadmin role across tenants
                    effectiveRole = 'superadmin';
                }
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
                    res.status(403).json({ error: 'You don\'t have access to this workspace' });
                    return;
                }
                effectiveRole = targetMembership.role;
            } else {
                // Client roles cannot switch tenants
                res.status(403).json({ error: 'You don\'t have permission to switch workspaces' });
                return;
            }
        }

        log.info({ email: user.email, role: effectiveRole, tenantId: effectiveTenantId }, 'Auth success');

        // Attach user info to request
        const authUser = {
            id: user.id,
            email: user.email || '',
            tenantId: effectiveTenantId || '',
            role: effectiveRole,
        };
        req.user = authUser;
        req.tenantId = effectiveTenantId || undefined;

        // Cache for subsequent requests
        if (authCache.size >= MAX_AUTH_CACHE_SIZE) {
            // Evict the oldest 20% of entries instead of clearing all
            // to avoid thundering-herd re-authentication on every 1001st user
            const evictCount = Math.floor(MAX_AUTH_CACHE_SIZE * 0.2);
            const sorted = [...authCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
            for (let i = 0; i < evictCount; i++) authCache.delete(sorted[i][0]);
        }
        authCache.set(cacheKey, { user: authUser, ts: Date.now() });

        next();
    } catch (err) {
        log.error({ err }, 'Auth middleware error');
        res.status(500).json({ error: 'Something went wrong. Please try signing in again.' });
    }
}

/**
 * Evict all cache entries for a given user ID.
 * Call this after deactivating or deleting a user so their next request
 * is forced through a fresh auth check instead of hitting a cached result.
 */
export function clearAuthCacheForUser(userId: string): void {
    for (const [key, val] of authCache) {
        if (val.user.id === userId) authCache.delete(key);
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

export function requireTier(...tiers: string[]) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (!req.user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        // Internal roles bypass tier checks
        if (isInternalRole(req.user.role)) {
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
