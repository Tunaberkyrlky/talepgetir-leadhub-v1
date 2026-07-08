/**
 * Twilio provider — tenant başına SUBACCOUNT modeli.
 * Master kimlik bilgileri env'den gelir (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN);
 * subaccount kaynaklarına master ile, opts.accountSid scoping'i üzerinden erişilir.
 * Voice SDK token'ı için subaccount başına bir API Key üretilir (secret'ı AES ile
 * coldcall_settings.api_key_secret_enc'te durur).
 *
 * NOT: Bu yol canlı Twilio hesabı gerektirir; hesap yokken factory mock'u seçer.
 * Kod tamdır ancak canlı smoke Twilio kimlik bilgileri sağlanınca yapılacak.
 */
import twilio from 'twilio';
import { supabaseAdmin } from '../../lib/supabase.js';
import { encrypt, decrypt } from '../../lib/encryption.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { finalizeCall } from '../lib/finalize.js';
import type { AvailableNumber, ColdcallCallRow, ColdcallSettingsRow, PurchasedNumber, TelephonyProvider } from './types.js';

const log = createLogger('coldcall:twilio');

const TOKEN_TTL_SEC = 3600;

export function masterCreds(): { sid: string; token: string } {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new AppError('Twilio is not configured on this environment', 503);
    return { sid, token };
}

function publicUrl(): string {
    const url = process.env.COLDCALL_PUBLIC_URL;
    if (!url) throw new AppError('COLDCALL_PUBLIC_URL is not configured', 503);
    return url.replace(/\/$/, '');
}

function subClient(settings: ColdcallSettingsRow) {
    const { sid, token } = masterCreds();
    if (!settings.subaccount_sid) throw new AppError('Tenant is not provisioned for Twilio', 409);
    return twilio(sid, token, { accountSid: settings.subaccount_sid });
}

// Webhook imza doğrulaması subaccount'ın kendi auth token'ını ister —
// master ile canlı çekilir ve 10 dk cache'lenir.
const subTokenCache = new Map<string, { token: string; expires: number }>();

export async function subaccountAuthToken(subaccountSid: string): Promise<string> {
    const cached = subTokenCache.get(subaccountSid);
    if (cached && cached.expires > Date.now()) return cached.token;
    const { sid, token } = masterCreds();
    const account = await twilio(sid, token).api.v2010.accounts(subaccountSid).fetch();
    subTokenCache.set(subaccountSid, { token: account.authToken, expires: Date.now() + 10 * 60 * 1000 });
    return account.authToken;
}

/**
 * Tenant'ı Twilio'ya taşır: subaccount + API key + TwiML app oluşturur ve
 * coldcall_settings'e yazar. Idempotent: zaten provision'lıysa mevcut ayarları döner.
 */
export async function provisionTenantForTwilio(tenantId: string, settings: ColdcallSettingsRow): Promise<void> {
    if (settings.provider === 'twilio' && settings.subaccount_sid && settings.api_key_sid && settings.twiml_app_sid) return;
    const { sid, token } = masterCreds();
    const master = twilio(sid, token);

    const subaccountSid =
        settings.subaccount_sid ??
        (await master.api.v2010.accounts.create({ friendlyName: `tgcore-tenant-${tenantId}` })).sid;

    const subToken = await subaccountAuthToken(subaccountSid);
    const asSub = twilio(subaccountSid, subToken);

    let apiKeySid = settings.api_key_sid;
    let apiKeySecretEnc = settings.api_key_secret_enc;
    if (!apiKeySid || !apiKeySecretEnc) {
        const key = await asSub.newKeys.create({ friendlyName: 'tgcore-voice-sdk' });
        apiKeySid = key.sid;
        apiKeySecretEnc = encrypt(key.secret);
    }

    let twimlAppSid = settings.twiml_app_sid;
    if (!twimlAppSid) {
        const app = await asSub.applications.create({
            friendlyName: 'tgcore-coldcall',
            voiceUrl: `${publicUrl()}/api/webhooks/coldcall/voice`,
            voiceMethod: 'POST',
        });
        twimlAppSid = app.sid;
    }

    const { error } = await supabaseAdmin
        .from('coldcall_settings')
        .update({
            provider: 'twilio',
            subaccount_sid: subaccountSid,
            api_key_sid: apiKeySid,
            api_key_secret_enc: apiKeySecretEnc,
            twiml_app_sid: twimlAppSid,
            updated_at: new Date().toISOString(),
        })
        .eq('tenant_id', tenantId);
    if (error) {
        log.error({ err: error, tenantId }, 'provision settings update failed');
        throw new AppError('Provisioning failed', 500);
    }
    log.info({ tenantId, subaccountSid }, 'tenant provisioned for Twilio');
}

export const twilioProvider: TelephonyProvider = {
    name: 'twilio',
    callMode: 'webrtc',

    async searchNumbers(settings, country, contains) {
        const client = subClient(settings);
        const list = await client.availablePhoneNumbers(country).local.list({
            voiceEnabled: true,
            ...(contains ? { contains } : {}),
            limit: 8,
        });
        return list.map((n): AvailableNumber => ({
            e164: n.phoneNumber,
            friendly_name: n.friendlyName,
            locality: n.locality || undefined,
        }));
    },

    async purchaseNumber(settings, e164, _country) {
        const client = subClient(settings);
        const purchased = await client.incomingPhoneNumbers.create({
            phoneNumber: e164,
            voiceApplicationSid: settings.twiml_app_sid ?? undefined,
        });
        return {
            provider_sid: purchased.sid,
            e164: purchased.phoneNumber,
            // Regulatory gereksinimli ülkelerde Twilio satın almayı bundle onayına bağlar;
            // create başarılıysa numara kullanılabilir durumdadır.
            status: 'active',
        } as PurchasedNumber;
    },

    async releaseNumber(settings, providerSid) {
        await subClient(settings).incomingPhoneNumbers(providerSid).remove();
    },

    async placeCall() {
        // no-op: webrtc modunda çağrıyı tarayıcıdaki Voice SDK başlatır;
        // PSTN bacağını /api/webhooks/coldcall/voice TwiML'i kurar.
    },

    async hangupCall(call, settings) {
        if (!call.provider_call_sid) {
            // Voice SDK hiç bağlanamadı (token/mikrofon hatası) — çağrı queued
            // kalmasın, iptal olarak kapat (codex P2)
            await finalizeCall(call, { status: 'canceled' });
            return;
        }
        try {
            await subClient(settings).calls(call.provider_call_sid).update({ status: 'completed' });
        } catch (err) {
            log.warn({ err, callId: call.id }, 'twilio hangup failed (call may have already ended)');
        }
    },

    async voiceToken(settings, identity) {
        if (!settings.subaccount_sid || !settings.api_key_sid || !settings.api_key_secret_enc || !settings.twiml_app_sid) {
            throw new AppError('Tenant is not provisioned for Twilio', 409);
        }
        const AccessToken = twilio.jwt.AccessToken;
        const VoiceGrant = AccessToken.VoiceGrant;
        const token = new AccessToken(
            settings.subaccount_sid,
            settings.api_key_sid,
            decrypt(settings.api_key_secret_enc),
            { identity, ttl: TOKEN_TTL_SEC }
        );
        token.addGrant(new VoiceGrant({ outgoingApplicationSid: settings.twiml_app_sid }));
        return token.toJwt();
    },
};
