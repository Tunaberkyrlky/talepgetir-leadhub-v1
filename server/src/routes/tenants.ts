import { Router, Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { getAccessibleTenants } from '../lib/accessibleTenants.js';

const log = createLogger('route:tenants');
const router = Router();

// GET /api/tenants — List tenants accessible by the current user
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const accessible = await getAccessibleTenants(req.user!, req.tenantId);
        const tenants = accessible.map(({ id, name, slug, role }) => ({ id, name, slug, role }));
        res.json({ tenants });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'List tenants error');
        res.status(500).json({ error: 'Failed to list tenants' });
    }
});

export default router;
