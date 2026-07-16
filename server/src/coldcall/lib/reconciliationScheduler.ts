import { supabaseAdmin } from '../../lib/supabase.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('coldcall:reconciliation');
const INTERVAL_MS = 60_000;
let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startColdcallReconciliationScheduler(): void {
    if (interval) return;
    interval = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            const { data, error } = await supabaseAdmin.rpc('coldcall_reconcile_usage', { p_limit: 100 });
            if (error) throw error;
            if (Number(data) > 0) log.warn({ reconciled: Number(data) }, 'reconciled missing usage debits');
        } catch (err) {
            log.error({ err }, 'reconciliation tick failed');
        } finally {
            running = false;
        }
    }, INTERVAL_MS);
    interval.unref?.();
}
