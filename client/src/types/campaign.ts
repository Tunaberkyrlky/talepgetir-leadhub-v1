export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed';
export type StepType = 'email' | 'delay';
export type EnrollmentStatus = 'active' | 'completed' | 'paused' | 'replied' | 'bounced' | 'unsubscribed';

export interface Campaign {
    id: string;
    tenant_id: string;
    name: string;
    description: string | null;
    status: CampaignStatus;
    from_name: string | null;
    settings: { daily_limit?: number; timezone?: string };
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
    emails_sent: number;
    opens: number;
    clicks: number;
    replies: number;
    open_rate: number;
    click_rate: number;
    reply_rate: number;
}

export interface EmailConnectionStatus {
    connected: boolean;
    provider?: 'google-mail' | 'microsoft-outlook';
    email?: string;
    connected_at?: string;
}

export interface EnrollLeadPayload {
    contact_id: string;
    company_id: string;
    email: string;
}
