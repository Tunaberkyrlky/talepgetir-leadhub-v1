/**
 * Tenant telefoni ayarları + dakika CÜZDANI (ön-ödemeli, rollover).
 * Bakiye (minutes_balance) AY BAŞINDA SIFIRLANMAZ; admin yükler (grantMinutes),
 * çağrı biterken düşer (deductMinutes), her hareket coldcall_credit_ledger'a
 * append-only yazılır (plan COLD_CALL_CREDIT_PLAN.md §2-4).
 *
 * minutes_quota / minutes_used / period_start kolonları VESTIGIAL — DB'de durur
 * (destructive drop yok) ama bu modül artık okumaz/yazmaz.
 */
import { supabaseAdmin } from '../../lib/supabase.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import type { ColdcallSettingsRow } from '../providers/types.js';

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

/**
 * Çağrı bitişinde bakiyeden düşer — atomik + çağrı-başına idempotent RPC
 * (coldcall_deduct_minutes, migration 146). Webhook/finalize çift tetiklense
 * bile bakiye yalnız bir kez düşer (partial unique index call_id WHERE kind='usage').
 * Dönüş: yeni bakiye, ya da RPC hata verirse null (loglanır, çağıran taraf bloklamaz —
 * finalize önceki addUsedMinutes davranışıyla tutarlı, best-effort).
 */
export async function deductMinutes(tenantId: string, minutes: number, callId: string, reason = 'call'): Promise<number | null> {
    if (!minutes || minutes <= 0) return null;
    const { data, error } = await supabaseAdmin.rpc('coldcall_deduct_minutes', {
        p_tenant_id: tenantId,
        p_minutes: minutes,
        p_call_id: callId,
        p_reason: reason,
    });
    if (error) {
        log.error({ err: error, tenantId, minutes, callId }, 'deductMinutes failed');
        return null;
    }
    return Number(data);
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
    const { data, error } = await supabaseAdmin.rpc('coldcall_grant_minutes', {
        p_tenant_id: input.tenantId,
        p_minutes: input.minutes,
        p_kind: input.kind,
        p_reason: input.reason,
        p_created_by: input.createdBy ?? null,
        p_source: input.source ?? 'manual',
        p_idempotency_key: input.idempotencyKey ?? null,
    });
    if (error) {
        log.error({ err: error, input }, 'grantMinutes failed');
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
 * üzerinden). DB tarafı aggregate (coldcall_used_this_period RPC, migration 146) —
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

/**
 * Faturalanıp henüz kredi düşülmemiş çağrıları telafi eder (codex P1): finalize terminal
 * UPDATE'i geçip deductMinutes hata verirse çağrı 'completed'+billed_minutes>0 kalır ama
 * bakiye düşmez. coldcall_pending_usage_calls RPC'si bu çağrıları döner; her biri için
 * deductMinutes tekrar çağrılır (call_id idempotent → zaten düşülenlere dokunmaz).
 * sweepStaleCalls'tan (liste/detay okumaları öncesi) best-effort çağrılır.
 */
export async function reconcilePendingUsage(tenantId: string): Promise<void> {
    const { data, error } = await supabaseAdmin.rpc('coldcall_pending_usage_calls', { p_tenant_id: tenantId });
    if (error) {
        log.warn({ err: error, tenantId }, 'reconcilePendingUsage query failed');
        return;
    }
    for (const row of (data ?? []) as Array<{ call_id: string; billed_minutes: number }>) {
        const billed = Number(row.billed_minutes);
        if (billed > 0) await deductMinutes(tenantId, billed, row.call_id, 'call');
    }
}
