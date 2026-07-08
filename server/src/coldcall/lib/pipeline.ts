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
    authHeader: string
): Promise<void> {
    try {
        const res = await fetch(`${recordingUrl}.wav`, { headers: { Authorization: authHeader } });
        if (!res.ok) throw new Error(`recording download http ${res.status}`);
        const audio = Buffer.from(await res.arrayBuffer());
        const recordingId = await storeRecording(call, audio, durationSec, 'audio/wav', recordingSid);

        // Kayıt bizim Storage'a indi → Twilio'daki kopyayı sil (veri kontrolü + maliyet)
        try {
            await fetch(recordingUrl, { method: 'DELETE', headers: { Authorization: authHeader } });
        } catch (err) {
            log.warn({ err, recordingSid }, 'twilio recording delete failed (non-fatal)');
        }

        const stt = await deepgramTranscribe(audio);
        if (!stt) {
            await supabaseAdmin.from('coldcall_transcripts').upsert(
                {
                    call_id: call.id,
                    tenant_id: call.tenant_id,
                    recording_id: recordingId,
                    provider: 'deepgram',
                    status: 'failed',
                },
                { onConflict: 'call_id' }
            );
            return;
        }
        await writeTranscriptAndSummary(call, recordingId, stt.segments, stt.language, 'deepgram');
    } catch (err) {
        log.error({ err, callId: call.id }, 'twilio recording pipeline failed');
        await supabaseAdmin
            .from('coldcall_recordings')
            .update({ status: 'failed' })
            .eq('call_id', call.id)
            .eq('status', 'processing');
    }
}

async function storeRecording(
    call: ColdcallCallRow,
    audio: Buffer,
    durationSec: number,
    contentType: string,
    providerSid: string
): Promise<string | null> {
    const path = `${call.tenant_id}/${call.id}.wav`;

    const { data: recRow, error: insErr } = await supabaseAdmin
        .from('coldcall_recordings')
        .insert({
            call_id: call.id,
            tenant_id: call.tenant_id,
            provider_recording_sid: providerSid,
            storage_path: path,
            duration_sec: durationSec,
            channels: 2,
            status: 'processing',
        })
        .select('id')
        .single();
    if (insErr) {
        log.error({ err: insErr, callId: call.id }, 'recording row insert failed');
        return null;
    }

    const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, audio, {
        contentType,
        upsert: true,
    });
    await supabaseAdmin
        .from('coldcall_recordings')
        .update({ status: upErr ? 'failed' : 'stored' })
        .eq('id', recRow.id);
    if (upErr) {
        log.error({ err: upErr, callId: call.id }, 'recording upload failed');
        return null;
    }
    return recRow.id as string;
}

async function writeTranscriptAndSummary(
    call: ColdcallCallRow,
    recordingId: string | null,
    segments: TranscriptSegment[],
    language: string,
    provider: string
): Promise<void> {
    const fullText = segments.map((s) => `${s.speaker === 'agent' ? 'AGENT' : 'LEAD'}: ${s.text}`).join('\n');
    const { error: tErr } = await supabaseAdmin.from('coldcall_transcripts').upsert(
        {
            call_id: call.id,
            tenant_id: call.tenant_id,
            recording_id: recordingId,
            provider,
            language,
            segments,
            full_text: fullText,
            status: 'pending',
            updated_at: new Date().toISOString(),
        },
        { onConflict: 'call_id' }
    );
    if (tErr) {
        log.error({ err: tErr, callId: call.id }, 'transcript upsert failed');
        return;
    }

    const summary = await summarizeTranscript(segments, language);
    const { error: sErr } = await supabaseAdmin
        .from('coldcall_transcripts')
        .update({
            summary: summary.summary,
            action_items: summary.action_items,
            sentiment: summary.sentiment,
            status: 'done',
            updated_at: new Date().toISOString(),
        })
        .eq('call_id', call.id);
    if (sErr) log.error({ err: sErr, callId: call.id }, 'summary update failed');
    else log.info({ callId: call.id, provider: summary.provider }, 'transcript + AI summary ready');
}

interface SttResult { segments: TranscriptSegment[]; language: string }

/** Deepgram STT — dual-channel (multichannel): kanal 0 = agent, kanal 1 = lead. */
async function deepgramTranscribe(audio: Buffer): Promise<SttResult | null> {
    const key = process.env.DEEPGRAM_KEY || process.env.DEEPGRAM_API;
    if (!key) {
        log.warn('DEEPGRAM_KEY not set — real STT unavailable');
        return null;
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
        const segments: TranscriptSegment[] = utterances.map((u) => ({
            speaker: u.channel === 0 ? 'agent' : 'lead',
            start_sec: Math.round(u.start * 10) / 10,
            end_sec: Math.round(u.end * 10) / 10,
            text: u.transcript,
        }));
        return { segments, language: body.results?.channels?.[0]?.detected_language ?? 'en' };
    } catch (err) {
        log.error({ err }, 'deepgram transcription failed');
        return null;
    }
}
