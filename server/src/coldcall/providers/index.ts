/**
 * Provider factory — seçim tenant ayarından gelir; Twilio ayarlı değilse
 * (env'de master kimlik yoksa) güvenle mock'a düşer, böylece demo her
 * ortamda çalışır.
 */
import { mockProvider } from './mock.js';
import { twilioProvider } from './twilio.js';
import type { ColdcallSettingsRow, TelephonyProvider } from './types.js';

export function twilioConfigured(): boolean {
    return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

export function providerFor(settings: ColdcallSettingsRow): TelephonyProvider {
    if (settings.provider === 'twilio' && twilioConfigured()) return twilioProvider;
    return mockProvider;
}
