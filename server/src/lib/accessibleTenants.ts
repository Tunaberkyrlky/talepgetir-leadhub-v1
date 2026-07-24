import { supabaseAdmin } from './supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from './logger.js';

const log = createLogger('accessibleTenants');

export interface AccessibleTenant {
    id: string;
    name: string;
    slug: string;
    tier: string | null;
    role?: string;
}

/**
 * Resolve the set of tenants the caller may see, from role + memberships only.
 * Ops endpoints MUST scope every query to this set (service-role bypasses RLS)
 * and must never derive scope from req.tenantId / X-Tenant-Id.
 */
export async function getAccessibleTenants(
    user: { id: string; role: string },
    tenantId?: string
): Promise<AccessibleTenant[]> {
    if (user.role === 'superadmin') {
        const { data, error } = await supabaseAdmin
            .from('tenants')
            .select('id, name, slug, tier')
            .eq('is_active', true)
            .order('name');

        if (error) {
            log.error({ err: error }, 'List tenants error');
            throw new AppError('Failed to fetch tenants', 500);
        }

        return (data || []).map((t) => ({ ...t, role: 'superadmin' }));
    }

    if (user.role === 'ops_agent') {
        const { data: memberships, error: mError } = await supabaseAdmin
            .from('memberships')
            .select('tenant_id, role')
            .eq('user_id', user.id)
            .eq('is_active', true);

        if (mError) {
            log.error({ err: mError }, 'List memberships error');
            throw new AppError('Failed to fetch tenants', 500);
        }

        if (!memberships || memberships.length === 0) return [];

        const tenantIds = memberships.map((m) => m.tenant_id);
        const { data: tenantData, error: tError } = await supabaseAdmin
            .from('tenants')
            .select('id, name, slug, tier')
            .in('id', tenantIds)
            .eq('is_active', true)
            .order('name');

        if (tError) {
            log.error({ err: tError }, 'List tenants by membership error');
            throw new AppError('Failed to fetch tenants', 500);
        }

        return (tenantData || []).map((t) => {
            const membership = memberships.find((m) => m.tenant_id === t.id);
            return { ...t, role: membership?.role || 'ops_agent' };
        });
    }

    // Client roles: only their own tenant (from resolved auth context)
    if (!tenantId) return [];
    const { data: tenant, error } = await supabaseAdmin
        .from('tenants')
        .select('id, name, slug, tier')
        .eq('id', tenantId)
        .single();

    if (error) {
        log.error({ err: error }, 'Fetch own tenant error');
        throw new AppError('Failed to fetch tenants', 500);
    }

    return tenant ? [{ ...tenant, role: user.role }] : [];
}
