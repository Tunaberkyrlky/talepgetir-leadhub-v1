import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('route:tenants');
const router = Router();

interface TenantInfo {
    id: string;
    name: string;
    slug: string;
    role?: string;
}

// GET /api/tenants — List tenants accessible by the current user
router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const userRole = req.user!.role;

        let tenants: TenantInfo[] = [];

        if (userRole === 'superadmin') {
            // Superadmin sees ALL active tenants
            const { data, error } = await supabaseAdmin
                .from('tenants')
                .select('id, name, slug')
                .eq('is_active', true)
                .order('name');

            if (error) throw error;

            tenants = (data || []).map((t) => ({
                ...t,
                role: 'superadmin',
            }));
        } else if (userRole === 'ops_agent') {
            // Ops agent sees only tenants they have active memberships in
            const { data: memberships, error: mError } = await supabaseAdmin
                .from('memberships')
                .select('tenant_id, role')
                .eq('user_id', userId)
                .eq('is_active', true);

            if (mError) throw mError;

            if (memberships && memberships.length > 0) {
                const tenantIds = memberships.map((m) => m.tenant_id);
                const { data: tenantData, error: tError } = await supabaseAdmin
                    .from('tenants')
                    .select('id, name, slug')
                    .in('id', tenantIds)
                    .eq('is_active', true)
                    .order('name');

                if (tError) throw tError;

                tenants = (tenantData || []).map((t) => {
                    const membership = memberships.find((m) => m.tenant_id === t.id);
                    return { ...t, role: membership?.role || 'ops_agent' };
                });
            }
        } else {
            // Client roles: only their own tenant
            const tenantId = req.tenantId!;
            const { data: tenant, error } = await supabaseAdmin
                .from('tenants')
                .select('id, name, slug')
                .eq('id', tenantId)
                .single();

            if (error) throw error;
            if (tenant) {
                tenants = [{ ...tenant, role: userRole }];
            }
        }

        res.json({ tenants });
    } catch (err) {
        log.error({ err }, 'List tenants error');
        res.status(500).json({ error: 'Failed to list tenants' });
    }
});

export default router;
