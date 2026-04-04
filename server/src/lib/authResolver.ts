import { supabaseAdmin } from './supabase.js';

interface Membership {
    tenant_id: string;
    role: string;
}

interface AccessibleTenant {
    id: string;
    name: string;
    slug: string;
    role: string;
    tier: string;
}

export interface ResolvedUserContext {
    tenantId: string | null;
    tenantName: string | null;
    tenantTier: string;
    role: string | null;
    accessibleTenants: AccessibleTenant[];
    tenantSettings: Record<string, any> | null;
}

/**
 * Resolves the user's tenant context, role, and accessible tenants.
 * Shared between login, /me, and auth middleware to eliminate duplication.
 */
export async function resolveUserContext(
    userId: string,
    appMetadata: Record<string, unknown> | undefined,
    requestedTenantId?: string | null
): Promise<ResolvedUserContext> {
    const isPlatformSuperadmin = appMetadata?.is_superadmin === true;

    // Get active memberships
    const { data: allMemberships } = await supabaseAdmin
        .from('memberships')
        .select('tenant_id, role')
        .eq('user_id', userId)
        .eq('is_active', true);

    // Resolve default tenant — prefer JWT claim, fall back to first active membership.
    // Validate the JWT-claimed tenant actually exists; if not, fall back gracefully
    // (handles stale seed/test tenant IDs that were deleted from the tenants table).
    const jwtTenantId = appMetadata?.tenant_id as string | undefined;
    let defaultTenantId: string | null = null;

    if (jwtTenantId) {
        const { data: jwtTenant } = await supabaseAdmin
            .from('tenants')
            .select('id')
            .eq('id', jwtTenantId)
            .eq('is_active', true)
            .single();
        defaultTenantId = jwtTenant?.id || allMemberships?.[0]?.tenant_id || null;
    } else {
        defaultTenantId = allMemberships?.[0]?.tenant_id || null;
    }

    // Base role
    const baseRole = isPlatformSuperadmin
        ? 'superadmin'
        : (allMemberships?.find((m: Membership) => m.tenant_id === defaultTenantId)?.role || null);

    // Resolve effective tenant (if switching via X-Tenant-Id)
    let effectiveTenantId = defaultTenantId;
    let effectiveRole = baseRole;

    if (requestedTenantId && requestedTenantId !== defaultTenantId) {
        effectiveTenantId = requestedTenantId;

        if (baseRole === 'superadmin') {
            effectiveRole = 'superadmin';
        } else if (baseRole === 'ops_agent') {
            const { data: targetMembership } = await supabaseAdmin
                .from('memberships')
                .select('role')
                .eq('user_id', userId)
                .eq('tenant_id', requestedTenantId)
                .eq('is_active', true)
                .single();
            effectiveRole = targetMembership?.role || null;
        } else {
            // Client roles cannot switch tenants — ignore the request
            effectiveTenantId = defaultTenantId;
        }
    }

    // Resolve tenant details
    let tenantName: string | null = null;
    let tenantTier = 'basic';
    let tenantSettings: Record<string, any> | null = null;
    if (effectiveTenantId) {
        const { data: tenant } = await supabaseAdmin
            .from('tenants')
            .select('name, tier, settings')
            .eq('id', effectiveTenantId)
            .eq('is_active', true)
            .single();
        tenantName = tenant?.name || null;
        tenantTier = tenant?.tier || 'basic';
        tenantSettings = tenant?.settings || null;
    }

    // Build accessible tenants list
    const accessibleTenants = await buildAccessibleTenants(baseRole, userId, allMemberships);

    return {
        tenantId: effectiveTenantId,
        tenantName,
        tenantTier,
        role: effectiveRole,
        accessibleTenants,
        tenantSettings,
    };
}

async function buildAccessibleTenants(
    role: string | null,
    userId: string,
    memberships: Membership[] | null
): Promise<AccessibleTenant[]> {
    if (role === 'superadmin') {
        const { data: allTenants } = await supabaseAdmin
            .from('tenants')
            .select('id, name, slug, tier')
            .eq('is_active', true)
            .order('name');
        return (allTenants || []).map((t) => ({ ...t, role: 'superadmin' }));
    }

    if (role === 'ops_agent' && memberships && memberships.length > 0) {
        const tenantIds = memberships.map((m) => m.tenant_id);
        const { data: tenantData } = await supabaseAdmin
            .from('tenants')
            .select('id, name, slug, tier')
            .in('id', tenantIds)
            .eq('is_active', true)
            .order('name');
        return (tenantData || []).map((t) => {
            const m = memberships.find((mb) => mb.tenant_id === t.id);
            return { ...t, role: m?.role || 'ops_agent' };
        });
    }

    // Client roles — single tenant
    if (memberships && memberships.length > 0) {
        const tenantId = memberships[0].tenant_id;
        const { data: tenantInfo } = await supabaseAdmin
            .from('tenants')
            .select('id, name, slug, tier')
            .eq('id', tenantId)
            .single();
        if (tenantInfo) {
            return [{ ...tenantInfo, role: role || 'client_viewer' }];
        }
    }

    return [];
}
