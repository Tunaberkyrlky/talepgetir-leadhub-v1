/**
 * Tenant telefoni ayarları + dakika CÜZDANI (ön-ödemeli, rollover).
 * Bakiye (minutes_balance) AY BAŞINDA SIFIRLANMAZ; admin yükler (grantMinutes),
 * çağrı biterken atomik finalize RPC'si düşer, her hareket coldcall_credit_ledger'a
 * append-only yazılır (plan COLD_CALL_CREDIT_PLAN.md §2-4).
 *
 * minutes_quota / minutes_used / period_start kolonları VESTIGIAL — DB'de durur
 * (destructive drop yok) ama bu modül artık okumaz/yazmaz.
 */
import { supabaseAdmin } from '../../lib/supabase.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import type { ColdcallSettingsRow } from '../providers/types.js';
import { createHash } from 'crypto';

const log = createLogger('coldcall:settings');

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
    return data as ColdcallSettingsRow;
}

/**
 * Bakiye kontrolü — cüzdan tükenmişse AppError(429). Devam eden TEK bir çağrı
 * bakiyeyi hafifçe eksiye taşıyabilir (kabul edilir, standart telefoni davranışı);
 * burada yalnız YENİ bir çağrının başlaması engellenir (plan §8.1).
 */
export function assertBalance(settings: ColdcallSettingsRow): void {
    if (Number(settings.minutes_balance) <= 0) {
        throw new AppError('Arama krediniz tükendi. Yükleme için bizimle iletişime geçin.', 429);
    }
}

export interface GrantMinutesInput {
    tenantId: string;
    minutes: number;
    kind: 'grant' | 'adjustment' | 'refund' | 'initial';
    reason: string;
    createdBy?: string | null;
    source?: 'manual' | 'stripe' | 'system';
    idempotencyKey?: string | null;
}

/**
 * Admin kredi yükleme / düzeltme — atomik + idempotency-key korumalı RPC
 * (coldcall_grant_minutes). Aynı idempotencyKey ile tekrar çağrı çift yükleme
 * yapmaz (partial unique index idempotency_key WHERE NOT NULL).
 */
export async function grantMinutes(input: GrantMinutesInput): Promise<number> {
    const fingerprint = createHash('sha256').update(JSON.stringify({
        minutes: input.minutes,
        kind: input.kind,
        reason: input.reason,
        createdBy: input.createdBy ?? null,
        source: input.source ?? 'manual',
    })).digest('hex');
    const { data, error } = await supabaseAdmin.rpc('coldcall_grant_minutes', {
        p_tenant_id: input.tenantId,
        p_minutes: input.minutes,
        p_kind: input.kind,
        p_reason: input.reason,
        p_created_by: input.createdBy ?? null,
        p_source: input.source ?? 'manual',
        p_idempotency_key: input.idempotencyKey ?? null,
        p_payload_fingerprint: fingerprint,
    });
    if (error) {
        log.error({ err: error, input }, 'grantMinutes failed');
        if (error.message?.includes('coldcall_idempotency_payload_mismatch')) {
            throw new AppError('Idempotency anahtarı farklı bir kredi isteğinde kullanılmış', 409);
        }
        throw new AppError('Kredi yüklenemedi', 500);
    }
    return Number(data);
}

export async function getBalance(tenantId: string): Promise<number> {
    const { data, error } = await supabaseAdmin
        .from('coldcall_settings')
        .select('minutes_balance')
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (error || !data) {
        log.error({ err: error, tenantId }, 'getBalance failed');
        return 0;
    }
    return Number(data.minutes_balance);
}

/**
 * "Bu ay kullanılan" — bilgi amaçlı (gating BURADA değil, gating minutes_balance
 * üzerinden). DB tarafı aggregate (coldcall_used_this_period RPC, wallet migration'ı) —
 * JS'te satır çekip reduce etmek PostgREST satır limitinde toplamı eksik verebiliyordu (codex P2).
 */
export async function usedThisPeriod(tenantId: string): Promise<number> {
    const { data, error } = await supabaseAdmin.rpc('coldcall_used_this_period', { p_tenant_id: tenantId });
    if (error) {
        log.error({ err: error, tenantId }, 'usedThisPeriod failed');
        return 0;
    }
    return Math.round(Math.abs(Number(data ?? 0)) * 100) / 100;
}
