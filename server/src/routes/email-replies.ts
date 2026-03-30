import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin, createUserClient } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { validateBody, assignReplySchema } from '../lib/validation.js';
import { isInternalRole } from '../lib/roles.js';

const log = createLogger('route:email-replies');
const router = Router();

function dbClient(req: Request) {
    if (isInternalRole(req.user!.role)) return supabaseAdmin;
    return createUserClient(req.accessToken!);
}

// GET /api/email-replies — paginated list with filters
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
        const offset = (page - 1) * limit;
        const { campaign_id, match_status, read_status, date_from, date_to, search } = req.query;

        const db = dbClient(req);
        let query = db
            .from('email_replies')
            .select('*', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .order('replied_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (campaign_id) query = query.eq('campaign_id', campaign_id as string);
        if (match_status) query = query.eq('match_status', match_status as string);
        if (read_status) query = query.eq('read_status', read_status as string);
        if (date_from) query = query.gte('replied_at', date_from as string);
        if (date_to) query = query.lte('replied_at', date_to as string);
        if (search) {
            const term = (search as string).replace(/%/g, '\\%').replace(/_/g, '\\_');
            query = query.or(`reply_body.ilike.%${term}%,sender_email.ilike.%${term}%`);
        }

        const { data, count, error } = await query;

        if (error) {
            log.error({ err: error }, 'List email replies error');
            throw new AppError('Failed to fetch email replies', 500);
        }

        // Resolve company names and contact names
        const rows = data || [];
        const companyIds = [...new Set(rows.map((r: any) => r.company_id).filter(Boolean))];
        const contactIds = [...new Set(rows.map((r: any) => r.contact_id).filter(Boolean))];

        const companyMap: Record<string, string> = {};
        const contactMap: Record<string, string> = {};

        if (companyIds.length > 0) {
            const { data: companies } = await db
                .from('companies')
                .select('id, name')
                .in('id', companyIds);
            for (const c of companies || []) {
                companyMap[c.id] = c.name;
            }
        }

        if (contactIds.length > 0) {
            const { data: contacts } = await db
                .from('contacts')
                .select('id, first_name, last_name')
                .in('id', contactIds);
            for (const c of contacts || []) {
                contactMap[c.id] = [c.first_name, c.last_name].filter(Boolean).join(' ');
            }
        }

        // Resolve names for display
        const mapped = rows.map((r: any) => ({
            ...r,
            company_name: r.company_id ? (companyMap[r.company_id] || null) : null,
            contact_name: r.contact_id ? (contactMap[r.contact_id] || null) : null,
        }));

        const total = count || 0;
        res.json({
            data: mapped,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasNext: page < Math.ceil(total / limit),
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'List email replies error');
        res.status(500).json({ error: 'Failed to fetch email replies' });
    }
});

// GET /api/email-replies/stats — summary statistics
router.get('/stats', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const db = dbClient(req);

        // Use separate count queries for efficiency (avoids fetching all rows)
        const [totalRes, unreadRes, matchedRes, unmatchedRes] = await Promise.all([
            db.from('email_replies').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
            db.from('email_replies').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('read_status', 'unread'),
            db.from('email_replies').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('match_status', 'matched'),
            db.from('email_replies').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('match_status', 'unmatched'),
        ]);

        const error = totalRes.error || unreadRes.error || matchedRes.error || unmatchedRes.error;
        if (error) {
            log.error({ err: error }, 'Email replies stats error');
            throw new AppError('Failed to fetch stats', 500);
        }

        res.json({
            total: totalRes.count || 0,
            unread: unreadRes.count || 0,
            matched: matchedRes.count || 0,
            unmatched: unmatchedRes.count || 0,
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Email replies stats error');
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// GET /api/email-replies/campaigns — distinct campaign list for filter dropdown
router.get('/campaigns', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const db = dbClient(req);

        const { data, error } = await db
            .from('email_replies')
            .select('campaign_id, campaign_name')
            .eq('tenant_id', tenantId)
            .not('campaign_id', 'is', null);

        if (error) {
            log.error({ err: error }, 'Email replies campaigns error');
            throw new AppError('Failed to fetch campaigns', 500);
        }

        // Deduplicate by campaign_id
        const seen = new Set<string>();
        const campaigns = (data || []).filter((r: any) => {
            if (seen.has(r.campaign_id)) return false;
            seen.add(r.campaign_id);
            return true;
        });

        res.json(campaigns);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Email replies campaigns error');
        res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
});

// PATCH /api/email-replies/:id/read — toggle read status
router.patch(
    '/:id/read',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const db = dbClient(req);
            const { id } = req.params;
            const tenantId = req.tenantId!;

            // Fetch current read_status
            const { data: existing, error: fetchErr } = await db
                .from('email_replies')
                .select('id, read_status')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (fetchErr || !existing) {
                throw new AppError('Email reply not found', 404);
            }

            const newStatus = existing.read_status === 'unread' ? 'read' : 'unread';

            const { error: updateErr } = await db
                .from('email_replies')
                .update({ read_status: newStatus })
                .eq('id', id)
                .eq('tenant_id', tenantId);

            if (updateErr) {
                log.error({ err: updateErr }, 'Toggle read status error');
                throw new AppError('Failed to update read status', 500);
            }

            res.json({ id, read_status: newStatus });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Toggle read status error');
            res.status(500).json({ error: 'Failed to update read status' });
        }
    }
);

// PATCH /api/email-replies/:id/assign — manually assign company/contact
router.patch(
    '/:id/assign',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(assignReplySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const db = dbClient(req);
            const tenantId = req.tenantId!;
            const { id } = req.params;
            const { company_id, contact_id } = req.body;

            const { data, error } = await db
                .from('email_replies')
                .update({
                    company_id,
                    contact_id: contact_id || null,
                    match_status: 'matched',
                })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select('id, company_id, contact_id, match_status')
                .single();

            if (error) {
                log.error({ err: error }, 'Assign company error');
                throw new AppError('Failed to assign company', 500);
            }

            if (!data) {
                throw new AppError('Email reply not found', 404);
            }

            res.json(data);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Assign company error');
            res.status(500).json({ error: 'Failed to assign company' });
        }
    }
);

export default router;
