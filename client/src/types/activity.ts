export type ActivityType = 'not' | 'meeting' | 'follow_up' | 'sonlandirma_raporu' | 'status_change';
export type ActivityVisibility = 'internal' | 'client';
export type ClosingOutcome = 'won' | 'lost' | 'on_hold' | 'cancelled';

export interface Activity {
    id: string;
    tenant_id: string;
    company_id: string;
    contact_id: string | null;
    contact_name: string | null;
    company_name?: string | null;
    type: ActivityType;
    outcome: string | null;          // sonlandırma raporu: won/lost/on_hold/cancelled
    summary: string;
    detail: string | null;           // sonlandırma raporu: reason/açıklama
    visibility: ActivityVisibility;
    occurred_at: string;
    created_by: string;
    created_at: string;
}
