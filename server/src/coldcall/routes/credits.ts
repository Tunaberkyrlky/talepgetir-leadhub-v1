/**
 * Cold Call — müşteri kredi geçmişi (tenant-scoped, $ YOK).
 * Admin'in tam ledger'ından (created_by/source dahil, routes/admin.ts) farklı:
 * yalnız dakika/kalan bakiye/tarih döner. Plan COLD_CALL_CREDIT_PLAN.md §4.4.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { supabaseAdmin } from '../../lib/supabase.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('coldcall:credits');
const router = Router();

const ledgerQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    before: z.string().datetime().optional(),
});

// ── GET /ledger — kendi tenant'ının kredi hareketleri ────────────────────────
// $ YOK (tablo zaten $ tutmuyor), created_by/source/idempotency_key YOK (admin
// kimliği/iç detay sızmasın — codex P2 desenine paralel).
router.get('/ledger', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const q = ledgerQuerySchema.safeParse(req.query);
        if (!q.success) throw new AppError('Invalid query', 400);

        let query = supabaseAdmin
            .from('coldcall_credit_ledger')
            .select('id, delta_minutes, kind, balance_after, reason, created_at')
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false })
            .limit(q.data.limit);
        if (q.data.before) query = query.lt('created_at', q.data.before);

        const { data, error } = await query;
        if (error) {
            log.error({ err: error, tenantId }, 'credits ledger fetch failed');
            throw new AppError('Failed to load credit history', 500);
        }
        res.json({ ledger: data ?? [] });
    } catch (err) {
        next(err);
    }
});

export default router;
