// ── PlusVibe Integration Types ──

export interface PlusVibeStatus {
    configured: boolean;
    connected: boolean;
}

export interface PlusVibeCredentialResponse {
    configured: boolean;
    connected?: boolean;
    workspace_id?: string;
    api_key_masked?: string;
}

export interface PlusVibeCampaign {
    id: string;
    tenant_id: string;
    pv_campaign_id: string;
    name: string;
    status: string | null;
    total_leads: number;
    emails_sent: number;
    opens: number;
    clicks: number;
    replies: number;
    bounces: number;
    open_rate: number;
    click_rate: number;
    reply_rate: number;
    last_synced_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface CampaignsResponse {
    data: PlusVibeCampaign[];
    last_synced_at: string | null;
}

export interface SyncResponse {
    synced: number;
    synced_at: string;
}
