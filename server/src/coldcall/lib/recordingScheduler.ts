import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { decrypt } from '../../lib/encryption.js';
import { createLogger } from '../../lib/logger.js';
import { masterAuth } from '../providers/twilio.js';
import type { ColdcallCallRow, ColdcallSettingsRow } from '../providers/types.js';
import { runTwilioRecordingPipeline } from './pipeline.js';

const log = createLogger('coldcall:recordingQueue');
const TICK_MS = 15_000;
const LEASE_SECONDS = 300;
const RENEW_MS = 60_000;
let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

interface RecordingJob {
    id: string;
    call_id: string;
    tenant_id: string;
    provider_recording_sid: string;
    recording_source_url: string;
    duration_sec: number | null;
}

function assertCanonicalRecordingSource(job: RecordingJob, settings: ColdcallSettingsRow): void {
    if (!settings.subaccount_sid || !/^AC[0-9a-fA-F]{32}$/.test(settings.subaccount_sid)
        || !/^RE[0-9a-fA-F]{32}$/.test(job.provider_recording_sid)) {
        throw new Error('recording provider identity is invalid');
    }
    const expected = `https://api.twilio.com/2010-04-01/Accounts/${settings.subaccount_sid}/Recordings/${job.provider_recording_sid}`;
    if (job.recording_source_url !== expected) throw new Error('recording source URL is not canonical');
}

function providerAuthHeader(settings: ColdcallSettingsRow): string {
    const auth = masterAuth();
    if (auth.kind === 'auth_token') {
        return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
    }
    if (!settings.api_key_sid || !settings.api_key_secret_enc) {
        throw new Error('tenant subaccount API key is unavailable');
    }
    return `Basic ${Buffer.from(`${settings.api_key_sid}:${decrypt(settings.api_key_secret_enc)}`).toString('base64')}`;
}

async function finish(jobId: string, lease: string, success: boolean, error?: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const { data, error: finishError } = await supabaseAdmin.rpc('coldcall_finish_recording_job', {
        p_recording_id: jobId, p_lease: lease, p_success: success, p_error: success ? null : message,
    });
    if (finishError || !data) {
        throw new Error(`recording job completion lost lease: ${finishError?.message ?? 'fence rejected'}`);
    }
}

async function processOne(): Promise<boolean> {
    const lease = randomUUID();
    const { data, error } = await supabaseAdmin.rpc('coldcall_claim_recording_job', {
        p_lease: lease, p_lease_seconds: LEASE_SECONDS,
    });
    if (error) throw error;
    const job = ((data as RecordingJob[] | null) ?? [])[0];
    if (!job) return false;

    const assertLease = async (): Promise<void> => {
        const { data: renewed, error: renewError } = await supabaseAdmin.rpc('coldcall_renew_recording_job', {
            p_recording_id: job.id, p_lease: lease, p_lease_seconds: LEASE_SECONDS,
        });
        if (renewError || !renewed) throw new Error(`recording lease lost: ${renewError?.message ?? 'fence rejected'}`);
    };
    const renewal = setInterval(() => {
        void assertLease().catch((renewError) => {
            log.error({ err: renewError, jobId: job.id }, 'recording lease renewal failed');
        });
    }, RENEW_MS);
    renewal.unref?.();

    try {
        const [callResult, settingsResult] = await Promise.all([
            supabaseAdmin.from('coldcall_calls').select('*').eq('id', job.call_id).eq('tenant_id', job.tenant_id).single(),
            supabaseAdmin.from('coldcall_settings').select('*').eq('tenant_id', job.tenant_id).single(),
        ]);
        if (callResult.error || !callResult.data) throw new Error(`recording call load failed: ${callResult.error?.message ?? 'missing'}`);
        if (settingsResult.error || !settingsResult.data) throw new Error(`recording settings load failed: ${settingsResult.error?.message ?? 'missing'}`);
        if (!job.recording_source_url || !job.provider_recording_sid) throw new Error('recording job payload is incomplete');
        assertCanonicalRecordingSource(job, settingsResult.data as ColdcallSettingsRow);
        await runTwilioRecordingPipeline(
            callResult.data as ColdcallCallRow,
            job.recording_source_url,
            job.provider_recording_sid,
            Number(job.duration_sec ?? 0),
            providerAuthHeader(settingsResult.data as ColdcallSettingsRow),
            job.id,
            assertLease,
        );
        await finish(job.id, lease, true);
    } catch (jobError) {
        log.error({ err: jobError, jobId: job.id }, 'recording job failed');
        try {
            await finish(job.id, lease, false, jobError);
        } catch (finishError) {
            log.error({ err: finishError, jobId: job.id }, 'recording failure could not be fenced');
        }
    } finally {
        clearInterval(renewal);
    }
    return true;
}

export function startColdcallRecordingScheduler(): void {
    if (interval) return;
    interval = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            for (let processed = 0; processed < 4 && await processOne(); processed += 1) {
                // bounded drain per tick
            }
        } catch (err) {
            log.error({ err }, 'recording queue tick failed');
        } finally {
            running = false;
        }
    }, TICK_MS);
    interval.unref?.();
}
