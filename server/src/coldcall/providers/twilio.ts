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
import { randomBytes } from 'crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { encrypt, decrypt } from '../../lib/encryption.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { finalizeCall } from '../lib/finalize.js';
import type { AvailableNumber, ColdcallCallRow, ColdcallSettingsRow, PurchasedNumber, TelephonyProvider } from './types.js';

const log = createLogger('coldcall:twilio');

const TOKEN_TTL_SEC = 3600;

/**
 * Master kimlik: iki auth modeli desteklenir —
 *   1) Account SID + Auth Token (klasik)
 *   2) Account SID + API Key SID/Secret (TWILIO_API_KEY_SID/SECRET ya da
 *      kullanıcının koyduğu TWILIO_SID/TWILIO_CLIENT_SECRET adları)
 * twilio() client'ında username/password olarak kullanılır; accountSid scoping
 * ile subaccount kaynaklarına erişilir.
 */
export interface MasterAuth {
    username: string;
    password: string;
    accountSid: string;
    /** auth_token: subaccount kaynaklarına ve token okumaya yetkili;
     *  api_key: yalnız ana hesap kaynakları + subaccount Keys.create istisnası */
    kind: 'auth_token' | 'api_key';
}

export function masterAuth(): MasterAuth {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const keySid = process.env.TWILIO_API_KEY_SID || process.env.TWILIO_SID;
    const keySecret = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_CLIENT_SECRET;
    if (accountSid && authToken) return { username: accountSid, password: authToken, accountSid, kind: 'auth_token' };
    if (accountSid && keySid && keySecret) return { username: keySid, password: keySecret, accountSid, kind: 'api_key' };
    throw new AppError('Twilio is not configured on this environment', 503);
}

export function isTwilioConfigured(): boolean {
    try {
        masterAuth();
        return true;
    } catch {
        return false;
    }
}

function masterClient() {
    const a = masterAuth();
    return twilio(a.username, a.password, { accountSid: a.accountSid });
}

function publicUrl(): string {
    const url = process.env.COLDCALL_PUBLIC_URL;
    if (!url) throw new AppError('COLDCALL_PUBLIC_URL is not configured', 503);
    return url.replace(/\/$/, '');
}

/**
 * Subaccount-scoped client. Master AUTH TOKEN varsa onunla; master yalnız API
 * key ise (subaccount kaynaklarına yetkisiz) tenant'ın kendi subaccount API
 * key'ine düşer (provision'da oluşturulur).
 */
function subClient(settings: ColdcallSettingsRow) {
    if (!settings.subaccount_sid) throw new AppError('Tenant is not provisioned for Twilio', 409);
    const a = masterAuth();
    if (a.kind === 'auth_token') {
        return twilio(a.username, a.password, { accountSid: settings.subaccount_sid });
    }
    if (settings.api_key_sid && settings.api_key_secret_enc) {
        return twilio(settings.api_key_sid, decrypt(settings.api_key_secret_enc), {
            accountSid: settings.subaccount_sid,
        });
    }
    throw new AppError('Tenant is not provisioned for Twilio', 409);
}

// Webhook imza doğrulaması subaccount'ın kendi auth token'ını ister —
// master ile canlı çekilir ve 10 dk cache'lenir.
const subTokenCache = new Map<string, { token: string; expires: number }>();

export async function subaccountAuthToken(subaccountSid: string): Promise<string> {
    const cached = subTokenCache.get(subaccountSid);
    if (cached && cached.expires > Date.now()) return cached.token;
    const a = masterAuth();
    const account = await twilio(a.username, a.password, { accountSid: a.accountSid })
        .api.v2010.accounts(subaccountSid)
        .fetch();
    subTokenCache.set(subaccountSid, { token: account.authToken, expires: Date.now() + 10 * 60 * 1000 });
    return account.authToken;
}

/**
 * Saklanan webhook secret'ını düz metne çevirir. Migration-toleranslı:
 * decrypt başarısızsa (eski düz-metin satır) değeri olduğu gibi döner.
 */
export function decryptWebhookSecret(stored: string): string {
    try {
        return decrypt(stored);
    } catch {
        return stored;
    }
}

