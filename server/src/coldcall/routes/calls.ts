/**
 * Çağrı yaşam döngüsü: başlat, durum izle, kapat, sonuçlandır (disposition →
 * activities), kayıt + transkript + AI özet okuma.
 * COGS kuralı: cogs_usd yalnız internal rollere döner.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { supabaseAdmin } from '../../lib/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { isInternalRole } from '../../lib/roles.js';
import { countryForE164, rateFor, isBlockedRate } from '../data/countryPricing.js';
import { getSettings, assertBalance, usedThisPeriod } from '../lib/settings.js';
import { usageForNumbers } from '../lib/reputation.js';
import { sweepStaleCalls, TERMINAL_STATUSES, finalizeCall } from '../lib/finalize.js';
import { providerFor, twilioConfigured } from '../providers/index.js';
import { summarizeTranscript } from '../lib/summarize.js';
import type { ColdcallCallRow } from '../providers/types.js';

const log = createLogger('coldcall:calls');
const router = Router();

const requireCaller = requireRole('superadmin', 'ops_agent', 'client_admin');

const BUCKET = 'coldcall-recordings';
const SIGNED_URL_TTL_SEC = 300;
/** Düşük bakiye uyarı eşiği (dakika) — plan §11.1, ileride coldcall_settings kolonu olabilir. */
const LOW_BALANCE_THRESHOLD = 30;

function shapeCall(row: Record<string, unknown>, internal: boolean): Record<string, unknown> {
    if (internal) return row;
    // Müşteri rolleri: $ COGS ve provider iç kimliği dönmez (codex P2)
    const { cogs_usd, provider_call_sid, ...rest } = row;
    return rest;
}

