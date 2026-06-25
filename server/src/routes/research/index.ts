/**
 * TG-Research module router — mounted at /api/research (auth applied upstream).
 * Isolated module boundary (K1): the only touch-point to the rest of the server
 * is the single mount line in src/index.ts.
 */
import { Router } from 'express';
import projectsRouter from './projects.js';
import jobsRouter from './jobs.js';

const router = Router();

router.use('/projects', projectsRouter);
router.use('/jobs', jobsRouter);

export default router;
