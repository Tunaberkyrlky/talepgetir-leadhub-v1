/**
 * Shared PlusVibe reply-import core.
 *
 * Extracted from routes/plusvibe.ts so both the import routes and the webhook
 * handler can reuse the same insert/dedup/match logic. Also hosts the
 * campaign → tenant resolver and outbound campaign-send hydration (first-touch +
 * steps) used to complete threads.
 */
import { supabaseAdmin } from '../supabase.js';
import { createLogger } from '../logger.js';
import { parseApiReply, parseCampaignEmail } from './plusvibeAdapter.js';
import { canonicalToReplyRow } from './types.js';
import { matchTenant, type PrefixRule } from './campaignPrefix.js';
import {
    listCampaigns,
    getCampaignSummary,
    getCampaignAccounts,
    fetchCampaignEmailsByLead,
    fetchAllReplies,
    type PlusVibeCampaign,
    type PlusVibeEmail,
} from '../plusvibeClient.js';

const log = createLogger('lib:replyImport');

export type ReplyMatchResult = {
    company_id: string | null;
    contact_id: string | null;
    match_status: 'matched' | 'unmatched';
};
export type ReplyMatcher = (email: string) => ReplyMatchResult;

/** Build an O(1) email → company/contact matcher from this tenant's contacts + companies. */
export async function buildTenantMatcher(tenantId: string): Promise<ReplyMatcher> {
    const { data: tenantContacts } = await supabaseAdmin
        .from('contacts')
        .select('id, email, company_id, is_primary')
        .eq('tenant_id', tenantId)
        .not('email', 'is', null);
    const { data: tenantCompanies } = await supabaseAdmin
        .from('companies')
        .select('id, company_email')
        .eq('tenant_id', tenantId)
        .not('company_email', 'is', null);

    const contactsByEmail = new Map<string, { id: string; company_id: string }>();
    for (const c of tenantContacts || []) {
        const e = (c.email as string).toLowerCase().trim();
        // Keep primary over non-primary; otherwise first wins.
        if (!contactsByEmail.has(e) || c.is_primary) {
            contactsByEmail.set(e, { id: c.id, company_id: c.company_id });
        }
    }
    const companyByEmail = new Map<string, string>();
    for (const c of tenantCompanies || []) {
        companyByEmail.set((c.company_email as string).toLowerCase().trim(), c.id);
    }

    return (email: string): ReplyMatchResult => {
        const e = email.toLowerCase().trim();
        const contact = contactsByEmail.get(e);
        if (contact) return { company_id: contact.company_id, contact_id: contact.id, match_status: 'matched' };
        const companyId = companyByEmail.get(e);
        if (companyId) return { company_id: companyId, contact_id: null, match_status: 'matched' };
        return { company_id: null, contact_id: null, match_status: 'unmatched' };
    };
}

/**
 * Import a campaign's PlusVibe replies into email_replies: insert new rows, and
 * ENRICH existing rows that are missing canonical address fields (account_email).
 *
 * Dedup is timestamp-format independent: rows match first by PlusVibe email id
 * (raw_payload.plusvibe_email_id), then by sender|ISO-normalized-timestamp. The
 * DB stores replied_at as TIMESTAMPTZ (canonical "+00" form) while the API returns
 * "...Z" — both sides MUST be normalized or every re-import duplicates rows.
 */
