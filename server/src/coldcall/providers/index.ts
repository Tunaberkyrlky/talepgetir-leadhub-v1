/**
 * Provider factory — persisted provider seçimi fail-closed uygulanır.
 */
import { mockProvider } from './mock.js';
import { twilioProvider, isTwilioConfigured } from './twilio.js';
import type { ColdcallSettingsRow, TelephonyProvider } from './types.js';
import { AppError } from '../../middleware/errorHandler.js';

export function twilioConfigured(): boolean {
    return isTwilioConfigured();
}

export function providerFor(settings: ColdcallSettingsRow): TelephonyProvider {
    if (settings.provider === 'mock') return mockProvider;
    if (settings.provider === 'twilio') {
        if (!twilioConfigured()) throw new AppError('Twilio provider is unavailable in this environment', 503);
        return twilioProvider;
    }
    throw new AppError('Persisted telephony provider is invalid', 500);
}
