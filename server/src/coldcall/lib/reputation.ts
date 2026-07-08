/**
 * Numara itibarı korumaları (plan §9): warm-up eğrisi, günlük tavan sayımı,
 * 7 günlük cevaplanma sağlığı. Spam labeling'in ana tetikleyicisi yeni
 * numaradan ani hacim — bu modül hem tavanı enforce etmek için sayım sağlar
 * hem de müşteriye görünür sağlık sinyali üretir (COGS içermez).
 */
import { supabaseAdmin } from '../../lib/supabase.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('coldcall:reputation');

/** Yeni numara warm-up eğrisi: yaş (gün) → günlük tavan üst sınırı */
const WARMUP_SCHEDULE: Array<{ maxAgeDays: number; cap: number }> = [
    { maxAgeDays: 3, cap: 15 },
    { maxAgeDays: 7, cap: 30 },
    { maxAgeDays: 14, cap: 60 },
];
const WARMUP_TOTAL_DAYS = 14;

export function numberAgeDays(purchasedAt: string): number {
    return Math.floor((Date.now() - new Date(purchasedAt).getTime()) / 86_400_000);
}

/** Warm-up penceresindeyse eğri tavanı, değilse tenant'ın ayarlı tavanı. */
export function effectiveDailyCap(purchasedAt: string, configuredCap: number): number {
    const age = numberAgeDays(purchasedAt);
    for (const stage of WARMUP_SCHEDULE) {
        if (age <= stage.maxAgeDays) return Math.min(configuredCap, stage.cap);
    }
    return configuredCap;
}

export function isWarming(purchasedAt: string): boolean {
    return numberAgeDays(purchasedAt) <= WARMUP_TOTAL_DAYS;
}

export type NumberHealth = 'warming' | 'good' | 'watch' | 'risk' | 'insufficient_data';

export interface NumberUsage {
    calls_today: number;
    calls_7d: number;
    answered_7d: number;
    /** completed / (completed+busy+no_answer) — canceled/failed hariç; örneklem <10 ise null */
    answer_rate_7d: number | null;
    daily_cap: number;
    remaining_today: number;
    health: NumberHealth;
}

const MIN_SAMPLE_FOR_HEALTH = 10;

function healthFor(purchasedAt: string, attempts7d: number, rate: number | null): NumberHealth {
    if (isWarming(purchasedAt)) return 'warming';
    if (rate === null || attempts7d < MIN_SAMPLE_FOR_HEALTH) return 'insufficient_data';
    if (rate >= 0.25) return 'good';
    if (rate >= 0.1) return 'watch';
    return 'risk';
}

interface NumberRowLite {
    id: string;
    purchased_at: string;
}

/** Tenant'ın numaraları için tek sorguda gün içi + 7 günlük kullanım istatistiği. */
export async function usageForNumbers(
    tenantId: string,
    numbers: NumberRowLite[],
    configuredCap: number
): Promise<Map<string, NumberUsage>> {
    const result = new Map<string, NumberUsage>();
    if (numbers.length === 0) return result;

    const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();
    // "Bugün" = UTC günü — tavan koruma amaçlıdır, dakik gün sınırı kritik değil
    const todayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';

    const { data, error } = await supabaseAdmin
        .from('coldcall_calls')
        .select('phone_number_id, status, started_at')
        .eq('tenant_id', tenantId)
        .eq('direction', 'outbound')
        .gte('started_at', since7d)
        .in('phone_number_id', numbers.map((n) => n.id));
    if (error) {
        log.error({ err: error, tenantId }, 'usage query failed');
    }

    const byNumber = new Map<string, Array<{ status: string; started_at: string }>>();
    for (const row of data ?? []) {
        if (!row.phone_number_id) continue;
        const list = byNumber.get(row.phone_number_id) ?? [];
        list.push(row);
        byNumber.set(row.phone_number_id, list);
    }

    for (const num of numbers) {
        const calls = byNumber.get(num.id) ?? [];
        const callsToday = calls.filter((c) => c.started_at >= todayStart).length;
        const answered = calls.filter((c) => c.status === 'completed').length;
        const attempts = calls.filter((c) => ['completed', 'busy', 'no_answer'].includes(c.status)).length;
        const rate = attempts >= MIN_SAMPLE_FOR_HEALTH ? answered / attempts : null;
        const cap = effectiveDailyCap(num.purchased_at, configuredCap);
        result.set(num.id, {
            calls_today: callsToday,
            calls_7d: calls.length,
            answered_7d: answered,
            answer_rate_7d: rate === null ? null : Math.round(rate * 100) / 100,
            daily_cap: cap,
            remaining_today: Math.max(0, cap - callsToday),
            health: healthFor(num.purchased_at, attempts, rate),
        });
    }
    return result;
}
