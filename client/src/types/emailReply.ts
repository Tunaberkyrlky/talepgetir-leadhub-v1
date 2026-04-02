export type MatchStatus = 'matched' | 'unmatched';
export type ReadStatus = 'read' | 'unread';
export type EmailCategory =
    | 'positive'
    | 'negative'
    | 'meeting_request'
    | 'waiting_response'
    | 'not_interested'
    | 'other';

export interface EmailReply {
    id: string;
    tenant_id: string;
    campaign_name: string | null;
    campaign_id: string | null;
    sender_email: string;
    reply_body: string | null;
    replied_at: string;
    company_id: string | null;
    company_name: string | null;
    contact_id: string | null;
    contact_name: string | null;
    match_status: MatchStatus;
    read_status: ReadStatus;
    category: EmailCategory | null;
    category_confidence: number | null;
    created_at: string;
    // Threading fields (present on threaded list responses)
    thread_count?: number;
    has_unread?: boolean;
}

export interface ThreadHistoryItem {
    id: string;
    sender_email: string;
    reply_body: string | null;
    replied_at: string;
    read_status: ReadStatus;
    campaign_id: string | null;
}

export interface EmailReplyStats {
    total: number;
    unread: number;
    matched: number;
    unmatched: number;
}

export interface Campaign {
    campaign_id: string;
    campaign_name: string;
}
