/**
 * Numara yönetimi: ülke tarifeleri, arama (envanter), satın alma, iade.
 * COGS kuralı: $ alanları (dakika maliyeti, numara kirası) YALNIZ internal
 * rollere döner; müşteri kategori + çarpan + kota görür.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { supabaseAdmin } from '../../lib/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { isInternalRole } from '../../lib/roles.js';
import { COUNTRY_PRICING, countryByCode, multiplierFor, tierFor } from '../data/countryPricing.js';
import { getSettings } from '../lib/settings.js';
import { usageForNumbers } from '../lib/reputation.js';
import { providerFor } from '../providers/index.js';

const log = createLogger('coldcall:numbers');
const router = Router();

const requireBuyer = requireRole('superadmin', 'ops_agent', 'client_admin');

/** Müşteri rollerine allowlist DTO: $ maliyet VE provider iç kimlikleri dönmez (codex P2). */
function shapeNumber(n: Record<string, unknown>, internal: boolean): Record<string, unknown> {
    const base = {
        id: n.id,
        e164: n.e164,
        country_code: n.country_code,
        friendly_name: n.friendly_name,
        capabilities: n.capabilities,
        status: n.status,
        purchased_at: n.purchased_at,
        released_at: n.released_at,
    };
    return internal
        ? { ...base, provider: n.provider, provider_sid: n.provider_sid, monthly_cost_usd: n.monthly_cost_usd, created_by: n.created_by }
        : base;
}

// ── GET /countries — ülke tarife/erişim tablosu ──────────────────────────────
router.get('/countries', (req: Request, res: Response) => {
    const internal = isInternalRole(req.user?.role ?? '');
    const rows = COUNTRY_PRICING.map((c) => ({
        code: c.code,
        name_tr: c.nameTr,
        name_en: c.nameEn,
        dial_code: c.dialCode,
        callable: c.callable,
        blocked_reason: c.blockedReason ?? null,
        tier: tierFor(c),
        multiplier: c.callable ? multiplierFor(c.outUsdPerMin) : 0,
        can_buy_number: !!c.numbers,
        number_requires_docs: c.numbers?.requiresDocs ?? null,
        ...(internal
            ? { out_usd_per_min: c.outUsdPerMin, number_monthly_usd: c.numbers?.monthlyUsd ?? null }
            : {}),
    }));
    res.json({ countries: rows });
});

// ── GET / — tenant'ın numaraları ─────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const internal = isInternalRole(req.user?.role ?? '');
        const { data, error } = await supabaseAdmin
            .from('coldcall_phone_numbers')
            .select('*')
            .eq('tenant_id', req.tenantId!)
            .neq('status', 'released')
            .order('purchased_at', { ascending: false });
        if (error) {
            log.error({ err: error }, 'numbers list failed');
            throw new AppError('Failed to list numbers', 500);
        }
        // İtibar/sağlık istatistikleri (COGS içermez — müşteriye görünür)
        const settings = await getSettings(req.tenantId!);
        const usage = await usageForNumbers(req.tenantId!, data ?? [], settings.daily_cap_per_number ?? 100);
        const numbers = (data ?? []).map((n) => ({
            ...shapeNumber(n, internal),
            ...(usage.get(n.id) ?? {}),
        }));
        res.json({ numbers });
    } catch (err) {
        next(err);
    }
});

// ── GET /search?country=US&contains=212 — satın alınabilir numaralar ─────────
router.get('/search', requireBuyer, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const country = String(req.query.country ?? '').toUpperCase();
        const contains = req.query.contains ? String(req.query.contains).replace(/\D/g, '').slice(0, 10) : undefined;
        const info = countryByCode(country);
        if (!info) throw new AppError('Unknown country', 400);
        if (!info.numbers) {
            res.status(422).json({ error: 'Bu ülkede numara envanteri yok', code: 'no_inventory' });
            return;
        }
        const settings = await getSettings(req.tenantId!);
        const results = await providerFor(settings).searchNumbers(settings, country, contains);
        res.json({
            numbers: results,
            requires_docs: info.numbers.requiresDocs,
        });
    } catch (err) {
        next(err);
    }
});