/**
 * Tenant'ı Twilio'ya taşır: subaccount + API key + TwiML app oluşturur ve
 * coldcall_settings'e yazar. Idempotent: zaten provision'lıysa mevcut ayarları döner.
 */
export async function provisionTenantForTwilio(tenantId: string, settings: ColdcallSettingsRow): Promise<void> {
    // Secret de zorunlu — eksikse (eski provision) tamamlamaya devam et
    if (settings.provider === 'twilio' && settings.subaccount_sid && settings.api_key_sid && settings.twiml_app_sid && settings.webhook_secret) return;
    const master = masterClient();

    let subaccountSid = settings.subaccount_sid;
    if (!subaccountSid) {
        // İdempotens: yarım kalmış bir provision'ın subaccount'ı varsa yeniden
        // kullan (friendlyName deterministik) — retry'da mükerrer hesap açma
        const friendly = `tgcore-tenant-${tenantId}`;
        const existing = await master.api.v2010.accounts.list({ friendlyName: friendly, limit: 1 });
        subaccountSid = existing[0]?.sid ?? (await master.api.v2010.accounts.create({ friendlyName: friendly })).sid;
    }

    // NOT (Twilio yetki modeli): master API key subaccount kaynaklarını
    // YÖNETEMEZ; tek istisna subaccount Keys.create. Bu yüzden sıra:
    //   1) master kimlikle subaccount'a API key aç (istisna),
    //   2) kalan her şeyi (TwiML app vs.) o SUBACCOUNT KEY ile yap.
    // Master AUTH TOKEN varsa 1. adımda da o kullanılır — her iki modelde çalışır.
    const a = masterAuth();
    const asSubMaster = twilio(a.username, a.password, { accountSid: subaccountSid });

    let apiKeySid = settings.api_key_sid;
    let apiKeySecretEnc = settings.api_key_secret_enc;
    if (!apiKeySid || !apiKeySecretEnc) {
        const key = await asSubMaster.newKeys.create({ friendlyName: 'tgcore-voice-sdk' });
        apiKeySid = key.sid;
        apiKeySecretEnc = encrypt(key.secret);
        // Key'i hemen persiste et: sonraki adım patlasa bile retry'da yeni
        // (öksüz) key üretmeyelim
        await supabaseAdmin
            .from('coldcall_settings')
            .update({ subaccount_sid: subaccountSid, api_key_sid: apiKeySid, api_key_secret_enc: apiKeySecretEnc, updated_at: new Date().toISOString() })
            .eq('tenant_id', tenantId);
    }

    const asSub = twilio(apiKeySid, decrypt(apiKeySecretEnc), { accountSid: subaccountSid });

    // Webhook doğrulama secret'ı — TwiML app URL'sine DÜZ metin gömülür (Twilio
    // literal ister), ama at-rest ŞİFRELİ saklanır (codex P2). Mevcut secret varsa
    // (decrypt edilebiliyorsa) korunur; drift'i önlemek için app voiceUrl'si her
    // durumda güncel secret'la senkronlanır.
    const webhookSecret = (settings.webhook_secret ? decryptWebhookSecret(settings.webhook_secret) : null)
        ?? randomBytes(24).toString('hex');

    const voiceUrl = `${publicUrl()}/api/webhooks/coldcall/voice?s=${webhookSecret}`;
    let twimlAppSid = settings.twiml_app_sid;
    if (!twimlAppSid) {
        const app = await asSub.applications.create({
            friendlyName: 'tgcore-coldcall',
            voiceUrl,
            voiceMethod: 'POST',
        });
        twimlAppSid = app.sid;
    } else {
        // voiceUrl'yi güncel secret'la senkron tut (URL↔saklanan secret drift'i önle)
        await asSub.applications(twimlAppSid).update({ voiceUrl, voiceMethod: 'POST' });
    }

    const { error } = await supabaseAdmin
        .from('coldcall_settings')
        .update({
            provider: 'twilio',
            subaccount_sid: subaccountSid,
            api_key_sid: apiKeySid,
            api_key_secret_enc: apiKeySecretEnc,
            twiml_app_sid: twimlAppSid,
            webhook_secret: encrypt(webhookSecret),
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
