/**
 * Campaign Routes — CRUD + Enrollment + Stats
 * Pattern: routes/settings.ts (CRUD + validation + middleware)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole, requireTier } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { validateBody, createCampaignSchema, updateCampaignSchema, saveStepsSchema, saveGraphSchema, enrollLeadsSchema, audienceFilterSchema, testSendSchema, bulkEnrollmentActionSchema } from '../lib/validation.js';
import { enrollLeads, getCampaignStats, sendTestEmail, resumePausedEnrollments, pauseEnrollment, resumeEnrollment, bulkPauseEnrollments, bulkResumeEnrollments } from '../lib/campaignEngine.js';
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

        // Sıralama — yalnızca gerçek kolonlara izin ver (allow-list), aksi halde created_at.
        const SORTABLE = ['created_at', 'name', 'status', 'updated_at'];
        const sort = SORTABLE.includes(String(req.query.sort)) ? String(req.query.sort) : 'created_at';
        const ascending = String(req.query.dir) === 'asc';

        let query = supabaseAdmin
            .from('campaigns')
            .select('*', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .order(sort, { ascending })
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

        // Listedeki kampanyalar için kompakt metrikler (gönderildi/açılma/yanıt) —
        // tek seferde 2 sorgu, JS'te kampanya başına toplanır.
        const campaigns = data || [];
        const ids = campaigns.map((c) => c.id);
        const statsById: Record<string, { sent: number; opens: number; replies: number }> = {};
        const lastSentById: Record<string, string | null> = {};
        for (const id of ids) { statsById[id] = { sent: 0, opens: 0, replies: 0 }; lastSentById[id] = null; }

        if (ids.length > 0) {
            const [actsRes, repliedRes] = await Promise.all([
                supabaseAdmin.from('activities')
                    .select('campaign_id, outcome, occurred_at, campaign_email_events(event_type)')
                    .in('campaign_id', ids).eq('tenant_id', tenantId).eq('type', 'campaign_email'),
                supabaseAdmin.from('campaign_enrollments')
                    .select('campaign_id, status')
                    .in('campaign_id', ids).eq('tenant_id', tenantId).eq('status', 'replied'),
            ]);
            for (const a of (actsRes.data || []) as any[]) {
                if (a.outcome !== 'sent') continue;
                const s = statsById[a.campaign_id]; if (!s) continue;
                s.sent++;
                if ((a.campaign_email_events || []).some((e: any) => e.event_type === 'open')) s.opens++;
                // Son gönderim — kampanya başına en yeni 'sent' aktivitesinin zamanı.
                if (a.occurred_at && (!lastSentById[a.campaign_id] || a.occurred_at > lastSentById[a.campaign_id]!)) {
                    lastSentById[a.campaign_id] = a.occurred_at;
                }
            }
            for (const e of (repliedRes.data || []) as any[]) {
                const s = statsById[e.campaign_id]; if (s) s.replies++;
            }
        }

        res.json({
            data: campaigns.map((c) => ({ ...c, stats: statsById[c.id], last_sent_at: lastSentById[c.id] })),
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

router.put('/:id/steps', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const { data: campaign } = await supabaseAdmin
            .from('campaigns').select('status')
            .eq('id', id).eq('tenant_id', req.tenantId!).single();

        if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
        if (campaign.status === 'active') {
            res.status(422).json({ error: 'Cannot edit steps of an active campaign. Pause first.' }); return;
        }

        // ── Graf kaydı (Faz 2): client {nodes:[...]} stabil id'lerle gönderirse
        //    upsert + prune RPC'sine ver. Aksi halde eski lineer {steps} yolu. ──
        if (Array.isArray(req.body?.nodes)) {
            const parsed = saveGraphSchema.safeParse(req.body);
            if (!parsed.success) {
                res.status(400).json({ error: 'Validation failed', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
                return;
            }
            // Canlı-kayıt koruması: bir enrollment'ın şu an ÜZERİNDE durduğu node silinemez.
            const incoming = new Set(parsed.data.nodes.map((n) => n.id));
            const { data: liveEnr } = await supabaseAdmin
                .from('campaign_enrollments').select('current_step_id')
                .eq('campaign_id', id).in('status', ['active', 'paused']);
            if ((liveEnr || []).some((e) => e.current_step_id && !incoming.has(e.current_step_id))) {
                res.status(422).json({ error: 'Cannot delete a step that enrollments are currently at. Pause/remove them first.' });
                return;
            }
            const { data, error } = await supabaseAdmin.rpc('save_campaign_graph', { p_campaign_id: id, p_nodes: parsed.data.nodes });
            if (error) { log.error({ err: error }, 'save_campaign_graph RPC failed'); throw new AppError('Failed to save graph', 500); }
            res.json({ data });
            return;
        }

        // ── Legacy lineer yol ──
        const linear = saveStepsSchema.safeParse(req.body);
        if (!linear.success) {
            res.status(400).json({ error: 'Validation failed', details: linear.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
            return;
        }
        req.body = linear.data;

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

        const { count: connCount } = await supabaseAdmin
            .from('email_connections').select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId).eq('is_active', true);
        if (!connCount) {
            res.status(422).json({ error: 'No email connection. Connect Gmail, Outlook or SMTP first.' }); return;
        }

        const { data, error } = await supabaseAdmin
            .from('campaigns').update({ status: 'active' }).eq('id', id).select().single();
        if (error || !data) throw new AppError('Failed to activate', 500);

        // Daha önce duraklamış kayıtları kaldıkları adımdan sürdür.
        const resumed = await resumePausedEnrollments(id as string, tenantId, data.settings || {});

        log.info({ campaignId: id, tenantId, resumed }, 'Campaign activated');
        res.json({ data, resumed });
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

// ── POST /api/campaigns/:id/test (test gönderimi) ──────────────────────────

router.post('/:id/test', validateBody(testSendSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { data: campaign } = await supabaseAdmin
            .from('campaigns').select('from_name')
            .eq('id', (req.params.id as string)).eq('tenant_id', req.tenantId!).single();
        if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }

        await sendTestEmail(req.tenantId!, req.body.to, req.body.subject || '', req.body.body_html || '', campaign.from_name);
        res.json({ sent: true, to: req.body.to });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Test send error');
        res.status(500).json({ error: 'Failed to send test email' });
    }
});

// ── Audience filtresi (filtreyle kişi seçimi/kaydı) ────────────────────────

interface AudienceFilters {
    search?: string;
    stages?: string[];
    industries?: string[];
    countries?: string[];
    seniorities?: string[];
}

const MAX_FILTER_ENROLL = 2000;

// Tek sorguda kişileri çözer. stage/industry şirket seviyesi (companies!inner join),
// country/seniority kişi seviyesi. count tüm eşleşmeyi verir; satırlar `limit` ile sınırlı.
async function resolveAudience(tenantId: string, filters: AudienceFilters, limit: number) {
    let q = supabaseAdmin
        .from('contacts')
        .select('id, first_name, last_name, email, company_id, companies!inner(name, stage, industry)', { count: 'exact' })
        .eq('tenant_id', tenantId)
        .not('email', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(limit);

    if (filters.stages?.length) q = q.in('companies.stage', filters.stages);
    if (filters.industries?.length) q = q.in('companies.industry', filters.industries);
    if (filters.countries?.length) q = q.in('country', filters.countries);
    if (filters.seniorities?.length) q = q.in('seniority', filters.seniorities);
    if (filters.search && filters.search.trim()) {
        const safe = sanitizeSearch(filters.search.trim());
        if (safe.length > 0) q = q.or(`first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,email.ilike.%${safe}%`);
    }

    const { data, count, error } = await q;
    if (error) throw new AppError('Failed to resolve audience', 500);

    const contacts = (data || []).map((c: any) => ({
        contact_id: c.id as string,
        company_id: c.company_id as string,
        email: c.email as string,
        name: [c.first_name, c.last_name].filter(Boolean).join(' '),
        company_name: c.companies?.name || '',
    }));
    return { total: count || 0, contacts };
}

// ── POST /api/campaigns/:id/audience/preview ───────────────────────────────

router.post('/:id/audience/preview', validateBody(audienceFilterSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { total, contacts } = await resolveAudience(req.tenantId!, req.body, 50);
        res.json({ total, contacts });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Audience preview error');
        res.status(500).json({ error: 'Failed to preview audience' });
    }
});

// ── POST /api/campaigns/:id/enroll-filter ──────────────────────────────────

router.post('/:id/enroll-filter', validateBody(audienceFilterSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { total, contacts } = await resolveAudience(req.tenantId!, req.body, MAX_FILTER_ENROLL);
        if (!contacts.length) { res.json({ matched: 0, enrolled: 0, skipped: 0, capped: false }); return; }

        const result = await enrollLeads((req.params.id as string), req.tenantId!, req.user!.id, contacts);
        posthog.capture({
            distinctId: req.user!.id,
            event: 'campaign_leads_enrolled',
            properties: { campaign_id: req.params.id, contacts_count: contacts.length, via: 'filter', tenant_id: req.tenantId! },
        });
        res.json({ matched: total, enrolled: result.enrolled, skipped: result.skipped, capped: total > MAX_FILTER_ENROLL });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Enroll-filter error');
        res.status(500).json({ error: 'Failed to enroll filtered audience' });
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
                email_status, dnc_status, excluded_reason, custom_body_text,
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
            email_status: e.email_status || null,
            dnc_status: e.dnc_status || null,
            excluded_reason: e.excluded_reason || null,
            has_custom_message: !!e.custom_body_text,
        }));

        res.json({ data: mapped });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Enrollments error');
        res.status(500).json({ error: 'Failed to fetch enrollments' });
    }
});

// ── Tek enrollment aksiyonları: durdur / devam / çıkar ──────────────────────

router.post('/:id/enrollments/:enrollmentId/pause', async (req: Request, res: Response): Promise<void> => {
    try {
        const ok = await pauseEnrollment((req.params.id as string), (req.params.enrollmentId as string), req.tenantId!);
        if (!ok) { res.status(422).json({ error: 'Enrollment is not active' }); return; }
        res.json({ ok: true });
    } catch (err) {
        log.error({ err }, 'Pause enrollment error');
        res.status(500).json({ error: 'Failed to pause enrollment' });
    }
});

router.post('/:id/enrollments/:enrollmentId/resume', async (req: Request, res: Response): Promise<void> => {
    try {
        const { data: campaign } = await supabaseAdmin
            .from('campaigns').select('settings')
            .eq('id', (req.params.id as string)).eq('tenant_id', req.tenantId!).single();
        const ok = await resumeEnrollment((req.params.id as string), (req.params.enrollmentId as string), req.tenantId!, campaign?.settings || {});
        if (!ok) { res.status(422).json({ error: 'Enrollment is not paused' }); return; }
        res.json({ ok: true });
    } catch (err) {
        log.error({ err }, 'Resume enrollment error');
        res.status(500).json({ error: 'Failed to resume enrollment' });
    }
});

router.delete('/:id/enrollments/:enrollmentId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { error } = await supabaseAdmin
            .from('campaign_enrollments').delete()
            .eq('id', (req.params.enrollmentId as string))
            .eq('campaign_id', (req.params.id as string))
            .eq('tenant_id', req.tenantId!);
        if (error) throw new AppError('Failed to remove enrollment', 500);
        res.json({ ok: true });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Remove enrollment error');
        res.status(500).json({ error: 'Failed to remove enrollment' });
    }
});

// ── POST /api/campaigns/:id/enrollments/bulk — toplu duraklat/sürdür/çıkar ──

router.post('/:id/enrollments/bulk', validateBody(bulkEnrollmentActionSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const campaignId = req.params.id as string;
        const tenantId = req.tenantId!;
        const { action, ids } = req.body as { action: 'pause' | 'resume' | 'remove'; ids: string[] };

        let affected = 0;
        if (action === 'remove') {
            const { data, error } = await supabaseAdmin
                .from('campaign_enrollments').delete()
                .in('id', ids).eq('campaign_id', campaignId).eq('tenant_id', tenantId)
                .select('id');
            if (error) throw new AppError('Failed to remove enrollments', 500);
            affected = data?.length || 0;
        } else if (action === 'pause') {
            affected = await bulkPauseEnrollments(campaignId, ids, tenantId);
        } else {
            const { data: campaign } = await supabaseAdmin
                .from('campaigns').select('settings')
                .eq('id', campaignId).eq('tenant_id', tenantId).single();
            affected = await bulkResumeEnrollments(campaignId, ids, tenantId, campaign?.settings || {});
        }

        res.json({ ok: true, affected });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Bulk enrollment action error');
        res.status(500).json({ error: 'Failed to apply bulk action' });
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
