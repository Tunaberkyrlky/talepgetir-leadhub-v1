/**
 * Campaign Routes — CRUD + Enrollment + Stats
 * Pattern: routes/settings.ts (CRUD + validation + middleware)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole, requireTier } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { validateBody, createCampaignSchema, updateCampaignSchema, saveStepsSchema, enrollLeadsSchema } from '../lib/validation.js';
import { enrollLeads, getCampaignStats } from '../lib/campaignEngine.js';
import { sanitizeSearch } from '../lib/queryUtils.js';
import posthog from '../lib/posthog.js';

const VALID_CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'completed'];

const log = createLogger('route:campaigns');
const router = Router();

router.use(requireRole('superadmin', 'ops_agent', 'client_admin'));
router.use(requireTier('pro'));

// ── GET /api/campaigns ─────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { status, search } = req.query;
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
        const offset = (page - 1) * limit;

        let query = supabaseAdmin
            .from('campaigns')
            .select('*', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (status) {
            if (!VALID_CAMPAIGN_STATUSES.includes(String(status))) {
                res.status(400).json({ error: 'Invalid campaign status' }); return;
            }
            query = query.eq('status', String(status));
        }
        if (search && typeof search === 'string' && search.trim()) {
            const safe = sanitizeSearch(search.trim());
            if (safe.length > 0) query = query.ilike('name', `%${safe}%`);
        }

        const { data, count, error } = await query;
        if (error) throw new AppError('Failed to fetch campaigns', 500);

        res.json({
            data: data || [],
            pagination: {
                page, limit, total: count || 0,
                totalPages: Math.ceil((count || 0) / limit),
                hasNext: page < Math.ceil((count || 0) / limit),
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'List campaigns error');
        res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
});

// ── POST /api/campaigns ────────────────────────────────────────────────────

router.post('/', validateBody(createCampaignSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { name, description, from_name, settings } = req.body;
        const { data, error } = await supabaseAdmin
            .from('campaigns')
            .insert({
                tenant_id: req.tenantId!,
                name,
                description: description || null,
                from_name: from_name || null,
                settings: settings || {},
                created_by: req.user!.id,
            })
            .select()
            .single();

        if (error) throw new AppError('Failed to create campaign', 500);
        posthog.capture({
            distinctId: req.user!.id,
            event: 'campaign_created',
            properties: {
                campaign_id: data.id,
                campaign_name: data.name,
                tenant_id: req.tenantId!,
            },
        });
        res.status(201).json({ data });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Create campaign error');
        res.status(500).json({ error: 'Failed to create campaign' });
    }
});

// ── GET /api/campaigns/:id ─────────────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const id = req.params.id as string;
        const [campaignRes, stepsRes] = await Promise.all([
            supabaseAdmin.from('campaigns').select('*')
                .eq('id', id).eq('tenant_id', req.tenantId!).single(),
            supabaseAdmin.from('campaign_steps').select('*')
                .eq('campaign_id', id).order('step_order'),
        ]);

        if (campaignRes.error || !campaignRes.data) {
            res.status(404).json({ error: 'Campaign not found' }); return;
        }

        const stats = await getCampaignStats(id, req.tenantId!);

        res.json({
            data: { ...campaignRes.data, steps: stepsRes.data || [], stats },
        });
    } catch (err) {
        log.error({ err }, 'Get campaign error');
        res.status(500).json({ error: 'Failed to fetch campaign' });
    }
});

// ── PUT /api/campaigns/:id ─────────────────────────────────────────────────

router.put('/:id', validateBody(updateCampaignSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { data, error } = await supabaseAdmin
            .from('campaigns')
            .update(req.body)
            .eq('id', (req.params.id as string))
            .eq('tenant_id', req.tenantId!)
            .select()
            .single();

        if (error || !data) { res.status(404).json({ error: 'Campaign not found' }); return; }
        res.json({ data });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Update campaign error');
        res.status(500).json({ error: 'Failed to update campaign' });
    }
});

// ── DELETE /api/campaigns/:id ──────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { data: campaign } = await supabaseAdmin
            .from('campaigns').select('status')
            .eq('id', (req.params.id as string)).eq('tenant_id', req.tenantId!).single();

        if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
        if (campaign.status !== 'draft') {
            res.status(422).json({ error: 'Only draft campaigns can be deleted' }); return;
        }

        await supabaseAdmin.from('campaigns').delete().eq('id', (req.params.id as string)).eq('tenant_id', req.tenantId!);
        res.status(204).send();
    } catch (err) {
        log.error({ err }, 'Delete campaign error');
        res.status(500).json({ error: 'Failed to delete campaign' });
    }
});

// ── PUT /api/campaigns/:id/steps ───────────────────────────────────────────

router.put('/:id/steps', validateBody(saveStepsSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const { data: campaign } = await supabaseAdmin
            .from('campaigns').select('status')
            .eq('id', id).eq('tenant_id', req.tenantId!).single();

        if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
        if (campaign.status === 'active') {
            res.status(422).json({ error: 'Cannot edit steps of an active campaign. Pause first.' }); return;
        }

        // Atomic replace: delete + re-insert. If insert fails, restore old steps.
        const { data: oldSteps } = await supabaseAdmin
            .from('campaign_steps').select('*').eq('campaign_id', id).order('step_order');

        await supabaseAdmin.from('campaign_steps').delete().eq('campaign_id', id);

        const rows = req.body.steps.map((s: any, i: number) => ({
            campaign_id: id,
            step_order: i + 1,
            step_type: s.step_type,
            subject: s.subject || null,
            body_html: s.body_html || null,
            body_text: s.body_text || null,
            delay_days: s.delay_days || 0,
            delay_hours: s.delay_hours || 0,
        }));

        const { data, error } = await supabaseAdmin.from('campaign_steps').insert(rows).select();
        if (error) {
            // Rollback: restore old steps
            if (oldSteps?.length) {
                const restore = oldSteps.map(({ id: _id, created_at: _c, updated_at: _u, ...rest }) => rest);
                await supabaseAdmin.from('campaign_steps').insert(restore);
            }
            throw new AppError('Failed to save steps', 500);
        }
        res.json({ data });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Save steps error');
        res.status(500).json({ error: 'Failed to save steps' });
    }
});

// ── POST /api/campaigns/:id/activate ───────────────────────────────────────

router.post('/:id/activate', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { id } = req.params;

        const { data: campaign } = await supabaseAdmin
            .from('campaigns').select('status')
            .eq('id', id).eq('tenant_id', tenantId).single();

        if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
        if (campaign.status === 'active') { res.status(422).json({ error: 'Already active' }); return; }

        const { data: steps } = await supabaseAdmin
            .from('campaign_steps').select('step_type').eq('campaign_id', id);
        if (!steps?.some((s) => s.step_type === 'email')) {
            res.status(422).json({ error: 'Campaign must have at least one email step' }); return;
        }

        const { data: conn } = await supabaseAdmin
            .from('email_connections').select('id')
            .eq('tenant_id', tenantId).eq('is_active', true).single();
        if (!conn) {
            res.status(422).json({ error: 'No email connection. Connect Gmail or Outlook first.' }); return;
        }

        const { data, error } = await supabaseAdmin
            .from('campaigns').update({ status: 'active' }).eq('id', id).select().single();
        if (error) throw new AppError('Failed to activate', 500);

        log.info({ campaignId: id, tenantId }, 'Campaign activated');
        res.json({ data });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Activate error');
        res.status(500).json({ error: 'Failed to activate campaign' });
    }
});

// ── POST /api/campaigns/:id/pause ──────────────────────────────────────────

router.post('/:id/pause', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { data, error } = await supabaseAdmin
            .from('campaigns').update({ status: 'paused' })
            .eq('id', (req.params.id as string)).eq('tenant_id', req.tenantId!).eq('status', 'active')
            .select().single();

        if (error || !data) { res.status(422).json({ error: 'Campaign is not active' }); return; }

        // Pause all active enrollments
        await supabaseAdmin
            .from('campaign_enrollments')
            .update({ status: 'paused', next_scheduled_at: null })
            .eq('campaign_id', (req.params.id as string))
            .eq('status', 'active');

        log.info({ campaignId: (req.params.id as string) }, 'Campaign paused');
        res.json({ data });
    } catch (err) {
        log.error({ err }, 'Pause error');
        res.status(500).json({ error: 'Failed to pause campaign' });
    }
});

// ── POST /api/campaigns/:id/enroll ─────────────────────────────────────────

router.post('/:id/enroll', validateBody(enrollLeadsSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const result = await enrollLeads((req.params.id as string), req.tenantId!, req.user!.id, req.body.contacts);
        posthog.capture({
            distinctId: req.user!.id,
            event: 'campaign_leads_enrolled',
            properties: {
                campaign_id: req.params.id,
                contacts_count: Array.isArray(req.body.contacts) ? req.body.contacts.length : 0,
                tenant_id: req.tenantId!,
            },
        });
        res.json(result);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Enroll error');
        res.status(500).json({ error: 'Failed to enroll leads' });
    }
});

// ── GET /api/campaigns/:id/enrollments ─────────────────────────────────────

router.get('/:id/enrollments', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { data, error } = await supabaseAdmin
            .from('campaign_enrollments')
            .select(`
                id, email, status, current_step_id, next_scheduled_at,
                enrolled_at, completed_at,
                contacts(first_name, last_name, email),
                companies(name),
                campaign_steps(step_order, step_type)
            `)
            .eq('campaign_id', (req.params.id as string))
            .eq('tenant_id', req.tenantId!)
            .order('enrolled_at', { ascending: false });

        if (error) throw new AppError('Failed to fetch enrollments', 500);

        const mapped = (data || []).map((e: any) => ({
            id: e.id,
            email: e.email,
            status: e.status,
            contact_name: [e.contacts?.first_name, e.contacts?.last_name].filter(Boolean).join(' '),
            company_name: e.companies?.name || '',
            current_step_order: e.campaign_steps?.step_order || null,
            current_step_type: e.campaign_steps?.step_type || null,
            next_scheduled_at: e.next_scheduled_at,
            enrolled_at: e.enrolled_at,
            completed_at: e.completed_at,
        }));

        res.json({ data: mapped });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Enrollments error');
        res.status(500).json({ error: 'Failed to fetch enrollments' });
    }
});

// ── GET /api/campaigns/:id/stats ───────────────────────────────────────────

router.get('/:id/stats', async (req: Request, res: Response): Promise<void> => {
    try {
        const { data: campaign } = await supabaseAdmin
            .from('campaigns').select('id')
            .eq('id', (req.params.id as string)).eq('tenant_id', req.tenantId!).single();
        if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }

        const stats = await getCampaignStats((req.params.id as string), req.tenantId!);
        res.json(stats);
    } catch (err) {
        log.error({ err }, 'Stats error');
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

export default router;
