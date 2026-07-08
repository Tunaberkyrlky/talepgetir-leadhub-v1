/**
 * Tenant telefoni ayarları + dakika kotası.
 * Kota dönemi ay bazlıdır; reset LAZY yapılır (idempotent, period_start guard'lı) —
 * TG-Research period-grant deseniyle aynı yaklaşım.
 */
import { supabaseAdmin } from '../../lib/supabase.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import type { ColdcallSettingsRow } from '../providers/types.js';

const log = createLogger('coldcall:settings');

function currentPeriodStart(): string {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export async function getSettings(tenantId: string): Promise<ColdcallSettingsRow> {
    // İlk kullanımda default satırı oluştur (yarışta no-op)
    const { error: insErr } = await supabaseAdmin
        .from('coldcall_settings')
        .upsert({ tenant_id: tenantId }, { onConflict: 'tenant_id', ignoreDuplicates: true });
    if (insErr) {
        log.error({ err: insErr, tenantId }, 'settings upsert failed');
        throw new AppError('Telephony settings unavailable', 500);
    }

    const { data, error } = await supabaseAdmin
        .from('coldcall_settings')
        .select('*')
        .eq('tenant_id', tenantId)
        .single();
    if (error || !data) {
        log.error({ err: error, tenantId }, 'settings fetch failed');
        throw new AppError('Telephony settings unavailable', 500);
    }

    // Lazy dönem reset'i — guard: yalnız hâlâ eski dönemdeyse sıfırla (idempotent)
    const period = currentPeriodStart();
    if (data.period_start < period) {
        const { data: updated, error: updErr } = await supabaseAdmin
            .from('coldcall_settings')
            .update({ minutes_used: 0, period_start: period, updated_at: new Date().toISOString() })
            .eq('tenant_id', tenantId)
            .eq('period_start', data.period_start)
            .select('*')
            .maybeSingle();
        if (updErr) {
            log.error({ err: updErr, tenantId }, 'period reset failed');
        } else if (updated) {
            return updated as ColdcallSettingsRow;
        }
    }
    return data as ColdcallSettingsRow;
}

/** Kota kontrolü — dolmuşsa AppError(429). */
export function assertQuota(settings: ColdcallSettingsRow): void {
    if (Number(settings.minutes_used) >= settings.minutes_quota) {
        throw new AppError('Aylık arama dakika kotanız doldu', 429);
    }
}

/** Çağrı bitişinde kullanımı işler — atomik RPC (082): artış + dönem devri tek
 *  UPDATE'te, eşzamanlı finalize'lar artış kaybetmez, ay dönümünde eski dönem
 *  satırına yazılmaz (codex P1). */
export async function addUsedMinutes(tenantId: string, minutes: number): Promise<void> {
    if (!minutes || minutes <= 0) return;
    const { error } = await supabaseAdmin.rpc('coldcall_add_used_minutes', {
        p_tenant_id: tenantId,
        p_minutes: minutes,
    });
    if (error) log.error({ err: error, tenantId, minutes }, 'addUsedMinutes failed');
}
