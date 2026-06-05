import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { isInternalRole } from '../lib/roles.js';
import {
    isConfigured,
    checkConnection,
    listCampaigns,
    getCampaignSummary,
    getCampaignStats,
    getCampaignAccounts,
    fetchAllReplies,
    type PlusVibeCampaign,
    type PlusVibeEmail,
} from '../lib/plusvibeClient.js';
import { validateBody, assignCampaignSchema, campaignStatsQuerySchema } from '../lib/validation.js';
import { parseApiReply } from '../lib/mail/plusvibeAdapter.js';
import { canonicalToReplyRow } from '../lib/mail/types.js';

const log = createLogger('route:plusvibe');
const router = Router();

// ── Shared reply-import core (used by /import-replies and /import-campaign) ──

type ReplyMatchResult = { company_id: string | null; contact_id: string | null; match_status: 'matched' | 'unmatched' };
type ReplyMatcher = (email: string) => ReplyMatchResult;

/** Build an O(1) email → company/contact matcher from this tenant's contacts + companies. */
async function buildTenantMatcher(tenantId: string): Promise<ReplyMatcher> {
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
async function enrichOrInsertReplies(params: {
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
            read_status: reply.is_unread ? 'unread' : 'read',
        });
        existingByKey.set(key, { id: 'pending', account_email: canonical.accountEmail });
    }

    // Run enrich updates with bounded concurrency (was sequential per-row).
    let enriched = 0;
    for (let i = 0; i < enrichTasks.length; i += 20) {
        const chunk = enrichTasks.slice(i, i + 20);
        const results = await Promise.all(chunk.map(t =>
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

// ── GET /api/plusvibe/status — check if PlusVibe is configured + connected ──
router.get(
    '/status',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            if (!isConfigured()) {
                res.json({ configured: false, connected: false });
                return;
            }
            const connected = await checkConnection();
            res.json({ configured: true, connected });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'PlusVibe status check error');
            next(new AppError('Failed to check PlusVibe status', 500));
        }
    }
);

// ── GET /api/plusvibe/campaigns — campaign list ──
// Internal roles (superadmin/ops_agent): see ALL campaigns (assigned + unassigned)
// Client roles: see only campaigns assigned to their tenant
router.get(
    '/campaigns',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const isInternal = isInternalRole(req.user!.role);
            const adminView = req.query.admin === 'true' && isInternal;

            // Always read from cache — sync only via POST /sync button
            let query = supabaseAdmin
                .from('plusvibe_campaigns')
                .select('*')
                .order('name', { ascending: true });

            // Admin view: show all campaigns (assigned + unassigned)
            // Normal view: show only campaigns assigned to the current tenant
            if (!adminView) {
                query = query.eq('tenant_id', req.tenantId!);
            }

            // Status filter
            const statusFilter = req.query.status as string | undefined;
            if (statusFilter) {
                query = query.eq('status', statusFilter.toUpperCase());
            }

            const { data, error } = await query;

            if (error) {
                log.error({ err: error }, 'Failed to fetch cached campaigns');
                throw new AppError('Failed to fetch campaigns', 500);
            }

            log.info({ count: data?.length, isInternal }, 'Campaigns query result');
            res.json({ data: data || [] });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'List campaigns error');
            next(new AppError('Failed to fetch campaigns', 500));
        }
    }
);

// ── GET /api/plusvibe/campaigns/:pvCampaignId/stats — single campaign summary ──
router.get(
    '/campaigns/:pvCampaignId/stats',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const pvCampaignId = req.params.pvCampaignId as string;

            // Non-internal users can only view stats for campaigns assigned to their tenant
            if (!isInternalRole(req.user!.role)) {
                const { data: campaign } = await supabaseAdmin
                    .from('plusvibe_campaigns')
                    .select('id')
                    .eq('pv_campaign_id', pvCampaignId)
                    .eq('tenant_id', req.tenantId!)
                    .single();

                if (!campaign) {
                    throw new AppError('Campaign not found', 404);
                }
            }

            const stats = await getCampaignSummary(pvCampaignId);
            res.json(stats);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Campaign stats error');
            next(new AppError('Failed to fetch campaign stats', 500));
        }
    }
);

// ── GET /api/plusvibe/analytics — aggregate stats (requires start_date) ──
router.get(
    '/analytics',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const queryResult = campaignStatsQuerySchema.safeParse(req.query);
            if (!queryResult.success) {
                throw new AppError('Invalid query parameters', 400);
            }
            const dateFrom = queryResult.data.date_from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
            const dateTo = queryResult.data.date_to;
            const stats = await getCampaignStats(dateFrom, dateTo);
            res.json(stats);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Analytics error');
            next(new AppError('Failed to fetch analytics', 500));
        }
    }
);

// ── POST /api/plusvibe/sync — force-refresh campaign cache (internal only) ──
router.post(
    '/sync',
    requireRole('superadmin', 'ops_agent'),
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const count = await syncCampaigns();
            res.json({ synced: count, synced_at: new Date().toISOString() });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Sync campaigns error');
            next(new AppError('Failed to sync campaigns', 500));
        }
    }
);

