/**
 * Mock provider — Twilio hesabı olmadan uçtan uca demo.
 * Numara arama/satın alma sahte SID'lerle çalışır; çağrı yaşam döngüsü
 * sunucuda timer'larla simüle edilir (client durum poll'lar).
 *
 * Deterministik sonuç kuralı (demo edilebilirlik için):
 *   aranan numaranın SON hanesi 9 → no_answer, 8 → busy, diğerleri → cevaplanır.
 * Cevaplanan çağrı kullanıcı kapatana kadar sürer (tavan 75 sn → karşı taraf kapatır).
 */
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createLogger } from '../../lib/logger.js';
import { finalizeCall } from '../lib/finalize.js';
import { runMockPostCallPipeline } from '../lib/pipeline.js';
import { countryByCode, primaryNumberOffer } from '../data/countryPricing.js';
import type { AvailableNumber, ColdcallCallRow, ColdcallSettingsRow, PurchasedNumber, TelephonyProvider } from './types.js';

const log = createLogger('coldcall:mock');

const RING_MS = 2_500;
const NO_ANSWER_MS = 6_000;
const BUSY_MS = 2_000;
const MAX_TALK_MS = 75_000;

// callId → aktif timer'lar (restart'ta kaybolur; finalize.sweepStaleCalls telafi eder)
const timers = new Map<string, NodeJS.Timeout[]>();

function clearTimers(callId: string): void {
    for (const t of timers.get(callId) ?? []) clearTimeout(t);
    timers.delete(callId);
}

function addTimer(callId: string, t: NodeJS.Timeout): void {
    const list = timers.get(callId) ?? [];
    list.push(t);
    timers.set(callId, list);
}

/**
 * Guard'lı durum geçişi (codex P1): yalnız beklenen non-terminal durumlardan
 * geçiş yapar; hangup ile timer callback'i yarışırsa terminal durum ASLA ezilmez.
 * Dönüş: geçiş gerçekleşti mi.
 */
async function setStatus(
    callId: string,
    status: string,
    extra: Record<string, unknown>,
    fromStatuses: string[]
): Promise<boolean> {
    const { data, error } = await supabaseAdmin
        .from('coldcall_calls')
        .update({ status, ...extra })
        .eq('id', callId)
        .in('status', fromStatuses)
        .select('id')
        .maybeSingle();
    if (error) {
        log.error({ err: error, callId, status }, 'mock status update failed');
        return false;
    }
    return !!data;
}

async function loadCall(callId: string): Promise<ColdcallCallRow | null> {
    const { data } = await supabaseAdmin.from('coldcall_calls').select('*').eq('id', callId).maybeSingle();
    return (data as ColdcallCallRow) ?? null;
}

export const mockProvider: TelephonyProvider = {
    name: 'mock',
    callMode: 'simulated',

    async searchNumbers(_settings, country, contains) {
        const info = countryByCode(country);
        if (!info || !primaryNumberOffer(info.numbers)) return [];
        const results: AvailableNumber[] = [];
        for (let i = 0; i < 8; i++) {
            let national = '';
            while (national.length < 9) national += Math.floor(Math.random() * 10);
            if (contains) national = contains.replace(/\D/g, '').slice(0, 6) + national.slice(contains.length);
            const e164 = `${info.dialCode}${national.slice(0, 10 - Math.min(info.dialCode.length - 1, 4))}`;
            results.push({
                e164,
                friendly_name: `${info.dialCode} ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6, 9)}`,
                locality: info.nameEn,
            });
        }
        return results;
    },

    async purchaseNumber(_settings, e164, country) {
        const info = countryByCode(country);
        const primary = info ? primaryNumberOffer(info.numbers) : null;
        return {
            provider_sid: `PN_mock_${randomUUID()}`,
            e164,
            status: primary && primary.docStatus !== 'docless' ? 'pending_regulatory' : 'active',
        } as PurchasedNumber;
    },

    async releaseNumber() {
        // no-op — mock envanterinde tutulacak bir şey yok
    },

    async placeCall(call: ColdcallCallRow, settings: ColdcallSettingsRow) {
        const sid = `CA_mock_${randomUUID()}`;
        await setStatus(call.id, 'ringing', { provider_call_sid: sid }, ['queued']);

        const lastDigit = call.to_e164.replace(/\D/g, '').slice(-1);
        const announce = settings.recording_mode === 'announce';
        const record = call.recording_enabled_snapshot === true;

        const ringTimer = setTimeout(async () => {
            if (lastDigit === '9') {
                const t = setTimeout(async () => {
                    const fresh = await loadCall(call.id);
                    if (fresh) await finalizeCall(fresh, { status: 'no_answer' });
                    clearTimers(call.id);
                }, NO_ANSWER_MS);
                addTimer(call.id, t);
                return;
            }
            if (lastDigit === '8') {
                const t = setTimeout(async () => {
                    const fresh = await loadCall(call.id);
                    if (fresh) await finalizeCall(fresh, { status: 'busy' });
                    clearTimers(call.id);
                }, BUSY_MS);
                addTimer(call.id, t);
                return;
            }

            // Cevaplandı — guard'lı geçiş: hangup yarışı kazandıysa (terminal)
            // görüşmeyi YENİDEN AÇMA, timer'ları bırak (codex P1)
            const answeredAt = new Date().toISOString();
            const answered = await setStatus(call.id, 'in_progress', { answered_at: answeredAt }, ['queued', 'ringing']);
            if (!answered) {
                clearTimers(call.id);
                return;
            }

            // Karşı taraf en geç MAX_TALK_MS sonra kapatır
            const hangTimer = setTimeout(async () => {
                const fresh = await loadCall(call.id);
                clearTimers(call.id);
                if (!fresh) return;
                const finalized = await finalizeCall(fresh, { status: 'completed', withRecording: record });
                if (finalized && record && finalized.duration_sec) {
                    void runMockPostCallPipeline(finalized, announce);
                }
            }, MAX_TALK_MS);
            addTimer(call.id, hangTimer);
        }, RING_MS);
        addTimer(call.id, ringTimer);
    },

    async hangupCall(call: ColdcallCallRow, settings: ColdcallSettingsRow) {
        clearTimers(call.id);
        const fresh = await loadCall(call.id);
        if (!fresh) return;
        const record = fresh.recording_enabled_snapshot === true;
        const announce = settings.recording_mode === 'announce';
        const wasAnswered = fresh.status === 'in_progress' && fresh.answered_at;
        const finalized = await finalizeCall(fresh, {
            status: wasAnswered ? 'completed' : 'canceled',
            withRecording: !!wasAnswered && record,
        });
        if (finalized && wasAnswered && record && finalized.duration_sec) {
            void runMockPostCallPipeline(finalized, announce);
        }
    },
};
