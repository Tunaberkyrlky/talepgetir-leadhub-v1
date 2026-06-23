import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { isInternalRole } from '../lib/roles.js';
import {
    isConfigured,
    checkConnection,
    getCampaignSummary,
    getCampaignStats,
    fetchAllReplies,
} from '../lib/plusvibeClient.js';
import { validateBody, prefixRuleSchema, campaignStatsQuerySchema } from '../lib/validation.js';
import {
    buildTenantMatcher,
    enrichOrInsertReplies,
    syncCampaigns,
    hydrateCampaignSendsForCampaign,
    recomputeCampaignAssignments,
} from '../lib/mail/replyImport.js';

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

// ── Prefix rules — campaign→tenant assignment is fully prefix-driven (internal only) ──
// A campaign is auto-assigned to the tenant whose configured prefix its name starts
// with (e.g. "NTR - Asia" → the tenant owning "NTR"). Replaces per-campaign assign.

// GET /api/plusvibe/prefix-rules — list rules (with tenant name)
router.get(
    '/prefix-rules',
    requireRole('superadmin', 'ops_agent'),
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { data, error } = await supabaseAdmin
                .from('campaign_prefix_rules')
                .select('id, prefix, tenant_id, created_at, tenants(name)')
                .order('prefix', { ascending: true });
            if (error) throw new AppError('Failed to fetch prefix rules', 500);
            res.json({ data: data ?? [] });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'List prefix rules error');
            next(new AppError('Failed to fetch prefix rules', 500));
        }
    }
);

// POST /api/plusvibe/prefix-rules — add a rule, then recompute all assignments
router.post(
    '/prefix-rules',
    requireRole('superadmin', 'ops_agent'),
    validateBody(prefixRuleSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { tenant_id, prefix } = req.body as { tenant_id: string; prefix: string };

            const { data: tenant } = await supabaseAdmin
                .from('tenants')
                .select('id, name')
                .eq('id', tenant_id)
                .single();
            if (!tenant) throw new AppError('Tenant not found', 404);

            const { data, error } = await supabaseAdmin
                .from('campaign_prefix_rules')
                .insert({ tenant_id, prefix: prefix.trim() })
                .select('id, prefix, tenant_id, created_at')
                .single();

            if (error) {
                if (error.code === '23505') {
                    res.status(409).json({ error: 'Bu prefix zaten tanımlı.' });
                    return;
                }
                throw new AppError('Failed to create prefix rule', 500);
            }

            log.info({ prefix, tenantId: tenant_id, tenantName: tenant.name }, 'Prefix rule created');
            // Re-derive every campaign's tenant from the new rule set; new assignments
            // get their threads backfilled. Fire-and-forget — don't block the response.
            recomputeCampaignAssignments().catch((e) => log.warn({ err: e }, 'Recompute after rule add failed'));

            res.status(201).json(data);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Create prefix rule error');
            next(new AppError('Failed to create prefix rule', 500));
        }
    }
);

// DELETE /api/plusvibe/prefix-rules/:id — remove a rule, then recompute
router.delete(
    '/prefix-rules/:id',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { id } = req.params;
            const { error } = await supabaseAdmin
                .from('campaign_prefix_rules')
                .delete()
                .eq('id', id);
            if (error) throw new AppError('Failed to delete prefix rule', 500);

            log.info({ ruleId: id }, 'Prefix rule deleted');
            // Campaigns matching only this prefix become unassigned on recompute.
            recomputeCampaignAssignments().catch((e) => log.warn({ err: e }, 'Recompute after rule delete failed'));

            res.json({ ok: true });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Delete prefix rule error');
            next(new AppError('Failed to delete prefix rule', 500));
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

                    // Backfill our outbound first-touch + steps for these threads.
                    // Fire-and-forget — one API call per replied lead, can be slow on big campaigns.
                    hydrateCampaignSendsForCampaign({
                        tenantId,
                        pvCampaignId: campaign.pv_campaign_id,
                        campaignName: campaign.name,
                        matchEmail,
                    }).catch((err) =>
                        log.warn({ err, campaignId: campaign.pv_campaign_id }, 'Campaign-send backfill failed'),
                    );
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

            // Backfill our outbound first-touch + steps in the BACKGROUND. One API call
            // per replied lead can take a while on big campaigns; awaiting it would push
            // the request past the client's 60s timeout and abort the per-campaign import
            // loop. Fire-and-forget instead — the first-touch rows populate shortly after.
            // NOTE: this relies on a long-lived worker (Railway). Under a serverless model
            // the function could freeze after the response and drop this work.
            hydrateCampaignSendsForCampaign({
                tenantId,
                pvCampaignId,
                campaignName: campaign.name,
                matchEmail,
            }).catch((err) =>
                log.warn({ err, campaign: pvCampaignId }, 'Campaign-send backfill failed'),
            );

            log.info({ campaign: pvCampaignId, imported, skipped, enriched, fetched: replies.length }, 'Import completed (outbound backfilling in background)');
            res.json({ imported, skipped, enriched, fetched: replies.length, outbound: 'backfilling' });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Import campaign error');
            next(new AppError('Failed to import campaign replies', 500));
        }
    }
);

export default router;