// ── PATCH /api/plusvibe/campaigns/:id/assign — assign campaign to a tenant (internal only) ──
router.patch(
    '/campaigns/:id/assign',
    requireRole('superadmin', 'ops_agent'),
    validateBody(assignCampaignSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { id } = req.params;
            const { tenant_id } = req.body;

            // Verify tenant exists
            const { data: tenant } = await supabaseAdmin
                .from('tenants')
                .select('id, name')
                .eq('id', tenant_id)
                .single();

            if (!tenant) {
                throw new AppError('Tenant not found', 404);
            }

            const { data, error } = await supabaseAdmin
                .from('plusvibe_campaigns')
                .update({ tenant_id })
                .eq('id', id)
                .select('id, pv_campaign_id, name, tenant_id')
                .single();

            if (error || !data) {
                throw new AppError('Campaign not found', 404);
            }

            log.info({ campaignId: id, tenantId: tenant_id, tenantName: tenant.name }, 'Campaign assigned to tenant');
            res.json(data);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Assign campaign error');
            next(new AppError('Failed to assign campaign', 500));
        }
    }
);

// ── PATCH /api/plusvibe/campaigns/:id/unassign — remove tenant assignment (internal only) ──
router.patch(
    '/campaigns/:id/unassign',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { id } = req.params;

            const { data, error } = await supabaseAdmin
                .from('plusvibe_campaigns')
                .update({ tenant_id: null })
                .eq('id', id)
                .select('id, pv_campaign_id, name, tenant_id')
                .single();

            if (error || !data) {
                throw new AppError('Campaign not found', 404);
            }

            log.info({ campaignId: id }, 'Campaign unassigned');
            res.json(data);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Unassign campaign error');
            next(new AppError('Failed to unassign campaign', 500));
        }
    }
);

// ── POST /api/plusvibe/import-replies — pull historical replies for tenant's campaigns ──
router.post(
    '/import-replies',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;

            // STRICT: only fetch campaigns explicitly assigned to this tenant
            const { data: assignedCampaigns } = await supabaseAdmin
                .from('plusvibe_campaigns')
                .select('pv_campaign_id, name, tenant_id')
                .eq('tenant_id', tenantId);

            // Double-check: filter out any campaign where tenant_id doesn't match
            const safeCampaigns = (assignedCampaigns || []).filter(
                (c: { tenant_id: string | null }) => c.tenant_id === tenantId
            );

            if (safeCampaigns.length === 0) {
                res.json({ imported: 0, skipped: 0, fetched: 0, message: 'No campaigns assigned to this tenant' });
                return;
            }

            log.info(
                { tenantId, campaigns: safeCampaigns.map((c: { pv_campaign_id: string; name: string }) => c.name) },
                'Import replies — tenant campaigns',
            );

            let totalImported = 0;
            let totalSkipped = 0;
            let totalFetched = 0;
            let totalEnriched = 0;

            const matchEmail = await buildTenantMatcher(tenantId);

            for (const campaign of safeCampaigns) {
                try {
                    const replies = await fetchAllReplies(campaign.pv_campaign_id);
                    totalFetched += replies.length;
                    log.info({ campaignId: campaign.pv_campaign_id, name: campaign.name, replies: replies.length }, 'Fetched replies');

                    if (replies.length === 0) continue;

                    const r = await enrichOrInsertReplies({
                        tenantId,
                        pvCampaignId: campaign.pv_campaign_id,
                        campaignName: campaign.name,
                        replies,
                        matchEmail,
                    });
                    totalImported += r.imported;
                    totalSkipped += r.skipped;
                    totalEnriched += r.enriched;
                } catch (err) {
                    log.warn({ err, campaignId: campaign.pv_campaign_id }, 'Failed to import replies for campaign');
                }
            }

            log.info({ tenantId, totalImported, totalSkipped, totalFetched, totalEnriched }, 'Reply import completed');
            res.json({ imported: totalImported, skipped: totalSkipped, fetched: totalFetched, enriched: totalEnriched });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Import replies error');
            next(new AppError('Failed to import replies', 500));
        }
    }
);

// ── POST /api/plusvibe/import-campaign — import replies for a single campaign ──
// Used by the frontend step-by-step import flow. Accepts { pv_campaign_id }.
router.post(
    '/import-campaign',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const pvCampaignId = req.body.pv_campaign_id as string;

            if (!pvCampaignId || typeof pvCampaignId !== 'string') {
                res.status(400).json({ error: 'pv_campaign_id is required' });
                return;
            }

            // Verify campaign is assigned to this tenant
            const { data: campaign } = await supabaseAdmin
                .from('plusvibe_campaigns')
                .select('pv_campaign_id, name, tenant_id')
                .eq('pv_campaign_id', pvCampaignId)
                .eq('tenant_id', tenantId)
                .single();

            if (!campaign || campaign.tenant_id !== tenantId) {
                res.status(403).json({ error: 'Campaign not assigned to this tenant' });
                return;
            }

            const matchEmail = await buildTenantMatcher(tenantId);

            const replies = await fetchAllReplies(pvCampaignId);
            log.info({ campaign: pvCampaignId, fetchedTotal: replies.length }, 'Fetched replies from PlusVibe API');

            if (replies.length > 0) {
                const dates = replies.map(r => r.timestamp_created).filter(Boolean).sort();
                log.info({ oldest: dates[0], newest: dates[dates.length - 1] }, 'Fetched date range');
            }

            const { imported, skipped, enriched } = await enrichOrInsertReplies({
                tenantId,
                pvCampaignId,
                campaignName: campaign.name,
                replies,
                matchEmail,
            });

            log.info({ campaign: pvCampaignId, imported, skipped, enriched, fetched: replies.length }, 'Import completed');
            res.json({ imported, skipped, enriched, fetched: replies.length });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Import campaign error');
            next(new AppError('Failed to import campaign replies', 500));
        }
    }
);

// ── Helper: sync campaigns from PlusVibe API to local cache ──

async function syncCampaigns(): Promise<number> {
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

    log.info({ count: campaigns.length }, 'Campaigns synced');
    return campaigns.length;
}

export default router;
