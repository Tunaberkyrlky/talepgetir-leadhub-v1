/**
 * Twilio webhook'ları (public, imza doğrulamalı) — /api/webhooks/coldcall/*
 * Auth middleware'inden ÖNCE mount edilir; her istek X-Twilio-Signature ile
 * doğrulanır (imza, numaranın sahibi SUBACCOUNT'ın auth token'ı ile atılır).
 * Twilio form-encoded POST'lar — router kendi urlencoded parser'ını taşır.
 */
import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import twilio from 'twilio';
import { timingSafeEqual } from 'crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { decrypt } from '../../lib/encryption.js';
import { createLogger } from '../../lib/logger.js';
import { subaccountAuthToken, masterAuth, decryptWebhookSecret } from '../providers/twilio.js';
import { finalizeCall } from '../lib/finalize.js';
import { runTwilioRecordingPipeline } from '../lib/pipeline.js';
import type { ColdcallCallRow, ColdcallSettingsRow } from '../providers/types.js';

const log = createLogger('coldcall:webhooks');
const router = Router();

router.use(express.urlencoded({ extended: false }));

interface VerifiedRequest extends Request {
    coldcallSettings?: ColdcallSettingsRow;
}

function constantTimeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

/**
 * Webhook doğrulama — fail-closed (403). İki model:
 *   • Master AUTH TOKEN varsa → Twilio X-Twilio-Signature imzası (en güçlü).
 *   • Master yalnız API KEY ise → subaccount auth token okunamaz, bu yüzden
 *     URL'deki per-tenant `s` secret'ı sabit-zamanlı karşılaştırılır.
 * Her iki yolda da tenant ayarı yüklenip req'e iliştirilir.
 */
async function verifyTwilioSignature(req: VerifiedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
        const publicUrl = process.env.COLDCALL_PUBLIC_URL;
        if (!publicUrl) {
            res.status(403).json({ error: 'Forbidden' });
            return;
        }
        const secret = typeof req.query.s === 'string' ? req.query.s : null;
        const accountSid = typeof req.body?.AccountSid === 'string' ? req.body.AccountSid : null;

        // Tenant'ı SUBACCOUNT SID ile çöz (Twilio her webhook body'sinde AccountSid
        // gönderir). Secret artık şifreli saklandığı için düz-metinle sorgulanamaz.
        if (!accountSid) {
            res.status(403).json({ error: 'Forbidden' });
            return;
        }
        const { data } = await supabaseAdmin
            .from('coldcall_settings')
            .select('*')
            .eq('subaccount_sid', accountSid)
            .maybeSingle();
        const settings = (data as ColdcallSettingsRow) ?? null;
        if (!settings) {
            res.status(403).json({ error: 'Forbidden' });
            return;
        }

        const auth = masterAuth();
        if (auth.kind === 'auth_token' && settings.subaccount_sid) {
            // Güçlü yol: Twilio imzası (subaccount auth token okunabilir)
            const signature = req.header('X-Twilio-Signature');
            if (!signature) {
                res.status(403).json({ error: 'Forbidden' });
                return;
            }
            const token = await subaccountAuthToken(settings.subaccount_sid);
            const url = `${publicUrl.replace(/\/$/, '')}${req.originalUrl}`;
            if (!twilio.validateRequest(token, signature, url, req.body)) {
                log.warn({ accountSid, url }, 'twilio signature validation failed');
                res.status(403).json({ error: 'Forbidden' });
                return;
            }
        } else {
            // API-key yolu: URL secret'ı at-rest şifreliyi çözüp sabit-zamanlı doğrula
            const expected = settings.webhook_secret ? decryptWebhookSecret(settings.webhook_secret) : null;
            if (!secret || !expected || !constantTimeEqual(secret, expected)) {
                log.warn({ accountSid }, 'webhook secret validation failed');
                res.status(403).json({ error: 'Forbidden' });
                return;
            }
        }
        req.coldcallSettings = settings;
        next();
    } catch (err) {
        log.error({ err }, 'twilio webhook verification errored');
        res.status(403).json({ error: 'Forbidden' });
    }
}

router.use(verifyTwilioSignature);