// ── GET /config — dialer'ın ihtiyaç duyduğu her şey ──────────────────────────
router.get('/config', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const settings = await getSettings(tenantId);
        const provider = providerFor(settings);
        const { count } = await supabaseAdmin
            .from('coldcall_phone_numbers')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .eq('status', 'active');
        const balance = Number(settings.minutes_balance);
        res.json({
            provider: provider.name,
            call_mode: provider.callMode,
            recording_mode: settings.recording_mode,
            minutes_balance: balance,
            minutes_used_period: await usedThisPeriod(tenantId),
            low_balance: balance <= LOW_BALANCE_THRESHOLD,
            max_numbers: settings.max_numbers,
            daily_cap_per_number: settings.daily_cap_per_number ?? 100,
            active_numbers: count ?? 0,
            twilio_configured: twilioConfigured(),
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /token — Voice SDK access token (yalnız webrtc modunda) ──────────────
router.get('/token', requireCaller, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const settings = await getSettings(req.tenantId!);
        const provider = providerFor(settings);
        if (!provider.voiceToken) throw new AppError('Bu ortamda tarayıcı SDK modu kapalı (simülasyon aktif)', 409);
        const identity = `${req.tenantId}:${req.user!.id}`;
        const token = await provider.voiceToken(settings, identity);
        res.json({ token, identity, ttl: 3600 });
    } catch (err) {
        next(err);
    }
});

// ── POST / — çağrı başlat ────────────────────────────────────────────────────
const createSchema = z.object({
    to_e164: z.string().regex(/^\+\d{7,15}$/, 'E.164 format required'),
    phone_number_id: uuidField('Invalid number ID').optional(),
    company_id: uuidField('Invalid company ID').optional(),
    contact_id: uuidField('Invalid contact ID').optional(),
});

router.post('/', requireCaller, validateBody(createSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const body = req.body as z.infer<typeof createSchema>;

        // Erken hedef kontrolü — fail-closed: tarifesi tanımsız/engelli yön menşe
        // (arayan numaranın ülkesi) bilinmeden reddedilir; asıl oran/çarpan aşağıda
        // fromNumber seçildikten SONRA hesaplanır (origin-aware, plan §4).
        const destCheck = countryForE164(body.to_e164);
        if (!destCheck) throw new AppError('Bu yön için tarife tanımlı değil, arama yapılamaz', 422);
        if (!destCheck.callable) {
            const reasons: Record<string, string> = {
                sanctioned: 'yaptırım kapsamında',
                provider_unsupported: 'sağlayıcı tarafından desteklenmiyor',
                premium_rate_risk: 'yüksek ücret/IRSF riski nedeniyle engelli',
            };
            throw new AppError(`${destCheck.nameTr} aranamaz (${reasons[destCheck.blockedReason ?? ''] ?? 'engelli'})`, 422);
        }

        const settings = await getSettings(tenantId);
        assertBalance(settings);

        // Arayan numara: günlük tavan (warm-up dahil) enforce edilir; numara
        // belirtilmemişse rotasyon — default tavan altındaysa o, değilse bugün
        // en az kullanılan tavan-altı numara (itibar koruması, plan §9)
        const { data: activeNumbers, error: numErr } = await supabaseAdmin
            .from('coldcall_phone_numbers')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('status', 'active');
        if (numErr) throw new AppError('Failed to resolve caller number', 500);
        if (!activeNumbers?.length) throw new AppError('Arama yapmak için önce bir numara satın alın', 409);

        const usage = await usageForNumbers(tenantId, activeNumbers, settings.daily_cap_per_number ?? 100);
        let fromNumber;
        if (body.phone_number_id) {
            fromNumber = activeNumbers.find((n) => n.id === body.phone_number_id);
            if (!fromNumber) throw new AppError('Numara bulunamadı', 404);
            const u = usage.get(fromNumber.id);
            if (u && u.remaining_today <= 0) {
                throw new AppError(
                    `Bu numaranın günlük arama tavanı doldu (${u.daily_cap}/gün, itibar koruması). Başka bir numara kullanın veya yarını bekleyin`,
                    429
                );
            }
        } else {
            const underCap = activeNumbers.filter((n) => (usage.get(n.id)?.remaining_today ?? 1) > 0);
            if (!underCap.length) {
                throw new AppError('Tüm numaralarınız günlük arama tavanına ulaştı (itibar koruması)', 429);
            }
            fromNumber =
                underCap.find((n) => n.id === settings.default_phone_number_id) ??
                [...underCap].sort(
                    (a, b) => (usage.get(a.id)?.calls_today ?? 0) - (usage.get(b.id)?.calls_today ?? 0)
                )[0];
        }

        // Origin-aware oran: arayan (fromNumber) numaranın ülkesi × hedef + hat tipi (plan §4).
        // destCheck yukarıda callable dedi ama fail-closed: rateFor'un blocked dönmesi ihtimaline
        // karşı burada da guard var (ör. veri tutarsızlığı).
        const rate = rateFor(fromNumber.country_code, body.to_e164);
        if (isBlockedRate(rate)) {
            throw new AppError('Bu yön için tarife hesaplanamadı, arama yapılamaz', 422);
        }

        // company doğrulaması — başka tenant'ın şirketine bağlanamaz
        if (body.company_id) {
            const { data: company } = await supabaseAdmin
                .from('companies')
                .select('id')
                .eq('id', body.company_id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (!company) throw new AppError('Şirket bulunamadı', 404);
        }

        // contact doğrulaması (codex P1) — başka tenant'ın kişisi bağlanamaz;
        // şirket de verildiyse kişi o şirkete ait olmalı
        if (body.contact_id) {
            const { data: contact } = await supabaseAdmin
                .from('contacts')
                .select('id, company_id')
                .eq('id', body.contact_id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (!contact) throw new AppError('Kişi bulunamadı', 404);
            if (body.company_id && contact.company_id !== body.company_id) {
                throw new AppError('Kişi bu şirkete ait değil', 422);
            }
        }

        const { data: call, error } = await supabaseAdmin.rpc('coldcall_start_call', {
            p_tenant_id: tenantId,
            p_company_id: body.company_id ?? null,
            p_contact_id: body.contact_id ?? null,
            p_user_id: req.user?.id ?? null,
            p_phone_number_id: fromNumber.id,
            p_from_e164: fromNumber.e164,
            p_to_e164: body.to_e164,
            p_to_country: rate.destCountry.code,
            p_rate_multiplier: rate.multiplier,
            p_origin_country: fromNumber.country_code,
            p_destination_country: rate.destCountry.code,
            p_destination_type: rate.lineType,
            p_pstn_rate_usd: rate.usdPerMin,
            p_recording_enabled: settings.recording_mode !== 'off',
        });
        if (error) {
            // Tek in-flight çağrı — partial unique index ihlali: tenant'ın
            // zaten terminal-olmayan bir çağrısı var. Eşzamanlı POST'larda bakiye aşımını
            // ATOMİK olarak tek çağrıyla sınırlar (codex P1 — app-seviyesi TOCTOU'yu kapatır).
            if ((error as { code?: string }).code === '23505') {
                throw new AppError('Zaten devam eden bir aramanız var. O bitince yeni arama başlatabilirsiniz.', 409);
            }
            if (error.message?.includes('coldcall_balance_exhausted')) {
                throw new AppError('Arama krediniz tükendi. Yükleme için bizimle iletişime geçin.', 429);
            }
            log.error({ err: error }, 'call insert failed');
            throw new AppError('Çağrı başlatılamadı', 500);
        }

        const provider = providerFor(settings);
        try {
            await provider.placeCall(call as ColdcallCallRow, settings);
        } catch (placeErr) {
            // placeCall başarısızsa queued satır in-flight kilidini tutar → telafi: iptal et
            // (yoksa tenant sweep'e/60dk'ya kadar yeni arama açamaz — codex P2 regression fix).
            log.error({ err: placeErr, callId: call.id }, 'placeCall failed — canceling queued call');
            await finalizeCall(call as ColdcallCallRow, { status: 'canceled' });
            throw new AppError('Çağrı başlatılamadı', 502);
        }

        const internal = isInternalRole(req.user?.role ?? '');
        res.status(201).json({ call: shapeCall(call, internal), mode: provider.callMode });
    } catch (err) {
        next(err);
    }
});

// ── GET / — çağrı listesi ────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        await sweepStaleCalls(tenantId);

        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 100);
        const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

        let query = supabaseAdmin
            .from('coldcall_calls')
            .select('*, company:companies(id, name)', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (req.query.company_id) {
            const idCheck = uuidField().safeParse(String(req.query.company_id));
            if (!idCheck.success) throw new AppError('Invalid company ID', 400);
            query = query.eq('company_id', idCheck.data);
        }
        const { data, error, count } = await query;
        if (error) {
            log.error({ err: error }, 'calls list failed');
            throw new AppError('Failed to list calls', 500);
        }

        const ids = (data ?? []).map((c) => c.id);
        const [recRes, trRes] = await Promise.all([
            ids.length
                ? supabaseAdmin.from('coldcall_recordings').select('call_id, status').in('call_id', ids)
                : Promise.resolve({ data: [] as Array<{ call_id: string; status: string }> }),
            ids.length
                ? supabaseAdmin.from('coldcall_transcripts').select('call_id, status, summary, sentiment').in('call_id', ids)
                : Promise.resolve({ data: [] as Array<{ call_id: string; status: string; summary: string | null; sentiment: string | null }> }),
        ]);
        const recMap = new Map((recRes.data ?? []).map((r) => [r.call_id, r.status]));
        const trMap = new Map((trRes.data ?? []).map((t) => [t.call_id, t]));

        const internal = isInternalRole(req.user?.role ?? '');
        const calls = (data ?? []).map((c) => ({
            ...shapeCall(c, internal),
            recording_status: recMap.get(c.id) ?? null,
            transcript_status: trMap.get(c.id)?.status ?? null,
            summary: trMap.get(c.id)?.summary ?? null,
            sentiment: trMap.get(c.id)?.sentiment ?? null,
        }));
        res.json({ calls, total: count ?? 0, limit, offset });
    } catch (err) {
        next(err);
    }
});

