import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import { getTenantStages } from './settings.js';

const log = createLogger('route:filter-options');
const router = Router();

// GET /api/filter-options — Returns distinct values for filter dropdowns
router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        // Get stages from pipeline_stages config (fast, cached)
        const allStages = await getTenantStages(tenantId);
        const stages = allStages.map((s) => s.slug);

        // Get distinct industries, locations, products in parallel
        const [industryRes, locationRes, productRes] = await Promise.all([
            supabaseAdmin
                .from('companies')
                .select('industry')
                .eq('tenant_id', tenantId)
                .not('industry', 'is', null)
                .neq('industry', ''),
            supabaseAdmin
                .from('companies')
                .select('location')
                .eq('tenant_id', tenantId)
                .not('location', 'is', null)
                .neq('location', ''),
            supabaseAdmin
                .from('companies')
                .select('product_services')
                .eq('tenant_id', tenantId)
                .not('product_services', 'is', null)
                .neq('product_services', ''),
        ]);

        const industries = [...new Set((industryRes.data || []).map((r) => r.industry))].sort();
        const locations = [...new Set((locationRes.data || []).map((r) => r.location))].sort();
        const products = [...new Set((productRes.data || []).map((r) => r.product_services))].sort();

        res.json({ stages, industries, locations, products });
    } catch (err) {
        log.error({ err }, 'Filter options error');
        res.status(500).json({ error: 'Failed to fetch filter options' });
    }
});

export default router;