async function loadCall(callId: string | undefined, tenantId: string): Promise<ColdcallCallRow | null> {
    if (!callId || !/^[0-9a-fA-F-]{36}$/.test(callId)) return null;
    const { data } = await supabaseAdmin
        .from('coldcall_calls')
        .select('*')
        .eq('id', callId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    return (data as ColdcallCallRow) ?? null;
}

// ── POST /voice — TwiML: PSTN bacağını kur ───────────────────────────────────
router.post('/voice', async (req: VerifiedRequest, res: Response): Promise<void> => {
    const settings = req.coldcallSettings!;
    const callId = typeof req.body?.callId === 'string' ? req.body.callId : undefined;
    const callSid = typeof req.body?.CallSid === 'string' ? req.body.CallSid : null;
    const call = await loadCall(callId, settings.tenant_id);

    const twiml = new twilio.twiml.VoiceResponse();
    if (!call || !callSid) {
        twiml.say('This call cannot be completed.');
        twiml.hangup();
        res.type('text/xml').send(twiml.toString());
        return;
    }

    // Atomik claim (codex P1): yalnız HENÜZ başlatılmamış (queued + SID yok)
    // çağrı satırı PSTN'e çıkabilir. Aynı callId ile TwiML app'i tekrar tetikleyip
    // (geçerli token'la) ekstra faturasız çağrı açmayı ve terminal satırı
    // diriltmeyi engeller — claim başarısızsa çağrıyı reddet.
    const { data: claimed } = await supabaseAdmin
        .from('coldcall_calls')
        .update({ provider_call_sid: callSid, status: 'ringing' })
        .eq('id', call.id)
        .eq('status', 'queued')
        .is('provider_call_sid', null)
        .select('id')
        .maybeSingle();
    if (!claimed) {
        log.warn({ callId: call.id, callSid }, 'voice webhook claim failed (reused/terminal call)');
        twiml.say('This call cannot be completed.');
        twiml.hangup();
        res.type('text/xml').send(twiml.toString());
        return;
    }

    const publicUrl = (process.env.COLDCALL_PUBLIC_URL ?? '').replace(/\/$/, '');
    // Status/recording callback'leri de aynı webhook secret'ını taşımalı (düz metin,
    // at-rest şifreliyi çözerek) — yoksa Twilio bunları çağırınca doğrulama 403 verir
    const s = settings.webhook_secret ? `&s=${decryptWebhookSecret(settings.webhook_secret)}` : '';
    if (settings.recording_mode === 'announce') {
        const turkish = call.to_country === 'TR';
        twiml.say(
            { language: turkish ? 'tr-TR' : 'en-US' },
            turkish ? 'Bu görüşme hizmet kalitesi için kaydedilmektedir.' : 'This call may be recorded for quality purposes.'
        );
    }
    const dial = twiml.dial({
        callerId: call.from_e164,
        ...(settings.recording_mode !== 'off'
            ? {
                record: 'record-from-answer-dual' as const,
                recordingStatusCallback: `${publicUrl}/api/webhooks/coldcall/recording?callId=${call.id}${s}`,
                recordingStatusCallbackMethod: 'POST' as const,
            }
            : {}),
    });
    dial.number(
        {
            statusCallback: `${publicUrl}/api/webhooks/coldcall/status?callId=${call.id}${s}`,
            statusCallbackMethod: 'POST',
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        },
        call.to_e164
    );
    res.type('text/xml').send(twiml.toString());
});

// ── POST /status — çağrı durum geçişleri ─────────────────────────────────────
router.post('/status', async (req: VerifiedRequest, res: Response): Promise<void> => {
    const settings = req.coldcallSettings!;
    const callId = typeof req.query.callId === 'string' ? req.query.callId : undefined;
    const call = await loadCall(callId, settings.tenant_id);
    res.status(204).end(); // Twilio'ya hemen dön; işleme aşağıda devam eder
    if (!call) return;

    const status = String(req.body?.CallStatus ?? '');
    const withRecording = settings.recording_mode !== 'off';
    try {
        switch (status) {
            case 'ringing':
            case 'initiated':
                await supabaseAdmin.from('coldcall_calls').update({ status: 'ringing' }).eq('id', call.id).eq('status', 'queued');
                break;
            case 'in-progress':
            case 'answered':
                await supabaseAdmin
                    .from('coldcall_calls')
                    .update({ status: 'in_progress', answered_at: call.answered_at ?? new Date().toISOString() })
                    .eq('id', call.id)
                    .in('status', ['queued', 'ringing']);
                break;
            case 'completed': {
                // answered callback'i kaçmış/gecikmiş olabilir — Twilio'nun raporladığı
                // CallDuration ile faturalama sıfırlanmaz (codex P2)
                const reported = parseInt(String(req.body?.CallDuration ?? req.body?.DialCallDuration ?? '0'), 10) || 0;
                await finalizeCall(call, { status: 'completed', withRecording, durationSecOverride: reported });
                break;
            }
            case 'busy':
                await finalizeCall(call, { status: 'busy' });
                break;
            case 'no-answer':
                await finalizeCall(call, { status: 'no_answer' });
                break;
            case 'failed':
                await finalizeCall(call, { status: 'failed' });
                break;
            case 'canceled':
                await finalizeCall(call, { status: 'canceled' });
                break;
            default:
                log.warn({ status, callId: call.id }, 'unhandled twilio call status');
        }
    } catch (err) {
        log.error({ err, callId: call.id, status }, 'status webhook processing failed');
    }
});

// ── POST /recording — kayıt hazır → indir/depola/transkribe ──────────────────
router.post('/recording', async (req: VerifiedRequest, res: Response): Promise<void> => {
    const settings = req.coldcallSettings!;
    const callId = typeof req.query.callId === 'string' ? req.query.callId : undefined;
    const call = await loadCall(callId, settings.tenant_id);
    res.status(204).end();
    if (!call) return;

    const recordingUrl = typeof req.body?.RecordingUrl === 'string' ? req.body.RecordingUrl : null;
    const recordingSid = typeof req.body?.RecordingSid === 'string' ? req.body.RecordingSid : null;
    const duration = parseInt(String(req.body?.RecordingDuration ?? '0'), 10) || 0;
    const recordingStatus = String(req.body?.RecordingStatus ?? 'completed');
    if (!recordingUrl || !recordingSid || recordingStatus !== 'completed') return;

    // Kayıt medyası: master AUTH TOKEN subaccount'a yetkili; master yalnız API
    // key ise subaccount'ın kendi key'i kullanılır (master key subaccount
    // kaynaklarına erişemez)
    let authHeader: string;
    try {
        const a = masterAuth();
        if (a.kind === 'auth_token') {
            authHeader = `Basic ${Buffer.from(`${a.username}:${a.password}`).toString('base64')}`;
        } else if (settings.api_key_sid && settings.api_key_secret_enc) {
            authHeader = `Basic ${Buffer.from(`${settings.api_key_sid}:${decrypt(settings.api_key_secret_enc)}`).toString('base64')}`;
        } else {
            return;
        }
    } catch {
        return;
    }
    void runTwilioRecordingPipeline(call, recordingUrl, recordingSid, duration, authHeader);
});

export default router;