async function loadTenantCall(callId: string, tenantId: string): Promise<ColdcallCallRow> {
    const idCheck = uuidField().safeParse(callId);
    if (!idCheck.success) throw new AppError('Invalid call ID', 400);
    const { data, error } = await supabaseAdmin
        .from('coldcall_calls')
        .select('*')
        .eq('id', idCheck.data)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (error) throw new AppError('Failed to load call', 500);
    if (!data) throw new AppError('Çağrı bulunamadı', 404);
    return data as ColdcallCallRow;
}

// ── GET /:id — detay (kayıt signed URL + transkript + AI özet) ───────────────
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        await sweepStaleCalls(tenantId);
        const call = await loadTenantCall(String(req.params.id), tenantId);

        const [recRes, trRes] = await Promise.all([
            supabaseAdmin.from('coldcall_recordings').select('*').eq('call_id', call.id).order('created_at', { ascending: false }).limit(1),
            supabaseAdmin.from('coldcall_transcripts').select('*').eq('call_id', call.id).maybeSingle(),
        ]);
        const recording = recRes.data?.[0] ?? null;

        let recordingUrl: string | null = null;
        if (recording?.status === 'stored' && recording.storage_path) {
            const { data: signed } = await supabaseAdmin.storage
                .from(BUCKET)
                .createSignedUrl(recording.storage_path, SIGNED_URL_TTL_SEC);
            recordingUrl = signed?.signedUrl ?? null;
        }

        const internal = isInternalRole(req.user?.role ?? '');
        res.json({
            call: shapeCall(call as unknown as Record<string, unknown>, internal),
            recording: recording
                ? { id: recording.id, status: recording.status, duration_sec: recording.duration_sec, url: recordingUrl }
                : null,
            transcript: trRes.data
                ? {
                    status: trRes.data.status,
                    language: trRes.data.language,
                    segments: trRes.data.segments,
                    summary: trRes.data.summary,
                    action_items: trRes.data.action_items,
                    sentiment: trRes.data.sentiment,
                    // provider (deepgram/mock/heuristic) iç detay — yalnız internal (codex P2)
                    ...(internal ? { provider: trRes.data.provider } : {}),
                }
                : null,
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/hangup ─────────────────────────────────────────────────────────
router.post('/:id/hangup', requireCaller, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const call = await loadTenantCall(String(req.params.id), tenantId);
        if ((TERMINAL_STATUSES as readonly string[]).includes(call.status)) {
            res.json({ ok: true, already_ended: true });
            return;
        }
        const settings = await getSettings(tenantId);
        await providerFor(settings).hangupCall(call, settings);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /:id/disposition — sonuç + not → activities entegrasyonu ──────────
const dispositionSchema = z.object({
    disposition: z.enum(['connected', 'interested', 'not_interested', 'callback', 'voicemail', 'no_answer', 'busy', 'wrong_number']),
    notes: z.string().max(4000).optional(),
});

const DISPOSITION_LABELS: Record<string, string> = {
    connected: 'Görüşüldü',
    interested: 'İlgilendi',
    not_interested: 'İlgilenmedi',
    callback: 'Tekrar aranacak',
    voicemail: 'Telesekreter',
    no_answer: 'Cevap yok',
    busy: 'Meşgul',
    wrong_number: 'Yanlış numara',
};

router.patch('/:id/disposition', requireCaller, validateBody(dispositionSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const call = await loadTenantCall(String(req.params.id), tenantId);
        const { disposition, notes } = req.body as z.infer<typeof dispositionSchema>;

        const { error: updErr } = await supabaseAdmin
            .from('coldcall_calls')
            .update({ disposition, notes: notes ?? null })
            .eq('id', call.id);
        if (updErr) throw new AppError('Sonuç kaydedilemedi', 500);

        // activities: yalnız şirkete bağlı çağrılar için (company_id NOT NULL şartı)
        let activityId = call.activity_id;
        if (call.company_id) {
            const { data: transcript } = await supabaseAdmin
                .from('coldcall_transcripts')
                .select('summary')
                .eq('call_id', call.id)
                .maybeSingle();
            const summary = `Cold call: ${DISPOSITION_LABELS[disposition] ?? disposition} (${call.to_e164})`;
            const detail = [notes, transcript?.summary ? `AI özeti: ${transcript.summary}` : null]
                .filter(Boolean)
                .join('\n\n') || null;

            if (activityId) {
                await supabaseAdmin
                    .from('activities')
                    .update({ outcome: disposition, summary, detail })
                    .eq('id', activityId)
                    .eq('tenant_id', tenantId);
            } else {
                const { data: activity, error: actErr } = await supabaseAdmin
                    .from('activities')
                    .insert({
                        tenant_id: tenantId,
                        company_id: call.company_id,
                        contact_id: call.contact_id,
                        type: 'call',
                        outcome: disposition,
                        summary,
                        detail,
                        visibility: 'internal',
                        occurred_at: call.started_at,
                        created_by: req.user?.id ?? null,
                    })
                    .select('id')
                    .single();
                if (actErr) {
                    log.error({ err: actErr, callId: call.id }, 'activity insert failed');
                } else {
                    activityId = activity.id;
                    await supabaseAdmin.from('coldcall_calls').update({ activity_id: activityId }).eq('id', call.id);
                }
            }
        }
        res.json({ ok: true, activity_id: activityId });
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/retry-summary — AI özetini yeniden üret ────────────────────────
router.post('/:id/retry-summary', requireCaller, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const call = await loadTenantCall(String(req.params.id), tenantId);
        const { data: transcript } = await supabaseAdmin
            .from('coldcall_transcripts')
            .select('segments, language')
            .eq('call_id', call.id)
            .maybeSingle();
        if (!transcript?.segments?.length) throw new AppError('Transkript yok — özet üretilemez', 422);

        const summary = await summarizeTranscript(transcript.segments, transcript.language ?? 'en');
        const { error } = await supabaseAdmin
            .from('coldcall_transcripts')
            .update({
                summary: summary.summary,
                action_items: summary.action_items,
                sentiment: summary.sentiment,
                status: 'done',
                updated_at: new Date().toISOString(),
            })
            .eq('call_id', call.id);
        if (error) throw new AppError('Özet kaydedilemedi', 500);
        res.json({ ok: true, summary: summary.summary, action_items: summary.action_items, sentiment: summary.sentiment });
    } catch (err) {
        next(err);
    }
});

export default router;
