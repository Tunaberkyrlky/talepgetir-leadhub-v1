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
import { COUNTRY_PRICING, countryByCode, multiplierForRate, tierForMultiplier, primaryNumberOffer } from '../data/countryPricing.js';
import { getSettings } from '../lib/settings.js';
import { usageForNumbers } from '../lib/reputation.js';
import { providerFor } from '../providers/index.js';
import { signNumberOffer, verifyNumberOffer } from '../lib/numberOffers.js';

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
// Origin-aware fiyat: fiyat menşe (arayan numaranın ülkesi) × hedef + hat tipine göre
// değiştiğinden bu genel liste TEK bir multiplier gösteremez — müşteriye çarpan
// ARALIĞI (min=en iyi menşe/hat, max=en kötü) + max'a göre konservatif tier gösterilir.
router.get('/countries', (req: Request, res: Response) => {
    const internal = isInternalRole(req.user?.role ?? '');
    const rows = COUNTRY_PRICING.map((c) => {
        const primary = primaryNumberOffer(c.numbers);
        const mults = c.callable
            ? [
                multiplierForRate(c.euMobileUsd),
                multiplierForRate(c.euFixedUsd),
                multiplierForRate(c.intlMobileUsd),
                multiplierForRate(c.intlFixedUsd),
            ]
            : [0];
        const multiplierMin = Math.min(...mults);
        const multiplierMax = Math.max(...mults);
        return {
            code: c.code,
            name_tr: c.nameTr,
            name_en: c.nameEn,
            dial_code: c.dialCode,
            callable: c.callable,
            blocked_reason: c.blockedReason ?? null,
            tier: tierForMultiplier(multiplierMax),
            multiplier_min: multiplierMin,
            multiplier_max: multiplierMax,
            can_buy_number: !!primary,
            number_doc_status: primary?.docStatus ?? null,
            number_requires_docs: primary ? primary.docStatus !== 'docless' : null,
            ...(internal
                ? {
                    usd: { euMobile: c.euMobileUsd, euFixed: c.euFixedUsd, intlMobile: c.intlMobileUsd, intlFixed: c.intlFixedUsd },
                    number_monthly_usd: primary?.monthlyUsd ?? null,
                    number_types: Object.entries(c.numbers).map(([type, offer]) => ({
                        type, monthly_usd: offer.monthlyUsd, doc_status: offer.docStatus,
                    })),
                }
                : {}),
        };
    });
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
        const primary = primaryNumberOffer(info.numbers);
        if (!primary) {
            res.status(422).json({ error: 'Bu ülkede numara envanteri yok', code: 'no_inventory' });
            return;
        }
        const settings = await getSettings(req.tenantId!);
        // primary.type ile ara: seçilen tip (GB/SE'de mobil belgesiz) doğru envanterde bulunur,
        // satın alınan numara ve kaydedilen COGS ile eşleşir (codex P1).
        const provider = providerFor(settings);
        const results = await provider.searchNumbers(settings, country, contains, primary.type);
        res.json({
            numbers: results.map((number) => ({
                ...number,
                offer: signNumberOffer({
                    tenantId: req.tenantId!,
                    provider: provider.name,
                    e164: number.e164,
                    country,
                    numberType: primary.type,
                    monthlyCogsUsd: primary.monthlyUsd,
                    expiresAt: Date.now() + 5 * 60_000,
                }),
            })),
            number_type: primary.type,
            requires_docs: primary.docStatus !== 'docless',
        });
    } catch (err) {
        next(err);
    }
});

// ── POST / — numara satın al ─────────────────────────────────────────────────
const purchaseSchema = z.object({
    offer: z.string().min(40).max(4000),
});

router.post('/', requireBuyer, validateBody(purchaseSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        let signed;
        try {
            signed = verifyNumberOffer((req.body as z.infer<typeof purchaseSchema>).offer, tenantId);
        } catch {
            throw new AppError('Numara teklifi geçersiz veya süresi dolmuş', 422);
        }
        const { country, e164 } = signed;
        const info = countryByCode(country);
        const primary = info ? primaryNumberOffer(info.numbers) : null;
        if (!info || !primary) throw new AppError('Bu ülkede numara satın alınamıyor', 422);
        if (primary.type !== signed.numberType || primary.monthlyUsd !== signed.monthlyCogsUsd) {
            throw new AppError('Numara teklifi güncel fiyatla eşleşmiyor', 409);
        }
        // Numara istenen ülkeye ait olmalı (codex P2) — dial code prefix kontrolü
        if (!e164.startsWith(info.dialCode)) {
            throw new AppError('Numara seçilen ülkenin alan koduyla uyuşmuyor', 422);
        }

        const settings = await getSettings(tenantId);
        const provider = providerFor(settings);
        if (provider.name !== signed.provider) throw new AppError('Numara teklifi sağlayıcıyla eşleşmiyor', 409);
        const { data: reservation, error: reserveError } = await supabaseAdmin.rpc('coldcall_reserve_number', {
            p_tenant_id: tenantId, p_provider: provider.name, p_e164: e164, p_country: country,
            p_monthly: signed.monthlyCogsUsd, p_created_by: req.user?.id ?? null,
        });
        if (reserveError || !reservation) {
            if (reserveError?.message?.includes('coldcall_number_quota')) {
                throw new AppError(`Numara kotanız dolu (${settings.max_numbers})`, 429);
            }
            throw new AppError('Numara rezervasyonu oluşturulamadı', 409);
        }
        let purchased;
        try {
            purchased = await provider.purchaseNumber(settings, e164, country);
        } catch (purchaseError) {
            await supabaseAdmin.rpc('coldcall_release_number_reservation', {
                p_tenant_id: tenantId, p_number_id: reservation.id,
            });
            throw purchaseError;
        }
        const { data, error } = await supabaseAdmin.rpc('coldcall_complete_number', {
            p_tenant_id: tenantId, p_number_id: reservation.id, p_provider_sid: purchased.provider_sid,
            p_status: purchased.status, p_e164: purchased.e164,
        });
        if (error || !data) {
            log.error({ err: error, e164 }, 'number activation failed after purchase — releasing');
            try {
                await provider.releaseNumber(settings, purchased.provider_sid);
            } catch (relErr) {
                log.error({ err: relErr, providerSid: purchased.provider_sid }, 'compensating release failed — ORPHAN number may be billed');
            }
            await supabaseAdmin.rpc('coldcall_release_number_reservation', {
                p_tenant_id: tenantId, p_number_id: reservation.id,
            });
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