export async function enrichOrInsertReplies(params: {
    tenantId: string;
    pvCampaignId: string;
    campaignName: string | null;
    replies: PlusVibeEmail[];
    matchEmail: ReplyMatcher;
}): Promise<{ imported: number; skipped: number; enriched: number }> {
    const { tenantId, pvCampaignId, campaignName, replies, matchEmail } = params;

    const normalizeTs = (ts: string): string => {
        const d = new Date(ts);
        return Number.isNaN(d.getTime()) ? ts : d.toISOString();
    };

    const { data: existing } = await supabaseAdmin
        .from('email_replies')
        .select('id, sender_email, replied_at, account_email, raw_payload')
        .eq('tenant_id', tenantId)
        .eq('campaign_id', pvCampaignId);

    const existingById = new Map<string, { id: string; account_email: string | null }>();
    const existingByKey = new Map<string, { id: string; account_email: string | null }>();
    for (const r of existing || []) {
        const rec = { id: r.id as string, account_email: r.account_email as string | null };
        const pvId = (r.raw_payload as Record<string, unknown> | null)?.plusvibe_email_id as string | undefined;
        if (pvId) existingById.set(pvId, rec);
        if (r.replied_at) existingByKey.set(`${r.sender_email}|${normalizeTs(r.replied_at as string)}`, rec);
    }

    const newRows: Record<string, unknown>[] = [];
    const enrichTasks: { id: string; patch: Record<string, unknown> }[] = [];
    let skipped = 0;

    for (const reply of replies) {
        const senderEmail = reply.from_address_email.toLowerCase().trim();
        const repliedAt = reply.timestamp_created || new Date().toISOString();
        const key = `${senderEmail}|${normalizeTs(repliedAt)}`;

        const canonical = parseApiReply(reply, campaignName);
        canonical.tenantId = tenantId;
        canonical.rawPayload = { source: 'plusvibe_api_import', plusvibe_email_id: reply.id };

        const hit = existingById.get(reply.id) ?? existingByKey.get(key);
        if (hit) {
            if (!hit.account_email && canonical.accountEmail) {
                // Mark optimistically so a same-run duplicate doesn't re-enqueue it.
                hit.account_email = canonical.accountEmail;
                enrichTasks.push({
                    id: hit.id,
                    patch: {
                        account_email: canonical.accountEmail,
                        from_address: canonical.fromAddress,
                        to_address: canonical.toAddress,
                        cc_address: canonical.ccAddress,
                        provider: 'plusvibe',
                        provider_thread_id: canonical.providerThreadId,
                        provider_message_id: canonical.providerMessageId,
                    },
                });
            } else {
                skipped++;
            }
            continue;
        }

        const match = matchEmail(reply.from_address_email);
        newRows.push({
            ...canonicalToReplyRow(canonical),
            company_id: match.company_id,
            contact_id: match.contact_id,
            match_status: match.match_status,
            // Mail entering the system defaults to UNREAD regardless of the provider's
            // is_unread flag — only OUR own outbound messages count as read. (These API
            // imports are inbound replies; the guard just protects against a stray OUT.)
            read_status: canonical.direction === 'outbound' ? 'read' : 'unread',
        });
        existingByKey.set(key, { id: 'pending', account_email: canonical.accountEmail });
    }

    // Run enrich updates with bounded concurrency (was sequential per-row).
    let enriched = 0;
    for (let i = 0; i < enrichTasks.length; i += 20) {
        const chunk = enrichTasks.slice(i, i + 20);
        const results = await Promise.all(chunk.map((t) =>
            supabaseAdmin
                .from('email_replies')
                .update(t.patch)
                .eq('id', t.id)
                .is('account_email', null), // guard: never overwrite resolved/manual
        ));
        for (const res of results) if (!res.error) enriched++;
    }

    // Batch insert (500/batch) with one-by-one fallback on unique-violation.
    let imported = 0;
    for (let i = 0; i < newRows.length; i += 500) {
        const batch = newRows.slice(i, i + 500);
        const { error } = await supabaseAdmin.from('email_replies').insert(batch);
        if (!error) { imported += batch.length; continue; }
        if (error.code === '23505') {
            log.info({ batch: i / 500, batchSize: batch.length }, 'Batch has duplicates, inserting individually');
            for (const row of batch) {
                const { error: rowErr } = await supabaseAdmin.from('email_replies').insert(row);
                if (!rowErr) imported++; // silently skip duplicates
            }
        } else {
            log.warn({ err: error, batch: i / 500 }, 'Batch insert failed during import');
        }
    }

    return { imported, skipped, enriched };
}

// ── Outbound campaign-send hydration (first-touch + steps) ──────────────────
// The campaign sequence sends live in /unibox/campaign-emails (per lead), NOT in
// the reply unibox. We pull them per thread and store them as OUT rows so the
// opening email we sent shows up in the conversation.

// In-process guard: stop two concurrent webhooks for the SAME thread from both
// fetching + inserting the same sends (the unique index is the final backstop,
// but this avoids the wasted duplicate API calls — finding #8).
const hydrationInFlight = new Set<string>();

