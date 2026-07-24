export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed';
// 'condition' ileriye dönük (Faz 2 — dallanma); UI henüz üretmiyor.
export type StepType = 'email' | 'delay' | 'condition';
export type EnrollmentStatus = 'active' | 'completed' | 'paused' | 'replied' | 'bounced' | 'unsubscribed';

// ── Kampanya ayarları (Ayarlar sekmesi) ────────────────────────────────────
// Bugün backend yalnızca `daily_limit` + `timezone` kaydediyor. Diğer alanlar
// Faz 1'de doldurulacak (gönderim penceresi, kutu rotasyonu, takip toggle'ları).

/** Gönderim penceresi — yalnızca seçili gün/saat aralığında gönderim (Faz 1.1). */
export interface SendingWindow {
    days?: number[];   // 0=Pazar … 6=Cumartesi
    start?: string;    // "09:00" (yerel, settings.timezone'a göre)
    end?: string;      // "18:00"
}

export interface CampaignTracking {
    open?: boolean;    // açılma pikseli
    click?: boolean;   // tıklama yönlendirme
}

export interface CampaignSettings {
    daily_limit?: number;            // kampanya günlük tavanı (canlı)
    per_inbox_limit?: number;        // kutu-başı günlük limit (canlı)
    jitter_minutes?: number;         // insansı gönderim — rastgele gecikme dk (canlı)
    timezone?: string;               // IANA tz — gönderim penceresi için kanonik (canlı)
    cc?: string[];                   // kampanya seviyesi CC (canlı)
    sending_window?: SendingWindow;  // gönderim programı (Faz 1.1)
    sending_accounts?: string[];     // inbox rotasyonu — kullanılacak gönderen mailler (canlı)
    tracking?: CampaignTracking;     // açılma/tıklama takip toggle'ları (canlı)
    send_statuses?: CampaignEmailStatus[]; // CSV importlu alıcılarda gönderime uygun statüler (boşsa ok+catch_all)
    followup_ramp?: FollowupRamp;    // rampalı follow-up payı (günlük limit içinde)
}

// Follow-up'ların günlük limitten alacağı pay; hafta hafta start→max'a çıkar.
export interface FollowupRamp {
    start_pct: number;       // ilk hafta payı (%)
    weekly_step_pct: number; // her hafta eklenen (%)
    max_pct: number;         // tavan (%)
}

// CSV alıcı importundaki e-posta doğrulama statüsü (harici doğrulayıcıdan).
export type CampaignEmailStatus = 'ok' | 'catch_all' | 'unknown' | 'invalid' | 'error';

// Grafta per-node kolon eşleme için kampanyaya yüklenen CSV kaynağı (migration 071).
export interface CampaignCsvSource {
    file_id: string;
    file_name?: string;
    headers: string[];
    columns: {
        email?: string;
        company?: string;
        website?: string;
        location?: string;
        industry?: string;
        email_status?: string;
        dnc_status?: string;
    };
    row_count?: number;
    sample_row?: Record<string, string>; // ilk CSV satırı — node önizlemesi için
}

export interface Campaign {
    id: string;
    tenant_id: string;
    name: string;
    description: string | null;
    status: CampaignStatus;
    from_name: string | null;
    settings: CampaignSettings;
    total_enrolled: number;
    created_by: string;
    created_at: string;
    updated_at: string;
    steps?: CampaignStep[];
    stats?: CampaignStats;
    csv_source?: CampaignCsvSource | null;
}

export interface CampaignStep {
    id?: string;
    campaign_id?: string;
    step_order: number;
    step_type: StepType;
    subject: string | null;
    body_html: string | null;
    body_text: string | null;
    delay_days: number;
    delay_hours: number;
    // ── Graf alanları (Faz 2, migration 057) — görsel karar ağacı editörü.
    //    Hepsi opsiyonel; lineer kampanyalarda set edilmez (engine step_order'a düşer). ──
    step_kind?: 'email' | 'delay' | 'condition' | 'split' | 'action' | null;
    next_step_id?: string | null;
    condition_type?: string | null;
    condition_wait_hours?: number | null;
    condition_true_step_id?: string | null;
    condition_false_step_id?: string | null;
    config?: Record<string, unknown> | null;
    is_entry?: boolean | null;
}

export interface Enrollment {
    id: string;
    email: string;
    status: EnrollmentStatus;
    contact_name: string;
    company_name: string;
    current_step_order: number | null;
    current_step_type: string | null;
    next_scheduled_at: string | null;
    enrolled_at: string;
    completed_at: string | null;
    // CSV importlu alıcı alanları (import edilmemiş kayıtlarda null/false)
    email_status: CampaignEmailStatus | null;
    dnc_status: string | null;
    excluded_reason: string | null; // invalid_status | error_status | status_filtered | dnc
    has_custom_message: boolean;
    message_snippet?: string; // intro (custom_body_text) ilk ~120 karakter
    step_snippets?: Record<string, string>; // step_id → o adımın mesaj snippet'i (follow-up dahil)
}

// GET /campaigns/:id/enrollments/:eid/preview — gönderilecek mailin birebir hali
export interface EnrollmentMessagePreview {
    to: string;
    subject: string;
    body_html: string;
    has_custom: boolean;
    company_name: string;
    contact_name: string;
}

export interface CampaignStats {
    total_enrolled: number;
    active: number;
    completed: number;
    replied: number;
    paused: number;
    bounced: number;
    unsubscribed: number;
    emails_sent: number;
    opens: number;
    clicks: number;
    replies: number;
    open_rate: number;
    click_rate: number;
    reply_rate: number;
    by_account: { account: string; sent: number }[];
    daily: { date: string; sent: number; opens: number }[];
    by_step: { step: number; sent: number; opens: number; clicks: number }[];
    tracking_enabled: boolean;
}

export type ConnectionProvider = 'google-mail' | 'microsoft-outlook' | 'smtp';

export interface EmailConnectionItem {
    id: string;
    provider: ConnectionProvider;
    email_address: string;
    is_default: boolean;
    smtp_host?: string | null;
    imap_host?: string | null;
    last_polled_at?: string | null;
    connected_at?: string;
}

export interface EmailConnectionStatus {
    connected: boolean;
    provider?: ConnectionProvider;
    email?: string;
    connected_at?: string;
    connections?: EmailConnectionItem[];
}

export interface EnrollLeadPayload {
    contact_id: string;
    company_id: string;
    email: string;
}
