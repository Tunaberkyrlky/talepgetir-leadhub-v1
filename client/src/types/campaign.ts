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
