/**
 * Cold Call modül router'ı — /api/coldcall (auth upstream'de uygulanır).
 * İzole modül sınırı: server'ın geri kalanına tek dokunuş src/index.ts'teki
 * mount satırlarıdır (bu router + webhooks). CRM tablolarına yalnız okuma
 * (companies/contacts adı) ve activities'e tek-yönlü yazma yapılır.
 */
import { Router } from 'express';
import numbersRouter from './numbers.js';
import callsRouter from './calls.js';
import adminRouter from './admin.js';
import creditsRouter from './credits.js';

const router = Router();

router.use('/numbers', numbersRouter);
router.use('/calls', callsRouter);
// Müşteri kredi geçmişi (tenant-scoped, $ YOK)
router.use('/credits', creditsRouter);
// Internal-only kullanım/COGS paneli (superadmin, ops_agent — router içinde enforce edilir)
router.use('/admin', adminRouter);

export default router;
