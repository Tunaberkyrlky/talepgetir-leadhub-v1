export type LeadLifecycle = 'captured' | 'identity_pending' | 'needs_review' | 'processing_error';
export type LeadSourceType =
    | 'cold_email' | 'google_ads' | 'meta_ads' | 'youtube'
    | 'website' | 'whatsapp' | 'import' | 'research';

export interface Lead {
    id: string;
    tenant_id: string;
    company_id: string | null;
    contact_id: string | null;
    source_type: LeadSourceType;
    source_id: string | null;
    external_lead_id: string | null;
    campaign_ref: string | null;
    lifecycle_status: LeadLifecycle;
    qualification_status: string | null;
    score: number | null;
    owner_id: string | null;
    match_method: string | null;
    review_reason: string | null;
    raw_submission_id: string | null;
    captured_at: string;
    company_name: string | null;
    contact_name: string | null;
    source_name: string | null;
    owner: { id: string; email: string; name: string | null } | null;
}

export interface LeadsResponse {
    data: Lead[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
        hasNext: boolean;
        hasPrev: boolean;
    };
}