// ── POST / — numara satın al ─────────────────────────────────────────────────
const purchaseSchema = z.object({
    country: z.string().length(2),
    e164: z.string().regex(/^\+\d{7,15}$/, 'E.164 format required'),
});

router.post('/', requireBuyer, validateBody(purchaseSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { country, e164 } = req.body as z.infer<typeof purchaseSchema>;
        const info = countryByCode(country);
        if (!info?.numbers) throw new AppError('Bu ülkede numara satın alınamıyor', 422);
        // Numara istenen ülkeye ait olmalı (codex P2) — dial code prefix kontrolü
        if (!e164.startsWith(info.dialCode)) {
            throw new AppError('Numara seçilen ülkenin alan koduyla uyuşmuyor', 422);
        }

        const settings = await getSettings(tenantId);
        const { count, error: cntErr } = await supabaseAdmin
            .from('coldcall_phone_numbers')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .neq('status', 'released');
        if (cntErr) throw new AppError('Failed to check number quota', 500);
        if ((count ?? 0) >= settings.max_numbers) {
            throw new AppError(`Numara kotanız dolu (${settings.max_numbers})`, 429);
        }

        const provider = providerFor(settings);
        const purchased = await provider.purchaseNumber(settings, e164, country);

        const { data, error } = await supabaseAdmin
            .from('coldcall_phone_numbers')
            .insert({
                tenant_id: tenantId,
                provider: provider.name,
                provider_sid: purchased.provider_sid,
                e164: purchased.e164,
                country_code: country.toUpperCase(),
                friendly_name: purchased.e164,
                status: purchased.status,
                monthly_cost_usd: info.numbers.monthlyUsd,
                created_by: req.user?.id ?? null,
            })
            .select('*')
            .single();
        if (error) {
            // Compensation (codex P1): DB kaydı başarısızsa satın alınan numarayı
            // iade et — yoksa Twilio'da faturalanan ama uygulamada izlenmeyen
            // öksüz numara kalır. UNIQUE(tenant_id,e164) ihlali (mükerrer/yarış
            // satın alma) da buraya düşer; provider'da bırakmayız.
            log.error({ err: error, e164 }, 'number insert failed after purchase — releasing');
            try {
                await provider.releaseNumber(settings, purchased.provider_sid);
            } catch (relErr) {
                log.error({ err: relErr, providerSid: purchased.provider_sid }, 'compensating release failed — ORPHAN number may be billed');
            }
            throw new AppError('Numara kaydedilemedi', 500);
        }

        // İlk numara → default yap
        if (!settings.default_phone_number_id) {
            await supabaseAdmin
                .from('coldcall_settings')
                .update({ default_phone_number_id: data.id, updated_at: new Date().toISOString() })
                .eq('tenant_id', tenantId);
        }

        const internal = isInternalRole(req.user?.role ?? '');
        res.status(201).json(shapeNumber(data, internal));
    } catch (err) {
        next(err);
    }
});

// ── DELETE /:id — numara iade ────────────────────────────────────────────────
router.delete('/:id', requireBuyer, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const idCheck = uuidField().safeParse(req.params.id);
        if (!idCheck.success) throw new AppError('Invalid number ID', 400);
        const tenantId = req.tenantId!;

        const { data: num, error } = await supabaseAdmin
            .from('coldcall_phone_numbers')
            .select('*')
            .eq('id', idCheck.data)
            .eq('tenant_id', tenantId)
            .neq('status', 'released')
            .maybeSingle();
        if (error) throw new AppError('Failed to load number', 500);
        if (!num) {
            res.status(404).json({ error: 'Numara bulunamadı' });
            return;
        }

        const settings = await getSettings(tenantId);
        if (num.provider_sid) {
            await providerFor(settings).releaseNumber(settings, num.provider_sid);
        }
        await supabaseAdmin
            .from('coldcall_phone_numbers')
            .update({ status: 'released', released_at: new Date().toISOString() })
            .eq('id', num.id);
        if (settings.default_phone_number_id === num.id) {
            await supabaseAdmin
                .from('coldcall_settings')
                .update({ default_phone_number_id: null, updated_at: new Date().toISOString() })
                .eq('tenant_id', tenantId);
        }
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

export default router;
