/**
 * Çağrı sonrası pipeline: kayıt → Storage → transkript → AI özet.
 * Fire-and-forget çalışır (long-lived Node); her adım kendi status'unu yazar,
 * hiçbir adım çağrının kendisini bloklamaz. Twilio yolunda ses webhook'tan
 * indirilir; mock yolunda WAV sentezlenir. STT: mock → şablon transkript,
 * gerçek ses → Deepgram (DEEPGRAM_KEY yoksa transkript 'failed' kalır, kayıt durur).
 */
import { supabaseAdmin } from '../../lib/supabase.js';
import { createLogger } from '../../lib/logger.js';
import { generateStereoWav } from './mockAudio.js';
import { generateMockTranscript, type TranscriptSegment } from './mockTranscript.js';
import { summarizeTranscript } from './summarize.js';
import type { ColdcallCallRow } from '../providers/types.js';

const log = createLogger('coldcall:pipeline');
const BUCKET = 'coldcall-recordings';

interface CompanyContext {
    companyName?: string | null;
    contactName?: string | null;
}

async function loadContext(call: ColdcallCallRow): Promise<CompanyContext> {
    const ctx: CompanyContext = {};
    if (call.company_id) {
        const { data } = await supabaseAdmin.from('companies').select('name').eq('id', call.company_id).maybeSingle();
        ctx.companyName = data?.name ?? null;
    }
    if (call.contact_id) {
        const { data } = await supabaseAdmin.from('contacts').select('full_name, first_name, last_name').eq('id', call.contact_id).maybeSingle();
        ctx.contactName = (data as { full_name?: string; first_name?: string; last_name?: string } | null)?.full_name
            || [ (data as { first_name?: string } | null)?.first_name, (data as { last_name?: string } | null)?.last_name ].filter(Boolean).join(' ')
            || null;
    }
    return ctx;
}

/** Mock çağrı: transkripti üret, sesi transkriptle hizalı sentezle, depola, özetle. */
export async function runMockPostCallPipeline(call: ColdcallCallRow, announce: boolean): Promise<void> {
    try {
        const durationSec = call.duration_sec ?? 30;
        const ctx = await loadContext(call);
        const { segments, language } = generateMockTranscript({
            durationSec,
            companyName: ctx.companyName,
            contactName: ctx.contactName,
            toCountry: call.to_country,
            announce,
        });
        const audioDuration = Math.max(durationSec, Math.ceil(segments[segments.length - 1]?.end_sec ?? durationSec));
        const wav = generateStereoWav(audioDuration, segments);
        const recordingId = await storeRecording(call, wav, audioDuration, 'audio/wav', `MOCK_RE_${call.id}`);
        await writeTranscriptAndSummary(call, recordingId, segments, language, 'mock');
    } catch (err) {
        log.error({ err, callId: call.id }, 'mock post-call pipeline failed');
    }
}

/** Twilio kaydı: sesi indir, depola, (varsa) STT + özet. */
export async function runTwilioRecordingPipeline(
    call: ColdcallCallRow,
    recordingUrl: string,
    recordingSid: string,
    durationSec: number,
    authHeader: string,
    claimedRecordingId?: string,
    assertLease?: () => Promise<void>
): Promise<void> {
    try {
        let recordingId = claimedRecordingId;
        let audio: Buffer;
        if (claimedRecordingId) {
            const { data: existing, error: existingError } = await supabaseAdmin.from('coldcall_recordings')
                .select('status,storage_path').eq('id', claimedRecordingId).eq('tenant_id', call.tenant_id).single();
            if (existingError) throw new Error(`recording resume lookup failed: ${existingError.message}`);
            if (existing.status === 'stored' && existing.storage_path) {
                const { data: storedAudio, error: downloadError } = await supabaseAdmin.storage.from(BUCKET).download(existing.storage_path);
                if (downloadError || !storedAudio) throw new Error(`stored recording resume failed: ${downloadError?.message ?? 'missing'}`);
                audio = Buffer.from(await storedAudio.arrayBuffer());
            } else {
                const res = await fetch(`${recordingUrl}.wav`, { headers: { Authorization: authHeader } });
                if (!res.ok) throw new Error(`recording download http ${res.status}`);
                audio = Buffer.from(await res.arrayBuffer());
                recordingId = await storeRecording(call, audio, durationSec, 'audio/wav', recordingSid, claimedRecordingId);
            }
        } else {
            const res = await fetch(`${recordingUrl}.wav`, { headers: { Authorization: authHeader } });
            if (!res.ok) throw new Error(`recording download http ${res.status}`);
            audio = Buffer.from(await res.arrayBuffer());
            recordingId = await storeRecording(call, audio, durationSec, 'audio/wav', recordingSid);
        }
        if (!recordingId) throw new Error('recording row missing after durable storage');
        await assertLease?.();
        const { data: existingTranscript, error: transcriptLoadError } = await supabaseAdmin
            .from('coldcall_transcripts')
            .select('status,segments,language,provider')
            .eq('call_id', call.id).eq('tenant_id', call.tenant_id).maybeSingle();
        if (transcriptLoadError) throw new Error(`transcript resume lookup failed: ${transcriptLoadError.message}`);
        if (existingTranscript?.status === 'done' || existingTranscript?.status === 'failed') {
            await deleteProviderRecording(recordingUrl, recordingSid, authHeader);
            return;
        }
        if (existingTranscript?.status === 'pending' && Array.isArray(existingTranscript.segments)
            && existingTranscript.segments.length > 0 && existingTranscript.language) {
            await summarizeAndPersist(
                call,
                existingTranscript.segments as TranscriptSegment[],
                existingTranscript.language,
                existingTranscript.provider ?? 'deepgram',
                assertLease,
            );
            await deleteProviderRecording(recordingUrl, recordingSid, authHeader);
            return;
        }

        const stt = await deepgramTranscribe(audio);
        if ('terminalFailure' in stt) {
            await persistTerminalSttFailure(call, recordingId);
            await deleteProviderRecording(recordingUrl, recordingSid, authHeader);
            return;
        }
        await assertLease?.();
        await writeTranscriptAndSummary(call, recordingId, stt.segments, stt.language, 'deepgram', assertLease);
        await deleteProviderRecording(recordingUrl, recordingSid, authHeader);
    } catch (err) {
        log.error({ err, callId: call.id }, 'twilio recording pipeline failed');
        await supabaseAdmin
            .from('coldcall_recordings')
            .update({ status: 'failed' })
            .eq('call_id', call.id)
            .eq('status', 'processing');
        throw err;
    }
}

