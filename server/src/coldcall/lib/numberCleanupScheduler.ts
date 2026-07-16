import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createLogger } from '../../lib/logger.js';
import { providerFor } from '../providers/index.js';
import type { ColdcallSettingsRow } from '../providers/types.js';

const log = createLogger('coldcall:numberCleanup');
let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

interface CleanupJob {
    id: string;
    tenant_id: string;
    e164: string;
    status: 'purchase_unknown' | 'release_pending';
    provider_sid: string | null;
    cleanup_attempts: number;
    provider: 'mock' | 'twilio';
}

async function processOne(): Promise<boolean> {
    const lease = randomUUID();
    const { data, error } = await supabaseAdmin.rpc('coldcall_claim_number_cleanup', {
        p_lease: lease, p_seconds: 300,
    });
    if (error) throw error;
    const job = ((data as CleanupJob[] | null) ?? [])[0];
    if (!job) return false;
    try {
        const { data: settings, error: settingsError } = await supabaseAdmin.from('coldcall_settings')
            .select('*').eq('tenant_id', job.tenant_id).single();
        if (settingsError || !settings) throw new Error(settingsError?.message ?? 'settings missing');
        const scopedSettings = { ...(settings as ColdcallSettingsRow), provider: job.provider };
        const provider = providerFor(scopedSettings);
        const owned = await provider.findOwnedNumber(scopedSettings, job.e164);
        if (job.status === 'purchase_unknown') {
            if (!owned && job.cleanup_attempts < 3) {
                throw new Error('ownership not yet visible; delayed confirmation required');
            }
            const { data: finished, error: finishError } = await supabaseAdmin.rpc('coldcall_finish_number_reconciliation', {
                p_number_id: job.id, p_lease: lease, p_owned: !!owned,
                p_provider_sid: owned?.provider_sid ?? null, p_error: null,
            });
            if (finishError || !finished) throw new Error(finishError?.message ?? 'reconciliation lease lost');
        } else {
            if (owned) await provider.releaseNumber(scopedSettings, owned.provider_sid);
            const { data: finished, error: finishError } = await supabaseAdmin.rpc('coldcall_finish_number_cleanup', {
                p_number_id: job.id, p_lease: lease, p_success: true, p_error: null,
            });
            if (finishError || !finished) throw new Error(finishError?.message ?? 'cleanup lease lost');
        }
    } catch (jobError) {
        const message = jobError instanceof Error ? jobError.message : String(jobError);
        const rpc = job.status === 'purchase_unknown' ? 'coldcall_finish_number_reconciliation' : 'coldcall_finish_number_cleanup';
        const args = job.status === 'purchase_unknown'
            ? { p_number_id: job.id, p_lease: lease, p_owned: false, p_provider_sid: null, p_error: message }
            : { p_number_id: job.id, p_lease: lease, p_success: false, p_error: message };
        await supabaseAdmin.rpc(rpc, args);
        log.error({ err: jobError, numberId: job.id }, 'number reconciliation failed');
    }
    return true;
}

export function startColdcallNumberCleanupScheduler(): void {
    if (interval) return;
    interval = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            for (let count = 0; count < 4 && await processOne(); count += 1) {
                // bounded drain
            }
        } catch (err) {
            log.error({ err }, 'number cleanup tick failed');
        } finally {
            running = false;
        }
    }, 30_000);
    interval.unref?.();
}
