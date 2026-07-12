import { supabaseAdmin } from './supabase.js';

export interface ResolvedUser {
    id: string;
    email: string;
    name: string | null;
}

// Auth users live outside the tenant tables (Supabase auth schema), so we resolve
// display name/email via the admin API and cache the result for 5 minutes to avoid
// hammering it on every list render. Shared by tasks, companies and the member picker
// so a single cache serves every "who is this UUID" lookup in the app.
const userCache = new Map<string, { value: ResolvedUser; expiresAt: number }>();

export async function resolveUsers(ids: string[]): Promise<Map<string, ResolvedUser>> {
    const result = new Map<string, ResolvedUser>();
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    const now = Date.now();
    const missing: string[] = [];

    for (const id of uniqueIds) {
        const cached = userCache.get(id);
        if (cached && cached.expiresAt > now) result.set(id, cached.value);
        else missing.push(id);
    }

    // Resolve in small sequential batches so a wide list (e.g. a whole member roster) never
    // fans out hundreds of concurrent admin-API calls and trips its rate limit. Within a batch
    // the lookups still run in parallel; caching is unchanged.
    const BATCH_SIZE = 8;
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
        const batch = missing.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (id) => {
            const { data, error } = await supabaseAdmin.auth.admin.getUserById(id);
            if (error || !data.user) return;
            const value: ResolvedUser = {
                id,
                email: data.user.email || id,
                name: data.user.user_metadata?.full_name || data.user.user_metadata?.name || null,
            };
            userCache.set(id, { value, expiresAt: now + 5 * 60_000 });
            result.set(id, value);
        }));
    }

    return result;
}

/** Display label that NEVER exposes a raw UUID: full name, else the email local-part. */
export function ownerDisplayName(user: ResolvedUser | null | undefined): string | null {
    if (!user) return null;
    if (user.name && user.name.trim()) return user.name.trim();
    const local = user.email.split('@')[0];
    return local || null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True iff `v` is a syntactically valid UUID string. Guards `.eq('...', v)` filters on
 *  uuid columns from throwing 22P02 on malformed input. */
export function isUuid(v: unknown): v is string {
    return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * True iff `userId` is an ACTIVE member of `tenantId` (memberships.is_active). Shared by
 * the tasks route (assertAssignableUser) and the automation executors (owner/assignee)
 * so a UUID from any source is validated against the tenant's roster before it lands on
 * a row — a cross-tenant or non-member user can never be made an owner/assignee.
 * Fail-CLOSED: a malformed UUID or a query error returns false (never assigns).
 */
export async function isActiveMember(tenantId: string, userId: unknown): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const { data, error } = await supabaseAdmin
        .from('memberships')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('user_id', userId)
        .eq('is_active', true)
        .maybeSingle();
    if (error) return false; // fail-closed: a transient error must not green-light an assignment
    return !!data;
}
