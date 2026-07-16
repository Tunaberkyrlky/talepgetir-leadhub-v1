/**
 * Çağrı sonlandırma — süre, faturalanan dakika (çarpanlı), COGS hesabı ve
 * kota işleme tek yerden. Mock lifecycle VE Twilio status webhook'u aynı
 * fonksiyonu kullanır (çifte işlemeye karşı status guard'lı).
 */
import { supabaseAdmin } from '../../lib/supabase.js';
import { createLogger } from '../../lib/logger.js';
import { countryForE164, rateFor, isBlockedRate } from '../data/countryPricing.js';
import { deductMinutes, reconcilePendingUsage } from './settings.js';
import type { ColdcallCallRow } from '../providers/types.js';

const log = createLogger('coldcall:finalize');

export const TERMINAL_STATUSES = ['completed', 'busy', 'no_answer', 'failed', 'canceled'] as const;

// İndikatif COGS bileşenleri ($/dk) — PSTN yönü countryPricing'ten (origin-aware) gelir
const CLIENT_LEG_USD_PER_MIN = 0.004;
const RECORDING_USD_PER_MIN = 0.0025;
const TRANSCRIPTION_USD_PER_MIN = 0.0043;

/**
 * Menşe (arayan numaranın ülkesi) çağrı satırındaki from_e164'ten çözülür — ekstra
 * bir coldcall_phone_numbers sorgusu gerekmez, çünkü from_e164 zaten çağrı
 * başlatılırken SEÇİLEN numaranın e164'üdür (aynı kaynak veri, drift riski yok).
 */
export function computeCogsUsd(fromE164: string, toE164: string, durationSec: number, withRecording: boolean): number {
    const originCode = countryForE164(fromE164)?.code;
    const rate = originCode ? rateFor(originCode, toE164) : undefined;
    // Bilinmeyen/blok yön: temkinli varsayım (eski davranışla tutarlı) — pratikte buraya
    // düşülmez çünkü çağrı zaten calls.ts'te callable kontrolünden geçmiş olmalı.
    const pstn = rate && !isBlockedRate(rate) ? rate.usdPerMin : (countryForE164(toE164)?.intlMobileUsd ?? 0.15);
    const minutes = Math.ceil(durationSec / 60);
    const perMin = pstn + CLIENT_LEG_USD_PER_MIN + (withRecording ? RECORDING_USD_PER_MIN + TRANSCRIPTION_USD_PER_MIN : 0);
    return Math.round(minutes * perMin * 10000) / 10000;
}

export interface FinalizeInput {
    status: 'completed' | 'busy' | 'no_answer' | 'failed' | 'canceled';
    answeredAt?: string | null;
    endedAt?: string;
    withRecording?: boolean;
    /** Sağlayıcının raporladığı süre (sn) — webhook sırası bozulup answered_at
     *  kaçmışsa bile faturalama doğru kalır (codex P2) */
    durationSecOverride?: number;
}

/**
 * Çağrıyı terminal duruma taşır. Zaten terminal ise no-op (idempotent) —
 * update, non-terminal status guard'ı ile yapılır; yarışta ilk yazan kazanır.
 * Dönüş: güncellenen satır ya da null (zaten finalize edilmişti).
 */
export async function finalizeCall(call: ColdcallCallRow, input: FinalizeInput): Promise<ColdcallCallRow | null> {
    const endedAt = input.endedAt ?? new Date().toISOString();
    const answeredAt = input.answeredAt !== undefined ? input.answeredAt : call.answered_at;

    let durationSec = 0;
    if (input.status === 'completed') {
        if (input.durationSecOverride && input.durationSecOverride > 0) {
            // Sağlayıcının kendi süresi webhook zaman damgalarından daha güvenilir
            durationSec = Math.round(input.durationSecOverride);
        } else if (answeredAt) {
            durationSec = Math.max(1, Math.round((new Date(endedAt).getTime() - new Date(answeredAt).getTime()) / 1000));
        }
    }
    const billedMinutes = durationSec > 0 ? Math.ceil(durationSec / 60) * Number(call.rate_multiplier || 1) : 0;
    const cogs = durationSec > 0 ? computeCogsUsd(call.from_e164, call.to_e164, durationSec, !!input.withRecording) : 0;

    const { data, error } = await supabaseAdmin
        .from('coldcall_calls')
        .update({
            status: input.status,
            answered_at: answeredAt,
            ended_at: endedAt,
            duration_sec: durationSec,
            billed_minutes: billedMinutes,
            cogs_usd: cogs,
        })
        .eq('id', call.id)
        .not('status', 'in', `(${TERMINAL_STATUSES.join(',')})`)
        .select('*')
        .maybeSingle();

    if (error) {
        log.error({ err: error, callId: call.id }, 'finalize update failed');
        return null;
    }
    if (!data) return null; // yarışı kaybettik — başka path finalize etmiş

    if (billedMinutes > 0) await deductMinutes(call.tenant_id, billedMinutes, call.id, 'call');
    log.info({ callId: call.id, status: input.status, durationSec, billedMinutes }, 'call finalized');
    return data as ColdcallCallRow;
}

/**
 * Takılı kalan çağrıları süpürür (ör. server restart'ında kaybolan mock timer'ları).
 * Liste/detay okumalarından önce lazy çağrılır.
 */
export async function sweepStaleCalls(tenantId: string): Promise<void> {
    // 90 dk backstop (codex): TwiML Dial timeLimit=3600 (60 dk) çağrıyı sert kapatır →
    // doğal terminal her zaman bu 90 dk eşiğinden ÖNCE gelir; sweep yalnızca gerçekten takılı
    // (crash/webhook kaybı) satırları süpürür, canlı çağrıyı asla yanlış 'failed' yapmaz.
    const cutoff = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const { error } = await supabaseAdmin
        .from('coldcall_calls')
        .update({ status: 'failed', ended_at: new Date().toISOString(), duration_sec: 0, billed_minutes: 0 })
        .eq('tenant_id', tenantId)
        .not('status', 'in', `(${TERMINAL_STATUSES.join(',')})`)
        .lt('started_at', cutoff);
    if (error) log.warn({ err: error, tenantId }, 'stale sweep failed');

    // Telafi (codex P1): finalize'da terminal olup krediyi düşülememiş çağrıları düş
    // (call_id idempotent → zaten düşülenlere dokunmaz). Best-effort, okuma yolunu bloklamaz.
    await reconcilePendingUsage(tenantId);
}
