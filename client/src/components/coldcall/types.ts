/** Cold Call modülü — client tipleri (server route shape'leriyle birebir). */

export interface ColdcallConfig {
    provider: 'mock' | 'twilio';
    call_mode: 'simulated' | 'webrtc';
    recording_mode: 'always' | 'announce' | 'off';
    /** Ön-ödemeli dakika cüzdanı — kalan bakiye (negatif olabilir, UI'da 0'a clamp'lenir). */
    minutes_balance: number;
    /** Bilgi amaçlı: bu dönem (ay başından itibaren) kullanılan dakika, ledger'dan türetilir. */
    minutes_used_period: number;
    /** Bakiye eşiğin (server sabiti) altındaysa true — UI uyarı gösterir. */
    low_balance: boolean;
    max_numbers: number;
    daily_cap_per_number: number;
    active_numbers: number;
    twilio_configured: boolean;
}

/** Kredi cüzdanı hareket satırı — müşteri görünümü, $ YOK. */
export interface CreditLedgerRow {
    id: string;
    /** İşaretli: + grant/refund/initial, - usage/aşağı-düzeltme. */
    delta_minutes: number;
    kind: 'grant' | 'usage' | 'adjustment' | 'refund' | 'initial';
    balance_after: number;
    reason: string | null;
    created_at: string;
}

export interface CountryInfo {
    code: string;
    name_tr: string;
    name_en: string;
    dial_code: string;
    callable: boolean;
    blocked_reason: 'sanctioned' | 'provider_unsupported' | 'premium_rate_risk' | null;
    tier: 'standard' | 'expensive' | 'very_expensive' | 'blocked';
    /** Origin-aware fiyat: menşe (numaranızın ülkesi) × hedef + hat tipine göre değişir — aralık. */
    multiplier_min: number;
    multiplier_max: number;
    can_buy_number: boolean;
    number_requires_docs: boolean | null;
    number_doc_status: 'docless' | 'low_friction' | 'docs' | null;
    /** Yalnız internal rollerde döner */
    usd?: { euMobile: number; euFixed: number; intlMobile: number; intlFixed: number };
    number_monthly_usd?: number | null;
    number_types?: { type: string; monthly_usd: number; doc_status: string }[];
}

export type NumberHealth = 'warming' | 'good' | 'watch' | 'risk' | 'insufficient_data';

export interface PhoneNumber {
    id: string;
    e164: string;
    country_code: string;
    friendly_name: string | null;
    status: 'purchasing' | 'purchase_unknown' | 'release_pending' | 'pending_regulatory' | 'active' | 'released';
    purchased_at: string;
    /** İtibar/sağlık istatistikleri (listede döner) */
    calls_today?: number;
    calls_7d?: number;
    answer_rate_7d?: number | null;
    daily_cap?: number;
    remaining_today?: number;
    health?: NumberHealth;
    /** Yalnız internal rollerde döner */
    provider?: string;
    monthly_cost_usd?: number | null;
}

export interface AvailableNumber {
    e164: string;
    friendly_name: string;
    locality?: string;
    offer: string;
}

export type CallStatus =
    | 'queued' | 'ringing' | 'in_progress'
    | 'completed' | 'busy' | 'no_answer' | 'failed' | 'canceled';

export const TERMINAL_CALL_STATUSES: CallStatus[] = ['completed', 'busy', 'no_answer', 'failed', 'canceled'];

export interface CallRow {
    id: string;
    company_id: string | null;
    contact_id: string | null;
    from_e164: string;
    to_e164: string;
    to_country: string | null;
    status: CallStatus;
    started_at: string;
    answered_at: string | null;
    ended_at: string | null;
    duration_sec: number | null;
    rate_multiplier: number;
    billed_minutes: number | null;
    disposition: string | null;
    notes: string | null;
    created_at: string;
    company?: { id: string; name: string } | null;
    recording_status?: string | null;
    transcript_status?: string | null;
    summary?: string | null;
    sentiment?: string | null;
    /** Yalnız internal rollerde döner */
    cogs_usd?: number | null;
}

export interface TranscriptSegment {
    speaker: 'agent' | 'lead';
    start_sec: number;
    end_sec: number;
    text: string;
}

export interface CallDetail {
    call: CallRow;
    recording: { id: string; status: string; duration_sec: number | null; url: string | null } | null;
    transcript: {
        status: 'pending' | 'done' | 'failed';
        language: string | null;
        segments: TranscriptSegment[] | null;
        summary: string | null;
        action_items: string[] | null;
        sentiment: 'positive' | 'neutral' | 'negative' | null;
        provider: string | null;
    } | null;
}

export const DISPOSITION_OPTIONS = [
    'connected', 'interested', 'not_interested', 'callback', 'voicemail', 'no_answer', 'busy', 'wrong_number',
] as const;
export type Disposition = (typeof DISPOSITION_OPTIONS)[number];
