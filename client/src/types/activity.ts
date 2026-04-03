/**
 * Tam ActivityType union — server'ın kullanıcıdan reddettiği system-generated tipleri de içerir.
 * Kullanıcı submit edebilir: 'not' | 'meeting' | 'follow_up'  (bkz. server/src/lib/validation.ts ALLOWED_ACTIVITY_TYPES)
 * System-generated only: 'sonlandirma_raporu' (closing-report endpoint), 'status_change' (aşama geçişi)
 * Client 5 tipin tamamını bilmeli — server'ın yarattığı timeline kayıtlarını doğru render etmek için.
 */
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