/** Pull + insert the campaign sends (first-touch + steps) for a single thread. */
export async function hydrateThreadCampaignSends(params: {
    tenantId: string;
    pvCampaignId: string;
    campaignName: string | null;
    leadEmail: string;
    /** Fallback matcher (bulk path). */
    matchEmail?: ReplyMatcher;
    /** Pre-computed match for this lead (webhook path) — avoids rebuilding a matcher. */
    match?: ReplyMatchResult;
}): Promise<{ imported: number; skipped: number }> {
    const { tenantId, pvCampaignId, campaignName } = params;
    const lead = params.leadEmail?.toLowerCase().trim();
    if (!lead || !pvCampaignId) return { imported: 0, skipped: 0 };

    const flightKey = `${tenantId}:${pvCampaignId}:${lead}`;
    if (hydrationInFlight.has(flightKey)) return { imported: 0, skipped: 0 };
    hydrationInFlight.add(flightKey);
    try {
        // Read the whole thread once: drives the gate, the existing-id dedup, the
        // thread's company/contact (so OUT adopts the SAME match as the inbound
        // reply — finding #3), and the row we tag as "checked".
        const { data: threadRows } = await supabaseAdmin
            .from('email_replies')
            .select('id, direction, provider_message_id, raw_payload, company_id, contact_id')
            .eq('tenant_id', tenantId)
            .eq('campaign_id', pvCampaignId)
            .eq('sender_email', lead);

        const existingIds = new Set<string>();
        let alreadyChecked = false;
        let threadMatch: ReplyMatchResult | null = null;
        let markerRow: { id: string; raw_payload: Record<string, unknown> | null } | null = null;
        for (const r of threadRows || []) {
            const rp = r.raw_payload as Record<string, unknown> | null;
            if (r.direction === 'OUT' && r.provider_message_id) existingIds.add(r.provider_message_id as string);
            if ((r.direction === 'OUT' && rp?.source === 'plusvibe_campaign_send') || rp?.campaign_sends_checked === true) {
                alreadyChecked = true;
            }
            // Adopt the thread's resolved company/contact from any matched row (prefer IN).
            if (r.company_id && (!threadMatch || r.direction === 'IN')) {
                threadMatch = { company_id: r.company_id as string, contact_id: (r.contact_id as string | null) ?? null, match_status: 'matched' };
            }
            // Representative row to mark "checked" (prefer an inbound row).
            if (!markerRow || r.direction === 'IN') markerRow = { id: r.id as string, raw_payload: rp };
        }
        if (alreadyChecked) return { imported: 0, skipped: 0 };

        const records = await fetchCampaignEmailsByLead(pvCampaignId, lead);

        // Resolve the match once: thread's existing match → caller-supplied → fallback
        // matcher. Only build a full tenant matcher as a last resort (finding #6).
        let resolved: ReplyMatchResult | null = threadMatch ?? params.match ?? (params.matchEmail ? params.matchEmail(lead) : null);
        if (!resolved) resolved = (await buildTenantMatcher(tenantId))(lead);

        let imported = 0;
        let skipped = 0;
        for (const rec of records) {
            // Per-record guard: one malformed record (bad body, parse error) must not
            // abort the rest of the thread's sends.
            try {
                if (rec.id && existingIds.has(rec.id)) { skipped++; continue; }

                const canonical = parseCampaignEmail(rec, campaignName);
                canonical.tenantId = tenantId;
                canonical.rawPayload = { source: 'plusvibe_campaign_send', plusvibe_email_id: rec.id, step: rec.current_step ?? null };

                const row = {
                    ...canonicalToReplyRow(canonical),
                    company_id: resolved.company_id,
                    contact_id: resolved.contact_id,
                    match_status: resolved.match_status,
                    read_status: 'read' as const,
                    step: rec.current_step ?? null,
                };
                const { error } = await supabaseAdmin.from('email_replies').insert(row);
                if (!error) imported++;
                else if (error.code === '23505') skipped++; // provider_message_id unique index — already stored
                else log.warn({ err: error, pvCampaignId, lead, recId: rec.id }, 'Campaign-send insert failed');
            } catch (recErr) {
                log.warn({ err: recErr, pvCampaignId, lead, recId: rec.id }, 'Campaign-send record skipped (parse/insert threw)');
            }
        }

        // If PlusVibe returned no sends for this lead, tag the thread "checked" so we
        // don't re-hit the API on every future reply (finding #5). When sends WERE
        // inserted, the campaign_send rows themselves gate future runs.
        if (records.length === 0 && markerRow) {
            const merged = { ...(markerRow.raw_payload ?? {}), campaign_sends_checked: true };
            await supabaseAdmin.from('email_replies').update({ raw_payload: merged }).eq('id', markerRow.id);
        }

        log.info({ tenantId, pvCampaignId, lead, imported, skipped, records: records.length }, 'Thread campaign-send hydration completed');
        return { imported, skipped };
    } finally {
        hydrationInFlight.delete(flightKey);
    }
}

/**
 * Backfill campaign sends for every thread in a campaign that already has an
 * inbound reply (those are the threads visible in TG Core). One API call per lead.
 */
