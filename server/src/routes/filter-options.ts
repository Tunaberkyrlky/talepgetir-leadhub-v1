import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('route:filter-options');
const router = Router();

// GET /api/filter-options — Returns distinct values for filter dropdowns
router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        // Get distinct stages (from actual data)
        const { data: stageRows } = await supabaseAdmin
            .from('companies')
            .select('stage')
            .eq('tenant_id', tenantId)
            .not('stage', 'is', null);

        const stages = [...new Set((stageRows || []).map((r) => r.stage))].sort();

        // Get distinct industries
        const { data: industryRows } = await supabaseAdmin
            .from('companies')
            .select('industry')
            .eq('tenant_id', tenantId)
            .not('industry', 'is', null)
            .neq('industry', '');

        const industries = [...new Set((industryRows || []).map((r) => r.industry))].sort();

        // Get distinct locations
        const { data: locationRows } = await supabaseAdmin
            .from('companies')
            .select('location')
            .eq('tenant_id', tenantId)
            .not('location', 'is', null)
            .neq('location', '');

        const locations = [...new Set((locationRows || []).map((r) => r.location))].sort();

        // Get distinct product_services
        const { data: productRows } = await supabaseAdmin
            .from('companies')
            .select('product_services')
            .eq('tenant_id', tenantId)
            .not('product_services', 'is', null)
            .neq('product_services', '');

        const products = [...new Set((productRows || []).map((r) => r.product_services))].sort();

        res.json({ stages, industries, locations, products });
    } catch (err) {
        log.error({ err }, 'Filter options error');
        res.status(500).json({ error: 'Failed to fetch filter options' });
    }
});

export default router;