async function deleteProviderRecording(recordingUrl: string, recordingSid: string, authHeader: string): Promise<void> {
    try {
        await fetch(recordingUrl, { method: 'DELETE', headers: { Authorization: authHeader } });
    } catch (err) {
        log.warn({ err, recordingSid }, 'twilio recording delete failed (non-fatal)');
    }
}

async function persistTerminalSttFailure(call: ColdcallCallRow, recordingId: string): Promise<void> {
    const { data: existing, error: existingError } = await supabaseAdmin.from('coldcall_transcripts')
        .select('status').eq('call_id', call.id).eq('tenant_id', call.tenant_id).maybeSingle();
    if (existingError) throw new Error(`terminal STT state check failed: ${existingError.message}`);
    if (existing?.status === 'done' || existing?.status === 'failed') return;
    const row = {
        call_id: call.id,
        tenant_id: call.tenant_id,
        recording_id: recordingId,
        provider: 'deepgram',
        status: 'failed',
        updated_at: new Date().toISOString(),
    };
    const { error } = existing
        ? await supabaseAdmin.from('coldcall_transcripts').update(row)
            .eq('call_id', call.id).eq('tenant_id', call.tenant_id).eq('status', 'pending')
        : await supabaseAdmin.from('coldcall_transcripts').insert(row);
    if (error) throw new Error(`failed to persist terminal STT failure: ${error.message}`);
}

async function storeRecording(
    call: ColdcallCallRow,
    audio: Buffer,
    durationSec: number,
    contentType: string,
    providerSid: string,
    claimedRecordingId?: string
): Promise<string> {
    const path = `${call.tenant_id}/${call.id}.wav`;

    let recordingId = claimedRecordingId;
    if (!recordingId) {
        const { data: recRow, error: insErr } = await supabaseAdmin
            .from('coldcall_recordings')
            .insert({
                call_id: call.id, tenant_id: call.tenant_id, provider_recording_sid: providerSid,
                storage_path: path, duration_sec: durationSec, channels: 2, status: 'processing',
            })
            .select('id').single();
        if (insErr) {
            log.error({ err: insErr, callId: call.id }, 'recording row insert failed');
            throw new Error(`recording row insert failed: ${insErr.message}`);
        }
        recordingId = recRow.id as string;
    } else {
        const { error } = await supabaseAdmin.from('coldcall_recordings')
            .update({ storage_path: path, duration_sec: durationSec, channels: 2, status: 'processing' })
            .eq('id', recordingId).eq('tenant_id', call.tenant_id);
        if (error) throw new Error(`claimed recording update failed: ${error.message}`);
    }

    const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, audio, {
        contentType,
        upsert: true,
    });
    const { error: statusError } = await supabaseAdmin
        .from('coldcall_recordings')
        .update({ status: upErr ? 'failed' : 'stored' })
        .eq('id', recordingId);
    if (upErr) {
        log.error({ err: upErr, callId: call.id }, 'recording upload failed');
        throw new Error(`recording upload failed: ${upErr.message}`);
    }
    if (statusError) throw new Error(`recording durable status update failed: ${statusError.message}`);
    return recordingId;
}

