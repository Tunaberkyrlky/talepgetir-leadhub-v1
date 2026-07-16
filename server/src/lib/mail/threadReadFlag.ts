/**
 * Faz 4 rollout flag (plans/MAIL_THREAD_PLAN.md): which tenants READ the unified
 * thread model (get_threads_v2, grouped by email_replies.thread_id) vs the legacy
 * grouping by (sender_email, campaign_id).
 *
 * Env `THREAD_V2_TENANTS`: comma-separated tenant ids, or `*` for all tenants.
 * Unset/empty → everyone stays on v1 (safe default). Lets us roll out tenant by
 * tenant and roll back instantly by editing the env — no deploy of code changes.
 */
export function useThreadV2(tenantId: string | null | undefined): boolean {
    const cfg = process.env.THREAD_V2_TENANTS?.trim();
    if (!cfg || !tenantId) return false;
    if (cfg === '*') return true;
    return cfg.split(',').map((s) => s.trim()).filter(Boolean).includes(tenantId);
}
