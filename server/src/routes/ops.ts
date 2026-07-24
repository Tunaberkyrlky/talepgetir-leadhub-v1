import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { getAccessibleTenants } from '../lib/accessibleTenants.js';
import { getHeartbeats, getHeartbeatsPublic } from '../lib/heartbeat.js';
import { APP_VERSION, STARTED_AT } from '../lib/appMeta.js';

const log = createLogger('route:ops');
const router = Router();

// IMAP polls every 5 min; 15 min without a poll = 3 missed ticks = stale.
const MAILBOX_STALE_MS = 15 * 60 * 1000;

interface MailboxConnection {
    tenant_id: string;
    email_address: string;
    provider: string | null;
    is_active: boolean;
    last_polled_at: string | null;
}

function isStaleMailbox(conn: MailboxConnection, now: number): boolean {
    if (!conn.is_active) return false;
    if (!conn.last_polled_at) return true;
    return now - new Date(conn.last_polled_at).getTime() > MAILBOX_STALE_MS;
}

// ── Overview cache ───────────────────────────────────────────────────────
// Keyed by the caller's accessible-tenant set, so superadmin and same-membership
// agents share entries. Scope itself is NEVER cached — it is recomputed from
// role + memberships on every request; only the aggregation result is reused.
const OVERVIEW_CACHE_TTL_MS = 60 * 1000;
const OVERVIEW_CACHE_MAX = 100;
const overviewCache = new Map<string, { at: number; payload: unknown }>();

interface OverviewRpcRow {
    tenant_id: string;
    companies: number;
    contacts: number;
    active_campaigns: number;
    total_campaigns: number;
    unread_inbound: number;
    last_activity_at: string | null;
}

// GET /api/ops/overview — per-tenant operational rollup over accessible tenants
router.get('/overview', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenants = await getAccessibleTenants(req.user!);
        if (tenants.length === 0) {
            res.json({ tenants: [], generatedAt: new Date().toISOString() });
            return;
        }

        const ids = tenants.map((t) => t.id);
        const cacheKey = [...ids].sort().join(',');
        const cached = overviewCache.get(cacheKey);
        if (cached && Date.now() - cached.at < OVERVIEW_CACHE_TTL_MS) {
            res.json(cached.payload);
            return;
        }

        const [rpcRes, connRes] = await Promise.all([
            supabaseAdmin.rpc('get_ops_tenant_overview', { p_tenant_ids: ids }),
            supabaseAdmin
                .from('email_connections')
                .select('tenant_id, email_address, provider, is_active, last_polled_at')
                .in('tenant_id', ids),
        ]);

        if (rpcRes.error) {
            log.error({ err: rpcRes.error }, 'Ops overview RPC error');
            throw new AppError('Failed to fetch overview', 500);
        }
        if (connRes.error) {
            log.error({ err: connRes.error }, 'Ops overview connections error');
            throw new AppError('Failed to fetch overview', 500);
        }

        const statsByTenant = new Map<string, OverviewRpcRow>(
            ((rpcRes.data || []) as OverviewRpcRow[]).map((r) => [r.tenant_id, r])
        );

        const now = Date.now();
        const connsByTenant = new Map<string, MailboxConnection[]>();
        for (const conn of (connRes.data || []) as MailboxConnection[]) {
            const list = connsByTenant.get(conn.tenant_id) || [];
            list.push(conn);
            connsByTenant.set(conn.tenant_id, list);
        }

        const payload = {
            tenants: tenants.map((t) => {
                const stats = statsByTenant.get(t.id);
                const conns = connsByTenant.get(t.id) || [];
                const lastPolls = conns
                    .map((c) => c.last_polled_at)
                    .filter((p): p is string => p !== null)
                    .sort();
                return {
                    id: t.id,
                    name: t.name,
                    slug: t.slug,
                    tier: t.tier,
                    companies: stats?.companies ?? 0,
                    contacts: stats?.contacts ?? 0,
                    activeCampaigns: stats?.active_campaigns ?? 0,
                    totalCampaigns: stats?.total_campaigns ?? 0,
                    unreadInbound: stats?.unread_inbound ?? 0,
                    lastActivityAt: stats?.last_activity_at ?? null,
                    mailboxes: {
                        total: conns.length,
                        active: conns.filter((c) => c.is_active).length,
                        stale: conns.filter((c) => isStaleMailbox(c, now)).length,
                        lastPolledAt: lastPolls.length > 0 ? lastPolls[lastPolls.length - 1] : null,
                    },
                };
            }),
            generatedAt: new Date().toISOString(),
        };

        if (overviewCache.size >= OVERVIEW_CACHE_MAX) {
            const oldest = overviewCache.keys().next().value;
            if (oldest !== undefined) overviewCache.delete(oldest);
        }
        overviewCache.set(cacheKey, { at: Date.now(), payload });

        res.json(payload);
    } catch (err) {
        next(err);
    }
});

// GET /api/ops/health — authenticated system health (full heartbeat detail for superadmin)
router.get('/health', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenants = await getAccessibleTenants(req.user!);
        const ids = tenants.map((t) => t.id);
        const tenantNames = new Map(tenants.map((t) => [t.id, t.name]));

        let database = 'connected';
        try {
            const { error } = await supabaseAdmin
                .from('tenants')
                .select('id', { count: 'exact', head: true });
            if (error) database = 'unreachable';
        } catch {
            database = 'unreachable';
        }

        let mailboxes: { total: number; active: number; stale: unknown[] } = {
            total: 0,
            active: 0,
            stale: [],
        };
        if (ids.length > 0) {
            const { data, error } = await supabaseAdmin
                .from('email_connections')
                .select('tenant_id, email_address, provider, is_active, last_polled_at')
                .in('tenant_id', ids);
            if (error) {
                log.error({ err: error }, 'Ops health connections error');
            } else {
                const now = Date.now();
                const conns = (data || []) as MailboxConnection[];
                mailboxes = {
                    total: conns.length,
                    active: conns.filter((c) => c.is_active).length,
                    stale: conns
                        .filter((c) => isStaleMailbox(c, now))
                        .map((c) => ({
                            tenantId: c.tenant_id,
                            tenantName: tenantNames.get(c.tenant_id) ?? null,
                            emailAddress: c.email_address,
                            provider: c.provider,
                            lastPolledAt: c.last_polled_at,
                        })),
                };
            }
        }

        // lastError can embed internal infra detail (DB relation/host names) —
        // full text is superadmin-only; ops_agent gets ok flags + timestamps.
        const schedulers =
            req.user!.role === 'superadmin' ? getHeartbeats() : getHeartbeatsPublic();

        res.json({
            status: database === 'connected' ? 'ok' : 'degraded',
            database,
            version: APP_VERSION,
            startedAt: STARTED_AT,
            uptimeSec: Math.floor(process.uptime()),
            schedulers,
            mailboxes,
            timestamp: new Date().toISOString(),
        });
    } catch (err) {
        next(err);
    }
});

export default router;
