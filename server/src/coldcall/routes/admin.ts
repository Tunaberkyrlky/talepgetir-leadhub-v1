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
import { getSettings } from '../lib/settings.js';
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
            supabaseAdmin.from('coldcall_settings').select('tenant_id, provider, minutes_quota, minutes_used, period_start'),
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
            minutes_quota?: number;
            minutes_used?: number;
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
            a.minutes_quota = s.minutes_quota;
            a.minutes_used = Number(s.minutes_used);
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

export default router;
