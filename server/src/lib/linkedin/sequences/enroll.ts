/**
 * TG-LinkedIn Faz 4 — enrollment + suppression + sender-rotation helpers (§5).
 *
 * The dedup key is the workspace identity: the SAME person imported twice (or by two
 * teammates) collapses to one lead + one suppression scope. Enroll and suppress go through
 * the 097 RPCs (atomic suppression/one-active-campaign checks); sender rotation picks the
 * least-loaded ACTIVE account from the campaign's pool so per-account caps stay balanced.
 */
import { researchSupabaseAdmin } from '../../research/supabase.js';
import { createLogger } from '../../logger.js';

const log = createLogger('linkedin:enroll');

/**
 * Workspace dedup key for a lead. Prefer the most stable identifier: public vanity id →
 * profile urn → name+company. Lowercased/trimmed so trivial case/space differences collapse.
 */
export function dedupeKey(lead: { public_id?: string | null; profile_urn?: string | null; first_name?: string | null; last_name?: string | null; company?: string | null }): string {
    const pub = (lead.public_id ?? '').trim().toLowerCase();
    if (pub) return `pub:${pub}`;
    const urn = (lead.profile_urn ?? '').trim().toLowerCase();
    if (urn) return `urn:${urn}`;
    const name = `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim().toLowerCase();
    const company = (lead.company ?? '').trim().toLowerCase();
    return `nc:${name}|${company}`;
}

export interface EnrollResult {
    enrolled: boolean;
    reason: string; // 'ok' | 'suppressed' | 'in_another_campaign' | 'already_enrolled' | 'lead_not_found' | 'no_sender'
    enrollment_id?: string;
    account_id?: string;
}

/**
 * Pick the least-loaded ACTIVE sender from a campaign's pool (§5 sender rotation). Balances
 * active-enrollment count per account so no single account is pushed toward its caps. Returns
 * null when the pool has no ACTIVE account.
 */
export async function pickSenderForEnroll(tenantId: string, senderPool: string[]): Promise<string | null> {
    if (!senderPool || senderPool.length === 0) return null;
    const { data: accounts, error } = await researchSupabaseAdmin
        .from('linkedin_accounts')
        .select('id')
        .eq('tenant_id', tenantId)
        .in('id', senderPool)
        .eq('status', 'ACTIVE');
    if (error) { log.warn({ err: error, tenantId }, 'pickSender account read failed'); return null; }
    const active = (accounts ?? []).map((a) => (a as { id: string }).id);
    if (active.length === 0) return null;

    // Count active enrollments per candidate; choose the minimum (ties → pool order).
    const { data: rows, error: cErr } = await researchSupabaseAdmin
        .from('linkedin_enrollments')
        .select('account_id')
        .eq('tenant_id', tenantId)
        .in('account_id', active)
        .in('state', ['pending', 'invited', 'accepted', 'messaged']);
    if (cErr) { log.warn({ err: cErr, tenantId }, 'pickSender load read failed'); return active[0]; }
    const load = new Map<string, number>(active.map((id) => [id, 0]));
    for (const r of rows ?? []) {
        const id = (r as { account_id: string | null }).account_id;
        if (id && load.has(id)) load.set(id, (load.get(id) ?? 0) + 1);
    }
    // Preserve pool order among ties by iterating `active` (not the map).
    let best = active[0];
    let bestLoad = load.get(best) ?? 0;
    for (const id of active) {
        const l = load.get(id) ?? 0;
        if (l < bestLoad) { best = id; bestLoad = l; }
    }
    return best;
}

/**
 * The dedupe keys this lead could be suppressed under, for a send-time cross-identifier re-check.
 * The enroll RPC checks only the lead's stored dedupe_key, but the SAME person may have been
 * suppressed under a DIFFERENT STABLE identifier (opted out as pub:john-doe, later enrolled as
 * urn:… from Sales Navigator). We include the lead's own key + its pub:/urn: derivations.
 *
 * We deliberately do NOT synthesize the nc:name|company key here: that key is ambiguous (two
 * distinct people can share name+company), so deriving it for a pub/urn-keyed lead would
 * over-suppress a homonym who happens to match a name-only suppression (fix-review regression).
 * A lead whose OWN stored key is already nc: is still covered (it's in the set) — that homonym
 * collision is inherent to name+company dedup, not introduced by this re-check.
 */
export function candidateKeysForLead(lead: { public_id?: string | null; profile_urn?: string | null; dedupe_key?: string | null }): string[] {
    const keys = new Set<string>();
    if (lead.dedupe_key) keys.add(lead.dedupe_key);
    const pub = (lead.public_id ?? '').trim().toLowerCase();
    if (pub) keys.add(`pub:${pub}`);
    const urn = (lead.profile_urn ?? '').trim().toLowerCase();
    if (urn) keys.add(`urn:${urn}`);
    return [...keys];
}

/**
 * True if ANY of the lead's stable identity keys is workspace-suppressed (send-time gate).
 *
 * R1 (fail-CLOSED): a PostgREST lookup error is re-THROWN, never swallowed. Returning false on a DB
 * fault would let a suppressed lead be messaged (suppression state UNKNOWN treated as "clear"). The
 * only caller (the engine's pre/post-generation checks) catches the throw and holds the send —
 * treating an unknown suppression state as do-NOT-send rather than send.
 */
export async function isLeadSuppressed(
    tenantId: string,
    lead: { public_id?: string | null; profile_urn?: string | null; dedupe_key?: string | null },
): Promise<boolean> {
    const keys = candidateKeysForLead(lead);
    if (keys.length === 0) return false;
    const { data, error } = await researchSupabaseAdmin
        .from('linkedin_suppression').select('id').eq('tenant_id', tenantId).in('dedupe_key', keys).limit(1);
    if (error) { log.warn({ err: error, tenantId }, 'isLeadSuppressed read failed → throwing (fail-closed)'); throw error; }
    return (data ?? []).length > 0;
}

/** Atomic enroll via the 097 RPC (suppression + one-active-campaign checks under one statement). */
export async function enrollLead(
    tenantId: string, campaignId: string, leadId: string, accountId: string, firstAt: Date,
): Promise<EnrollResult> {
    const { data, error } = await researchSupabaseAdmin.rpc('linkedin_enroll_lead', {
        p_tenant: tenantId, p_campaign: campaignId, p_lead: leadId,
        p_account: accountId, p_first_at: firstAt.toISOString(),
    });
    if (error) throw error;
    const r = data as { enrolled: boolean; reason: string; enrollment_id?: string };
    return { ...r, account_id: accountId };
}

/** Suppress an identity + stop its active enrollments across the workspace (097 RPC). */
export async function suppressIdentity(
    tenantId: string, key: string, reason: string, leadId: string | null,
): Promise<{ suppressed: boolean; stopped: number }> {
    const { data, error } = await researchSupabaseAdmin.rpc('linkedin_suppress_identity', {
        p_tenant: tenantId, p_key: key, p_reason: reason, p_lead: leadId,
    });
    if (error) throw error;
    return data as { suppressed: boolean; stopped: number };
}
