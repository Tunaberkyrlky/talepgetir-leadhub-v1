/**
 * Fresh role resolution for COST-bearing surfaces (068 rule: customers NEVER see dollars).
 *
 * The auth middleware caches role resolution for 60s — long enough for a demoted operator to keep
 * receiving UNSANITIZED job rows (raw COGS) from the research API. Every place that branches on
 * "internal sees dollars" must therefore use the EFFECTIVE role from here, which re-verifies an
 * internal claim against the source of truth on every request:
 *   • 'ops_agent'   → must hold an is_active ops_agent membership RIGHT NOW (DB read, no cache);
 *   • 'superadmin'  → re-read auth.users app_metadata via the admin API (the cached getUser body
 *                     is what went stale).
 * A claim that fails verification degrades to 'client_viewer' (sanitized view / 403 on admin).
 * Customer roles pass through untouched — no extra reads on the hot customer path.
 */
import { supabaseAdmin } from '../supabase.js';
import { isInternalRole } from '../roles.js';
import { createLogger } from '../logger.js';

const log = createLogger('research:fresh-role');

/**
 * @param user     the cached auth identity (req.user)
 * @param tenantId the EFFECTIVE tenant of this request (req.tenantId) — roles are tenant-scoped,
 *                 so an ops_agent claim must hold in THIS tenant (an operator demoted in tenant A
 *                 who keeps an ops membership in tenant B must not see A's dollars).
 * Identity reads go through the CRM `supabaseAdmin` (memberships/auth are CRM-owned tables — the
 * research client may point at a dedicated research DB in the model-B split).
 */
export async function effectiveCostRole(
    user: { id: string; role: string } | undefined,
    tenantId: string | null | undefined
): Promise<string> {
    const role = user?.role ?? '';
    if (!user || !isInternalRole(role)) return role;

    try {
        if (role === 'superadmin') {
            const { data, error } = await supabaseAdmin.auth.admin.getUserById(user.id);
            if (error) throw error;
            return data?.user?.app_metadata?.is_superadmin === true ? 'superadmin' : 'client_viewer';
        }
        // ops_agent — must hold an ACTIVE ops membership in the request's effective tenant.
        if (!tenantId) return 'client_viewer';
        const { data, error } = await supabaseAdmin
            .from('memberships')
            .select('id')
            .eq('user_id', user.id)
            .eq('tenant_id', tenantId)
            .eq('role', 'ops_agent')
            .eq('is_active', true)
            .limit(1)
            .maybeSingle();
        if (error) throw error;
        return data ? 'ops_agent' : 'client_viewer';
    } catch (err) {
        // Fail CLOSED: if we cannot verify an internal claim, serve the sanitized view.
        log.error({ err, userId: user.id, cachedRole: role }, 'fresh role verification failed — degrading to client view');
        return 'client_viewer';
    }
}
