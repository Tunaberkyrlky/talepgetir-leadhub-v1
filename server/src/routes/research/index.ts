/**
 * TG-Research module router — mounted at /api/research (auth applied upstream).
 * Isolated module boundary (K1): the only touch-point to the rest of the server
 * is the single mount line in src/index.ts.
 */
import { Router } from 'express';
import projectsRouter from './projects.js';
import jobsRouter from './jobs.js';
import icpsRouter from './icps.js';
import harvestRouter from './harvest.js';
import adminRouter from './admin.js';

const router = Router();

router.use('/projects', projectsRouter);
router.use('/jobs', jobsRouter);
router.use('/icps', icpsRouter);
router.use('/harvest', harvestRouter);
// Internal-only margin/COGS panel (superadmin, ops_agent — enforced inside the router).
router.use('/admin', adminRouter);

export default router;
