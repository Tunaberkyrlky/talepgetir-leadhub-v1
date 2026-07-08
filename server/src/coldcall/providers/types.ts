/**
 * Cold Call — telephony provider soyutlaması.
 * Ürün kodu asla doğrudan Twilio/Mock çağırmaz; providers/index.ts factory'sinden
 * gelen TelephonyProvider arayüzünü kullanır. Sağlayıcı değişimi tek modül işidir.
 */

export interface ColdcallSettingsRow {
    tenant_id: string;
    provider: 'mock' | 'twilio';
    subaccount_sid: string | null;
    api_key_sid: string | null;
    api_key_secret_enc: string | null;
    twiml_app_sid: string | null;
    recording_mode: 'always' | 'announce' | 'off';
    default_phone_number_id: string | null;
    minutes_quota: number;
    minutes_used: number;
    period_start: string;
    max_numbers: number;
    daily_cap_per_number: number;
}

export interface ColdcallCallRow {
    id: string;
    tenant_id: string;
    company_id: string | null;
    contact_id: string | null;
    user_id: string | null;
    phone_number_id: string | null;
    direction: 'outbound' | 'inbound';
    from_e164: string;
    to_e164: string;
    to_country: string | null;
    provider_call_sid: string | null;
    status: string;
    started_at: string;
    answered_at: string | null;
    ended_at: string | null;
    duration_sec: number | null;
    rate_multiplier: number;
    billed_minutes: number | null;
    cogs_usd: number | null;
    disposition: string | null;
    notes: string | null;
    activity_id: string | null;
    created_at: string;
}

export interface AvailableNumber {
    e164: string;
    friendly_name: string;
    locality?: string;
}

export interface PurchasedNumber {
    provider_sid: string;
    e164: string;
    /** Bazı ülkelerde regulatory onay bekler */
    status: 'active' | 'pending_regulatory';
}

export interface TelephonyProvider {
    readonly name: 'mock' | 'twilio';
    /** 'simulated' → client durum poll'lar; 'webrtc' → client Voice SDK ile bağlanır */
    readonly callMode: 'simulated' | 'webrtc';

    searchNumbers(settings: ColdcallSettingsRow, country: string, contains?: string): Promise<AvailableNumber[]>;
    purchaseNumber(settings: ColdcallSettingsRow, e164: string, country: string): Promise<PurchasedNumber>;
    releaseNumber(settings: ColdcallSettingsRow, providerSid: string): Promise<void>;

    /**
     * Çağrıyı başlatır. Mock: sunucu tarafında yaşam döngüsünü simüle eder.
     * Twilio: no-op — çağrıyı tarayıcıdaki Voice SDK kurar (TwiML webhook'u yönlendirir).
     */
    placeCall(call: ColdcallCallRow, settings: ColdcallSettingsRow): Promise<void>;
    hangupCall(call: ColdcallCallRow, settings: ColdcallSettingsRow): Promise<void>;

    /** Voice SDK access token — yalnız webrtc modunda */
    voiceToken?(settings: ColdcallSettingsRow, identity: string): Promise<string>;
}
