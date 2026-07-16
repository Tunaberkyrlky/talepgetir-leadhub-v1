/**
 * Cold Call admin paneli — API çağrıları (superadmin/ops_agent, server route:
 * server/src/coldcall/routes/admin.ts, mounted at /api/coldcall/admin/*).
 * Bu dosya yalnız admin yüzeyi (COGS $ dahil) içindir — müşteri tarafı için
 * client/src/components/coldcall/api.ts kullanılır ($ YOK).
 */
import api from '../../lib/api';

export interface ColdCallUsageRow {
    tenant_id: string;
    tenant_name: string;
    calls_total: number;
    calls_completed: number;
    talk_minutes: number;
    billed_minutes: number;
    call_cogs_usd: number;
    numbers_count: number;
    numbers_monthly_usd: number;
    total_cogs_usd: number;
    /** coldcall_settings satırı yoksa (tenant Cold Call'u hiç açmamış) undefined olabilir. */
    minutes_balance?: number;
    provider?: 'mock' | 'twilio';
}

export interface ColdCallUsageResponse {
    usage: ColdCallUsageRow[];
    twilio_configured: boolean;
}

/** Admin'in TAM ledger görünümü — created_by/source/idempotency_key dahil (müşteri görünümünden farklı). */
export interface ColdCallAdminLedgerRow {
    id: string;
    delta_minutes: number;
    kind: 'grant' | 'usage' | 'adjustment' | 'refund' | 'initial';
    balance_after: number;
    reason: string | null;
    call_id: string | null;
    created_by: string | null;
    source: string | null;
    idempotency_key: string | null;
    created_at: string;
}

export const coldcallAdminApi = {
    usage: async (): Promise<ColdCallUsageResponse> =>
        (await api.get('/coldcall/admin/usage')).data,

    /** minutes > 0 → yükleme, minutes < 0 → düzeltme. idempotency_key çağıran tarafta üretilir (crypto.randomUUID). */
    grantCredit: async (input: {
        tenant_id: string;
        minutes: number;
        reason: string;
        idempotency_key: string;
    }): Promise<{ ok: boolean; minutes_balance: number }> =>
        (await api.post('/coldcall/admin/credits/grant', input)).data,

    ledger: async (
        tenantId: string,
        params?: { limit?: number; before?: string }
    ): Promise<ColdCallAdminLedgerRow[]> =>
        (await api.get(`/coldcall/admin/credits/${tenantId}/ledger`, { params })).data.ledger,

    provision: async (tenant_id: string): Promise<{ ok: boolean }> =>
        (await api.post('/coldcall/admin/provision', { tenant_id })).data,
};
