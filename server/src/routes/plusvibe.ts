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
} from '../lib/plusvibeClient.js';
import { matchSenderEmail } from '../lib/emailMatcher.js';
import { validateBody, assignCampaignSchema, campaignStatsQuerySchema } from '../lib/validation.js';

const log = createLogger('route:plusvibe');
const router = Router();

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

            // Pre-fetch all contacts + companies for this tenant (batch match instead of per-reply)
            const { data: tenantContacts } = await supabaseAdmin
                .from('contacts')
                .select('id, email, company_id, is_primary, updated_at')
                .eq('tenant_id', tenantId)
                .not('email', 'is', null);

            const { data: tenantCompanies } = await supabaseAdmin
                .from('companies')
                .select('id, company_email')
                .eq('tenant_id', tenantId)
                .not('company_email', 'is', null);

            // Build lookup maps for O(1) matching
            const contactsByEmail = new Map<string, { id: string; company_id: string }>();
            for (const c of tenantContacts || []) {
                const e = (c.email as string).toLowerCase().trim();
                // Keep primary or most recently updated
                if (!contactsByEmail.has(e) || c.is_primary) {
                    contactsByEmail.set(e, { id: c.id, company_id: c.company_id });
                }
            }
            const companyByEmail = new Map<string, string>();
            for (const c of tenantCompanies || []) {
                companyByEmail.set((c.company_email as string).toLowerCase().trim(), c.id);
            }

            function matchEmail(email: string) {
                const e = email.toLowerCase().trim();
                const contact = contactsByEmail.get(e);
                if (contact) return { company_id: contact.company_id, contact_id: contact.id, match_status: 'matched' as const };
                const companyId = companyByEmail.get(e);
                if (companyId) return { company_id: companyId, contact_id: null, match_status: 'matched' as const };
                return { company_id: null, contact_id: null, match_status: 'unmatched' as const };
            }

            for (const campaign of safeCampaigns) {
                try {
                    const replies = await fetchAllReplies(campaign.pv_campaign_id);
                    totalFetched += replies.length;
                    log.info({ campaignId: campaign.pv_campaign_id, name: campaign.name, replies: replies.length }, 'Fetched replies');

                    if (replies.length === 0) continue;

                    // Get existing reply keys for this campaign to skip duplicates
                    const { data: existing } = await supabaseAdmin
                        .from('email_replies')
                        .select('sender_email, replied_at')
                        .eq('tenant_id', tenantId)
                        .eq('campaign_id', campaign.pv_campaign_id);

                    const existingKeys = new Set(
                        (existing || []).map((r: { sender_email: string; replied_at: string }) =>
                            `${r.sender_email}|${r.replied_at}`
                        )
                    );

                    // Filter new replies and build rows
                    const newRows = [];
                    for (const reply of replies) {
                        const senderEmail = reply.from_address_email.toLowerCase().trim();
                        const repliedAt = reply.timestamp_created || new Date().toISOString();
                        const key = `${senderEmail}|${repliedAt}`;

                        if (existingKeys.has(key)) {
                            totalSkipped++;
                            continue;
                        }

                        const match = matchEmail(reply.from_address_email);
                        newRows.push({
                            tenant_id: tenantId,
                            campaign_id: campaign.pv_campaign_id,
                            campaign_name: campaign.name,
                            sender_email: senderEmail,
                            reply_body: reply.content_preview || reply.body || null,
                            replied_at: repliedAt,
                            company_id: match.company_id,
                            contact_id: match.contact_id,
                            match_status: match.match_status,
                            read_status: reply.is_unread ? 'unread' : 'read',
                            raw_payload: { source: 'plusvibe_api_import', plusvibe_email_id: reply.id, label: reply.label, subject: reply.subject || null, from_address: reply.to_address_email_list || null },
                        });
                        existingKeys.add(key);
                    }

                    // Batch insert (500 rows per batch)
                    for (let i = 0; i < newRows.length; i += 500) {
                        const batch = newRows.slice(i, i + 500);
                        const { error } = await supabaseAdmin
                            .from('email_replies')
                            .insert(batch);
                        if (!error) totalImported += batch.length;
                        else log.warn({ err: error, batch: i }, 'Batch insert partial failure');
                    }
                } catch (err) {
                    log.warn({ err, campaignId: campaign.pv_campaign_id }, 'Failed to import replies for campaign');
                }
            }

            log.info({ tenantId, totalImported, totalSkipped, totalFetched }, 'Reply import completed');
            res.json({ imported: totalImported, skipped: totalSkipped, fetched: totalFetched });
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

            // Pre-fetch contacts + companies for matching
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
                if (!contactsByEmail.has(e) || c.is_primary) {
                    contactsByEmail.set(e, { id: c.id, company_id: c.company_id });
                }
            }
            const companyByEmail = new Map<string, string>();
            for (const c of tenantCompanies || []) {
                companyByEmail.set((c.company_email as string).toLowerCase().trim(), c.id);
            }

            function matchEmail(email: string) {
                const e = email.toLowerCase().trim();
                const contact = contactsByEmail.get(e);
                if (contact) return { company_id: contact.company_id, contact_id: contact.id, match_status: 'matched' as const };
                const companyId = companyByEmail.get(e);
                if (companyId) return { company_id: companyId, contact_id: null, match_status: 'matched' as const };
                return { company_id: null, contact_id: null, match_status: 'unmatched' as const };
            }

            const replies = await fetchAllReplies(pvCampaignId);
            log.info({ campaign: pvCampaignId, fetchedTotal: replies.length }, 'Fetched replies from PlusVibe API');

            if (replies.length > 0) {
                const dates = replies.map(r => r.timestamp_created).filter(Boolean).sort();
                log.info({ oldest: dates[0], newest: dates[dates.length - 1] }, 'Fetched date range');
            }

            const { data: existing } = await supabaseAdmin
                .from('email_replies')
                .select('sender_email, replied_at')
                .eq('tenant_id', tenantId)
                .eq('campaign_id', pvCampaignId);

            // Normalize timestamps to ISO for consistent dedup comparison
            // DB returns "2026-04-03 12:13:57.826+00", API returns "2026-04-03T12:13:57.826Z"
            const normalizeTs = (ts: string) => new Date(ts).toISOString();

            const existingKeys = new Set(
                (existing || []).map((r: { sender_email: string; replied_at: string }) =>
                    `${r.sender_email}|${normalizeTs(r.replied_at)}`
                )
            );

            const newRows = [];
            let skipped = 0;
            for (const reply of replies) {
                const senderEmail = reply.from_address_email.toLowerCase().trim();
                const repliedAt = reply.timestamp_created || new Date().toISOString();
                const key = `${senderEmail}|${normalizeTs(repliedAt)}`;
                if (existingKeys.has(key)) { skipped++; continue; }
                const match = matchEmail(reply.from_address_email);
                const pvLead = reply.lead || {};
                newRows.push({
                    tenant_id: tenantId,
                    campaign_id: pvCampaignId,
                    campaign_name: campaign.name,
                    sender_email: senderEmail,
                    reply_body: reply.content_preview || reply.body || null,
                    replied_at: repliedAt,
                    company_id: match.company_id,
                    contact_id: match.contact_id,
                    match_status: match.match_status,
                    read_status: reply.is_unread ? 'unread' : 'read',
                    label: reply.label || null,
                    sentiment: ((pvLead as Record<string, unknown>).sentiment as string) ?? null,
                    subject: reply.subject || null,
                    plusvibe_lead_id: reply.lead_id || null,
                    raw_payload: { source: 'plusvibe_api_import', plusvibe_email_id: reply.id, label: reply.label, subject: reply.subject || null, from_address: reply.to_address_email_list || null },
                });
                existingKeys.add(key);
            }

            let imported = 0;
            for (let i = 0; i < newRows.length; i += 500) {
                const batch = newRows.slice(i, i + 500);
                const { error } = await supabaseAdmin.from('email_replies').insert(batch);
                if (error) {
                    if (error.code === '23505') {
                        // Duplicate in batch — fall back to one-by-one insert
                        log.info({ batch: i / 500, batchSize: batch.length }, 'Batch has duplicates, inserting individually');
                        for (const row of batch) {
                            const { error: rowErr } = await supabaseAdmin.from('email_replies').insert(row);
                            if (!rowErr) imported++;
                            // silently skip duplicates
                        }
                    } else {
                        log.warn({ err: error, batch: i / 500 }, 'Batch insert failed during import');
                    }
                } else {
                    imported += batch.length;
                }
            }

            log.info({ campaign: pvCampaignId, imported, skipped, fetched: replies.length, existingCount: existing?.length ?? 0 }, 'Import completed');
            res.json({ imported, skipped, fetched: replies.length });
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
