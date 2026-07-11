/**
 * TG-Research module router — mounted at /api/research (auth applied upstream).
 * Isolated module boundary (K1): the only touch-point to the rest of the server
 * is the single mount line in src/index.ts.
 */
import { Router } from 'express';
import projectsRouter from './projects.js';
import jobsRouter from './jobs.js';
import icpsRouter from './icps.js';
import hsRouter from './hs.js';
import marketsRouter from './markets.js';
import geographiesRouter from './geographies.js';
import channelsRouter from './channels.js';
import offersRouter from './offers.js';
import harvestRouter from './harvest.js';
import adminRouter from './admin.js';
import tradeRouter from './trade.js';
import enrichmentRouter from './enrichment.js';
import orchestrateRouter from './orchestrate.js';

const router = Router();

router.use('/projects', projectsRouter);
router.use('/jobs', jobsRouter);
router.use('/icps', icpsRouter);
router.use('/hs', hsRouter);
router.use('/markets', marketsRouter);
router.use('/geographies', geographiesRouter);
router.use('/channels', channelsRouter);
router.use('/offers', offersRouter);
router.use('/harvest', harvestRouter);
router.use('/trade', tradeRouter);
router.use('/enrichment', enrichmentRouter);
router.use('/orchestrate', orchestrateRouter);
// Internal-only margin/COGS panel (superadmin, ops_agent — enforced inside the router).
router.use('/admin', adminRouter);

export default router;
