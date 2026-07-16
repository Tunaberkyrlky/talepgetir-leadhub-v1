/**
 * Cold Call admin paneli (yalnız internal roller): tenant bazında kullanım,
 * COGS $ ve Twilio provisioning. Müşteri rollerinin bu router'a erişimi yok.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { supabaseAdmin } from '../../lib/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { getSettings, grantMinutes } from '../lib/settings.js';
import { provisionTenantForTwilio } from '../providers/twilio.js';
import { twilioConfigured } from '../providers/index.js';

const log = createLogger('coldcall:admin');
const router = Router();

router.use(requireRole('superadmin', 'ops_agent'));

// ── GET /usage — tenant bazında dakika + COGS ────────────────────────────────
router.get('/usage', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const [callsRes, settingsRes, numbersRes, tenantsRes] = await Promise.all([
            supabaseAdmin
                .from('coldcall_calls')
                .select('tenant_id, status, duration_sec, billed_minutes, cogs_usd'),
            supabaseAdmin.from('coldcall_settings').select('tenant_id, provider, minutes_balance'),
            supabaseAdmin.from('coldcall_phone_numbers').select('tenant_id, monthly_cost_usd').neq('status', 'released'),
            supabaseAdmin.from('tenants').select('id, name'),
        ]);
        for (const r of [callsRes, settingsRes, numbersRes, tenantsRes]) {
            if (r.error) {
                log.error({ err: r.error }, 'usage aggregate query failed');
                throw new AppError('Failed to aggregate usage', 500);
            }
        }
        const tenantName = new Map((tenantsRes.data ?? []).map((t) => [t.id, t.name]));

        interface Agg {
            tenant_id: string;
            tenant_name: string;
            calls_total: number;
            calls_completed: number;
            talk_minutes: number;
            billed_minutes: number;
            call_cogs_usd: number;
            numbers_count: number;
            numbers_monthly_usd: number;
            minutes_balance?: number;
            provider?: string;
        }
        const byTenant = new Map<string, Agg>();
        const agg = (tid: string): Agg => {
            let a = byTenant.get(tid);
            if (!a) {
                a = {
                    tenant_id: tid,
                    tenant_name: tenantName.get(tid) ?? tid,
                    calls_total: 0,
                    calls_completed: 0,
                    talk_minutes: 0,
                    billed_minutes: 0,
                    call_cogs_usd: 0,
                    numbers_count: 0,
                    numbers_monthly_usd: 0,
                };
                byTenant.set(tid, a);
            }
            return a;
        };

        for (const c of callsRes.data ?? []) {
            const a = agg(c.tenant_id);
            a.calls_total += 1;
            if (c.status === 'completed') a.calls_completed += 1;
            a.talk_minutes += (c.duration_sec ?? 0) / 60;
            a.billed_minutes += Number(c.billed_minutes ?? 0);
            a.call_cogs_usd += Number(c.cogs_usd ?? 0);
        }
        for (const n of numbersRes.data ?? []) {
            const a = agg(n.tenant_id);
            a.numbers_count += 1;
            a.numbers_monthly_usd += Number(n.monthly_cost_usd ?? 0);
        }
        for (const s of settingsRes.data ?? []) {
            const a = agg(s.tenant_id);
            a.minutes_balance = Number(s.minutes_balance);
            a.provider = s.provider;
        }

        const rows = [...byTenant.values()]
            .map((a) => ({
                ...a,
                talk_minutes: Math.round(a.talk_minutes * 10) / 10,
                call_cogs_usd: Math.round(a.call_cogs_usd * 100) / 100,
                numbers_monthly_usd: Math.round(a.numbers_monthly_usd * 100) / 100,
                total_cogs_usd: Math.round((a.call_cogs_usd + a.numbers_monthly_usd) * 100) / 100,
            }))
            .sort((x, y) => y.total_cogs_usd - x.total_cogs_usd);
        res.json({ usage: rows, twilio_configured: twilioConfigured() });
    } catch (err) {
        next(err);
    }
});

// ── POST /provision — tenant'ı Twilio'ya taşı ────────────────────────────────
const provisionSchema = z.object({ tenant_id: uuidField('Invalid tenant ID') });

router.post('/provision', validateBody(provisionSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!twilioConfigured()) throw new AppError('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN tanımlı değil', 503);
        const { tenant_id } = req.body as z.infer<typeof provisionSchema>;
        const settings = await getSettings(tenant_id);
        await provisionTenantForTwilio(tenant_id, settings);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// ── POST /credits/grant — dakika kredisi yükle/düzelt (yalnız superadmin) ───
// minutes>0 → kind='grant' (yükleme); minutes<0 → kind='adjustment' (aşağı düzeltme).
// idempotency_key client'ta üretilir (crypto.randomUUID) — çift-tık/retry koruması,
// coldcall_grant_minutes RPC'sinde partial unique index ile enforce edilir (migration 146).
const grantSchema = z.object({
    tenant_id: uuidField('Invalid tenant ID'),
    minutes: z.number()
        .refine((m) => m !== 0, { message: 'minutes sıfır olamaz' })
        .refine((m) => Math.abs(m) <= 100000, { message: 'minutes çok büyük (|m| <= 100000)' }),
    reason: z.string().trim().min(1, 'reason zorunlu').max(500),
    idempotency_key: uuidField('Invalid idempotency_key'),
});

router.post(
    '/credits/grant',
    requireRole('superadmin'), // yükleme yalnız superadmin (ops_agent salt-görüntüleme, plan §11.2)
    validateBody(grantSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { tenant_id, minutes, reason, idempotency_key } = req.body as z.infer<typeof grantSchema>;
            // Hedef tenant daha önce Cold Call'u hiç açmamış olabilir (coldcall_settings satırı
            // yok) — grantMinutes RPC'si satır yoksa RAISE EXCEPTION atar. getSettings() idempotent
            // upsert ile satırı garantiler (admin'in tenant açmadan önceden kredi yüklemesi mümkün olsun).
            await getSettings(tenant_id);
            const kind = minutes > 0 ? 'grant' : 'adjustment';
            const newBalance = await grantMinutes({
                tenantId: tenant_id,
                minutes,
                kind,
                reason,
                createdBy: req.user?.id ?? null,
                source: 'manual',
                idempotencyKey: idempotency_key,
            });
            res.json({ ok: true, minutes_balance: newBalance });
        } catch (err) {
            next(err);
        }
    }
);

// ── GET /credits/:tenantId/ledger — tenant'ın TAM kredi geçmişi (created_by/source dahil) ──
const adminLedgerQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    before: z.string().datetime().optional(),
});

router.get('/credits/:tenantId/ledger', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const idCheck = uuidField().safeParse(req.params.tenantId);
        if (!idCheck.success) throw new AppError('Invalid tenant ID', 400);
        const q = adminLedgerQuerySchema.safeParse(req.query);
        if (!q.success) throw new AppError('Invalid query', 400);

        let query = supabaseAdmin
            .from('coldcall_credit_ledger')
            .select('id, delta_minutes, kind, balance_after, reason, call_id, created_by, source, idempotency_key, created_at')
            .eq('tenant_id', idCheck.data)
            .order('created_at', { ascending: false })
            .limit(q.data.limit);
        if (q.data.before) query = query.lt('created_at', q.data.before);

        const { data, error } = await query;
        if (error) {
            log.error({ err: error, tenantId: idCheck.data }, 'admin ledger fetch failed');
            throw new AppError('Failed to load ledger', 500);
        }
        res.json({ ledger: data ?? [] });
    } catch (err) {
        next(err);
    }
});

export default router;