export async function hydrateCampaignSendsForCampaign(params: {
    tenantId: string;
    pvCampaignId: string;
    campaignName: string | null;
    matchEmail?: ReplyMatcher;
}): Promise<{ leads: number; imported: number; skipped: number }> {
    const { tenantId, pvCampaignId, campaignName } = params;

    const { data: inRows } = await supabaseAdmin
        .from('email_replies')
        .select('sender_email')
        .eq('tenant_id', tenantId)
        .eq('campaign_id', pvCampaignId)
        .eq('direction', 'IN');

    const leads = Array.from(new Set(
        (inRows || [])
            .map((r) => (r.sender_email as string | null)?.toLowerCase().trim())
            .filter((e): e is string => !!e),
    ));
    if (leads.length === 0) return { leads: 0, imported: 0, skipped: 0 };

    const matchEmail = params.matchEmail ?? (await buildTenantMatcher(tenantId));
    let imported = 0;
    let skipped = 0;
    for (const lead of leads) {
        try {
            const r = await hydrateThreadCampaignSends({ tenantId, pvCampaignId, campaignName, leadEmail: lead, matchEmail });
            imported += r.imported;
            skipped += r.skipped;
        } catch (err) {
            log.warn({ err, pvCampaignId, lead }, 'Campaign-send hydration failed for lead');
        }
    }

    log.info({ tenantId, pvCampaignId, leads: leads.length, imported, skipped }, 'Campaign-send backfill completed');
    return { leads: leads.length, imported, skipped };
}

// ── Campaign → tenant resolution (for the single multi-tenant webhook) ──

export type CampaignTenantResolution =
    | { status: 'assigned'; tenantId: string }
    | { status: 'unassigned' }
    | { status: 'unknown' }
    | { status: 'missing' };

/** Resolve which tenant a PlusVibe campaign id belongs to via the local cache. */
export async function resolveCampaignTenant(
    campId: string | null | undefined,
): Promise<CampaignTenantResolution> {
    const id = campId?.trim();
    if (!id) return { status: 'missing' };

    const { data } = await supabaseAdmin
        .from('plusvibe_campaigns')
        .select('tenant_id')
        .eq('pv_campaign_id', id)
        .maybeSingle();

    if (!data) return { status: 'unknown' };
    if (!data.tenant_id) return { status: 'unassigned' };
    return { status: 'assigned', tenantId: data.tenant_id as string };
}

// ── Campaign cache sync (PlusVibe API → plusvibe_campaigns) ──

/** Sync all campaigns from PlusVibe into the local cache. Returns count synced. */
export async function syncCampaigns(): Promise<number> {
    const campaigns: PlusVibeCampaign[] = await listCampaigns();
    const now = new Date().toISOString();

    for (const campaign of campaigns) {
        const pvId = campaign._id || campaign.id;

        let stats = {};
        try {
            stats = await getCampaignSummary(pvId);
        } catch (err) {
            log.warn({ err, campaignId: pvId }, 'Failed to fetch summary for campaign, skipping stats');
        }

        // Fetch email accounts linked to this campaign for reply from-address
        let senderEmails: string[] = [];
        try {
            senderEmails = await getCampaignAccounts(pvId);
        } catch (err) {
            log.warn({ err, campaignId: pvId }, 'Failed to fetch campaign accounts, skipping sender_emails');
        }

        // Map PlusVibe summary fields to our schema
        const s = stats as Record<string, unknown>;
        const totalLeads = Number(s.contacted) || 0;
        const emailsSent = Number(s.total_sent_emails) || 0;
        const opens = Number(s.leads_who_read) || 0;
        const replies = Number(s.leads_who_replied) || 0;
        const bounces = Number(s.bounced) || 0;
        // PlusVibe doesn't return clicks — leave as 0
        const clicks = 0;

        const updateFields = {
            name: campaign.name || 'Unnamed',
            status: campaign.status || null,
            total_leads: totalLeads,
            emails_sent: emailsSent,
            opens,
            clicks,
            replies,
            bounces,
            open_rate: emailsSent > 0 ? opens / emailsSent : 0,
            click_rate: 0,
            reply_rate: emailsSent > 0 ? replies / emailsSent : 0,
            last_synced_at: now,
            sender_emails: senderEmails,
        };

        // Check if campaign exists — update stats only, preserve tenant_id
        const { data: existing } = await supabaseAdmin
            .from('plusvibe_campaigns')
            .select('id')
            .eq('pv_campaign_id', pvId)
            .single();

        if (existing) {
            await supabaseAdmin
                .from('plusvibe_campaigns')
                .update(updateFields)
                .eq('id', existing.id);
        } else {
            await supabaseAdmin
                .from('plusvibe_campaigns')
                .insert({ pv_campaign_id: pvId, ...updateFields });
        }
    }

    // Assignment is fully prefix-driven — (re)derive tenant_id for every campaign.
    await recomputeCampaignAssignments();

    log.info({ count: campaigns.length }, 'Campaigns synced');
    return campaigns.length;
}

