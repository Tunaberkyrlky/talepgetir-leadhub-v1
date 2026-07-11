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

// A honeypot/Turnstile-flagged submission that never became a lead (Spam queue).
export interface SpamSubmission {
    id: string;
    email: string | null;
    name: string | null;
    form_name: string | null;
    reason: string | null;      // 'honeypot' | 'turnstile' | 'spam_suspect'
    submitted_at: string;
}

export interface SpamSubmissionsResponse {
    data: SpamSubmission[];
    pagination: LeadsResponse['pagination'];
}

// ── Enrichment + qualification (v3 WP2) ────────────────────────────────────
export type Verdict = 'qualified' | 'disqualified' | 'review';
export type EnrichmentStatus = 'queued' | 'running' | 'done' | 'failed';

export interface EvidenceItem {
    code: string;
    weight: number;
    hit: boolean;
    detail?: string | null;
}

export interface EnrichmentRun {
    id: string;
    lead_id: string;
    status: EnrichmentStatus;
    mode: 'dry_run' | 'live';
    score: number | null;
    verdict: Verdict | null;
    evidence: EvidenceItem[];
    reason_codes: string[];
    source_evidence: Record<string, unknown>;
    resolved_verdict: Verdict | null;
    resolved_note: string | null;
    error_reason: string | null;
    created_at: string;
    completed_at: string | null;
}

// A row in the qualification review queue (enrichment verdict=review, unresolved).
export interface ReviewQueueItem {
    id: string;                 // enrichment run id
    lead_id: string;
    verdict: Verdict;
    score: number | null;
    reason_codes: string[];
    evidence: EvidenceItem[];
    created_at: string;
    source_type: LeadSourceType | null;
    source_name: string | null;
    company_id: string | null;
    contact_id: string | null;
    company_name: string | null;
    contact_name: string | null;
    captured_at: string | null;
}

export interface ReviewQueueResponse {
    data: ReviewQueueItem[];
    pagination: LeadsResponse['pagination'];
}
