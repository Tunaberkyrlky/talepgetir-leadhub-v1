/**
 * TG-LinkedIn module router — mounted at /api/linkedin (auth applied upstream).
 * Isolated module boundary: the only touch-points to the rest of the server are
 * TWO mount lines in src/index.ts (this protected router + the public capture
 * router). The module never mutates CRM tables.
 */
import { Router } from 'express';
import accountsRouter from './accounts.js';

const router = Router();

router.use('/accounts', accountsRouter);

export default router;
