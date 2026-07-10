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
