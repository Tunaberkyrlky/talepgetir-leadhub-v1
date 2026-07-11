import { Router, Request, Response, NextFunction } from 'express';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { uuidField } from '../../lib/validation.js';

const log = createLogger('route:research:markets');
const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { project_id, country } = req.query;

        if (!project_id || typeof project_id !== 'string') {
            res.status(400).json({ error: 'project_id is required' });
            return;
        }
        if (!uuidField().safeParse(project_id).success) {
            res.status(400).json({ error: 'Invalid project_id' });
            return;
        }

        let query = researchSupabaseAdmin
            .from('research_markets')
            .select('id, hs_code_id, hs_code, country, import_value, growth_pct, rank, source, kind, reporter_country, created_at, updated_at')
            .eq('tenant_id', tenantId)
            .eq('project_id', project_id)
            .order('rank', { ascending: true, nullsFirst: false })
            .order('created_at', { ascending: false });

        if (typeof country === 'string' && country.length > 0) {
            query = query.ilike('country', country);
        }

        const { data, error } = await query;
        if (error) {
            log.error({ err: error }, 'list market evidence failed');
            throw new AppError('Failed to fetch market evidence', 500);
        }
        res.json({ data: data || [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'list market evidence error');
        next(new AppError('Failed to fetch market evidence', 500));
    }
});

export default router;