async function writeTranscriptAndSummary(
    call: ColdcallCallRow,
    recordingId: string | null,
    segments: TranscriptSegment[],
    language: string,
    provider: string,
    assertLease?: () => Promise<void>
): Promise<void> {
    const fullText = segments.map((s) => `${s.speaker === 'agent' ? 'AGENT' : 'LEAD'}: ${s.text}`).join('\n');
    const transcriptRow = {
            call_id: call.id,
            tenant_id: call.tenant_id,
            recording_id: recordingId,
            provider,
            language,
            segments,
            full_text: fullText,
            status: 'pending',
            updated_at: new Date().toISOString(),
        };
    const { data: existing, error: existingError } = await supabaseAdmin.from('coldcall_transcripts')
        .select('status').eq('call_id', call.id).eq('tenant_id', call.tenant_id).maybeSingle();
    if (existingError) throw new Error(`transcript state check failed: ${existingError.message}`);
    if (existing?.status === 'done' || existing?.status === 'failed') return;
    const { error: tErr } = existing
        ? await supabaseAdmin.from('coldcall_transcripts').update(transcriptRow)
            .eq('call_id', call.id).eq('tenant_id', call.tenant_id).eq('status', 'pending')
        : await supabaseAdmin.from('coldcall_transcripts').insert(transcriptRow);
    if (tErr) {
        log.error({ err: tErr, callId: call.id }, 'transcript upsert failed');
        throw new Error(`transcript upsert failed: ${tErr.message}`);
    }

    await assertLease?.();
    await summarizeAndPersist(call, segments, language, provider, assertLease);
}

async function summarizeAndPersist(
    call: ColdcallCallRow,
    segments: TranscriptSegment[],
    language: string,
    provider: string,
    assertLease?: () => Promise<void>
): Promise<void> {
    await assertLease?.();
    const summary = await summarizeTranscript(segments, language);
    await assertLease?.();
    const { error: sErr } = await supabaseAdmin
        .from('coldcall_transcripts')
        .update({
            summary: summary.summary,
            action_items: summary.action_items,
            sentiment: summary.sentiment,
            status: 'done',
            updated_at: new Date().toISOString(),
        })
        .eq('call_id', call.id)
        .eq('tenant_id', call.tenant_id)
        .eq('status', 'pending');
    if (sErr) {
        log.error({ err: sErr, callId: call.id }, 'summary update failed');
        throw new Error(`summary update failed: ${sErr.message}`);
    }
    else log.info({ callId: call.id, provider: summary.provider ?? provider }, 'transcript + AI summary ready');
}

interface SttResult { segments: TranscriptSegment[]; language: string }
interface TerminalSttFailure { terminalFailure: 'unavailable' | 'no_utterances' }

/** Deepgram STT — dual-channel (multichannel): kanal 0 = agent, kanal 1 = lead. */
async function deepgramTranscribe(audio: Buffer): Promise<SttResult | TerminalSttFailure> {
    const key = process.env.DEEPGRAM_KEY || process.env.DEEPGRAM_API;
    if (!key) {
        log.warn('DEEPGRAM_KEY not set — real STT unavailable');
        return { terminalFailure: 'unavailable' };
    }
    try {
        const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&multichannel=true&punctuate=true&detect_language=true&utterances=true', {
            method: 'POST',
            headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' },
            body: new Uint8Array(audio),
        });
        if (!res.ok) throw new Error(`deepgram http ${res.status}`);
        const body = (await res.json()) as {
            results?: {
                utterances?: Array<{ channel: number; start: number; end: number; transcript: string }>;
                channels?: Array<{ detected_language?: string }>;
            };
        };
        const utterances = body.results?.utterances ?? [];
        // Boş sonuç = STT başarısız (codex P2): kayıt var ama hiç konuşma
        // çıkarılamadıysa transkripti 'failed' işaretle; boş 'done' üretip
        // heuristik özetin "görüşülemedi" demesine izin verme (yanıltıcı olur).
        if (utterances.length === 0) {
            log.warn('deepgram returned no utterances — treating as STT failure');
            return { terminalFailure: 'no_utterances' };
        }
        const segments: TranscriptSegment[] = utterances.map((u) => ({
            speaker: u.channel === 0 ? 'agent' : 'lead',
            start_sec: Math.round(u.start * 10) / 10,
            end_sec: Math.round(u.end * 10) / 10,
            text: u.transcript,
        }));
        return { segments, language: body.results?.channels?.[0]?.detected_language ?? 'en' };
    } catch (err) {
        log.error({ err }, 'deepgram transcription failed');
        throw err;
    }
}