// ── Prefix-based campaign → tenant assignment ──

/** Load all configured prefix → tenant rules. */
export async function loadPrefixRules(): Promise<PrefixRule[]> {
    const { data } = await supabaseAdmin
        .from('campaign_prefix_rules')
        .select('tenant_id, prefix');
    return (data as PrefixRule[] | null) ?? [];
}

/**
 * Backfill a campaign's threads for a tenant: any replies (incl. outbound
 * first-touch + steps) received while it was unassigned. Used after a campaign is
 * (auto-)assigned. Safe to call fire-and-forget; each step guards its own errors.
 */
export async function backfillCampaignThreads(params: {
    tenantId: string;
    pvCampaignId: string;
    campaignName: string | null;
}): Promise<void> {
    const { tenantId, pvCampaignId, campaignName } = params;
    const matchEmail = await buildTenantMatcher(tenantId);
    const replies = await fetchAllReplies(pvCampaignId);
    if (replies.length > 0) {
        const r = await enrichOrInsertReplies({ tenantId, pvCampaignId, campaignName, replies, matchEmail });
        log.info({ pvCampaignId, tenantId, ...r }, 'Auto-assign reply backfill completed');
    }
    const outbound = await hydrateCampaignSendsForCampaign({ tenantId, pvCampaignId, campaignName, matchEmail });
    log.info({ pvCampaignId, tenantId, outbound }, 'Auto-assign campaign-send backfill completed');
}

/**
 * Recompute tenant_id for every campaign from the prefix rules (assignment is fully
 * prefix-driven — there is no manual per-campaign assignment to preserve). Updates
 * only campaigns whose owner changes; newly-assigned campaigns get their threads
 * backfilled. Reassignment to a different tenant is logged (historical replies keep
 * their original tenant_id — not migrated here). Call after a sync or a rule change.
 */
export async function recomputeCampaignAssignments(): Promise<{
    assigned: number; unassigned: number; reassigned: number; total: number;
}> {
    const rules = await loadPrefixRules();
    const { data: campaigns } = await supabaseAdmin
        .from('plusvibe_campaigns')
        .select('id, pv_campaign_id, name, tenant_id');

    let assigned = 0, unassigned = 0, reassigned = 0;
    const list = (campaigns as Array<{ id: string; pv_campaign_id: string; name: string; tenant_id: string | null }> | null) ?? [];

    for (const c of list) {
        const desired = matchTenant(c.name, rules);
        const current = c.tenant_id;
        if (desired === current) continue;

        await supabaseAdmin.from('plusvibe_campaigns').update({ tenant_id: desired }).eq('id', c.id);

        if (desired && !current) {
            assigned++;
            void backfillCampaignThreads({ tenantId: desired, pvCampaignId: c.pv_campaign_id, campaignName: c.name })
                .catch((err) => log.warn({ err, pvCampaignId: c.pv_campaign_id }, 'Auto-assign backfill failed'));
        } else if (!desired && current) {
            unassigned++;
        } else if (desired && current) {
            reassigned++;
            log.warn({ pvCampaignId: c.pv_campaign_id, from: current, to: desired }, 'Campaign reassigned to a different tenant by prefix; historical replies keep their original tenant');
            void backfillCampaignThreads({ tenantId: desired, pvCampaignId: c.pv_campaign_id, campaignName: c.name })
                .catch((err) => log.warn({ err, pvCampaignId: c.pv_campaign_id }, 'Reassign backfill failed'));
        }
    }

    log.info({ assigned, unassigned, reassigned, total: list.length }, 'Campaign assignments recomputed by prefix');
    return { assigned, unassigned, reassigned, total: list.length };
}

// Debounce guard so a burst of webhooks for unknown campaigns triggers at most
// one sync per interval. lastSyncAt advances only on SUCCESS, and an in-flight flag
// blocks concurrent runs — so a failed sync doesn't lock out retries (finding #7).
let lastSyncAt = 0;
let syncInFlight = false;
/** Trigger a campaign sync at most once per `minIntervalMs`. Fire-and-forget safe. */
export async function syncCampaignsDebounced(minIntervalMs = 60_000): Promise<void> {
    if (syncInFlight) return;
    if (Date.now() - lastSyncAt < minIntervalMs) return;
    syncInFlight = true;
    try {
        await syncCampaigns();
        lastSyncAt = Date.now(); // only debounce AFTER a successful sync
    } catch (err) {
        log.warn({ err }, 'Debounced campaign sync failed'); // leave lastSyncAt so the next webhook retries
    } finally {
        syncInFlight = false;
    }
}
