import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin, createUserClient } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import {
    validateBody,
    assignReplySchema,
    emailRepliesQuerySchema,
    readStatusBodySchema,
    threadHistoryQuerySchema,
    uuidField,
} from '../lib/validation.js';
import { z } from 'zod/v4';
import { isInternalRole } from '../lib/roles.js';

const log = createLogger('route:email-replies');
const router = Router();

const idParamSchema = z.object({ id: uuidField('Invalid reply ID') });

// Issue 17: guard against missing auth context (always set by authMiddleware, but fail explicitly)
function dbClient(req: Request) {
    if (!req.user || !req.accessToken) {
        throw new AppError('Authentication required', 401);
    }
    if (isInternalRole(req.user.role)) return supabaseAdmin;
    return createUserClient(req.accessToken);
}

// GET /api/email-replies — threaded list (latest email per sender+campaign)
// Returns thread_count and has_unread alongside each row.
router.get(
    '/',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;

            const queryResult = emailRepliesQuerySchema.safeParse(req.query);
            if (!queryResult.success) {
                res.status(400).json({ error: 'Invalid query parameters' });
                return;
            }
            const { page, limit, campaign_id, match_status, read_status, date_from, date_to, search } = queryResult.data;
            const offset = (page - 1) * limit;

            const rpcParams = {
                p_tenant_id: tenantId,
                p_offset: offset,
                p_limit: limit,
                p_campaign_id: campaign_id || null,
                p_match_status: match_status || null,
                p_read_status: read_status || null,
                p_search: search || null,
                p_date_from: date_from || null,
                p_date_to: date_to || null,
            };

            const [{ data: rows, error }, { data: countData, error: countError }] = await Promise.all([
                supabaseAdmin.rpc('get_email_reply_threads', rpcParams),
                supabaseAdmin.rpc('count_email_reply_threads', {
                    p_tenant_id: tenantId,
                    p_campaign_id: campaign_id || null,
                    p_match_status: match_status || null,
                    p_read_status: read_status || null,
                    p_search: search || null,
                    p_date_from: date_from || null,
                    p_date_to: date_to || null,
                }),
            ]);

            if (error || countError) {
                log.error({ err: error || countError }, 'List email replies (threaded) error');
                throw new AppError('Failed to fetch email replies', 500);
            }

            // Resolve company and contact names
            const list = rows || [];
            const companyIds = [...new Set(list.map((r: any) => r.company_id).filter(Boolean))];
            const contactIds = [...new Set(list.map((r: any) => r.contact_id).filter(Boolean))];

            const companyMap: Record<string, string> = {};
            const contactMap: Record<string, string> = {};

            if (companyIds.length > 0) {
                const { data: companies } = await supabaseAdmin
                    .from('companies')
                    .select('id, name')
                    .in('id', companyIds);
                for (const c of companies || []) companyMap[c.id] = c.name;
            }

            if (contactIds.length > 0) {
                const { data: contacts } = await supabaseAdmin
                    .from('contacts')
                    .select('id, first_name, last_name')
                    .in('id', contactIds);
                for (const c of contacts || []) {
                    contactMap[c.id] = [c.first_name, c.last_name].filter(Boolean).join(' ');
                }
            }

            const mapped = list.map((r: any) => ({
                ...r,
                company_name: r.company_id ? (companyMap[r.company_id] || null) : null,
                contact_name: r.contact_id ? (contactMap[r.contact_id] || null) : null,
            }));

            const total = Number(countData) || 0;
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
            next(new AppError('Failed to fetch email replies', 500));
        }
    }
);

// GET /api/email-replies/thread-history — older messages in a thread
// Returns all replies from the same sender+campaign, excluding the latest (exclude_id).
router.get(
    '/thread-history',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const queryResult = threadHistoryQuerySchema.safeParse(req.query);
            if (!queryResult.success) {
                res.status(400).json({ error: 'Invalid query parameters' });
                return;
            }
            const { sender_email, campaign_id, exclude_id } = queryResult.data;
            const tenantId = req.tenantId!;

            let query = supabaseAdmin
                .from('email_replies')
                .select('id, sender_email, reply_body, replied_at, read_status, campaign_id')
                .eq('tenant_id', tenantId)
                .eq('sender_email', sender_email)
                .order('replied_at', { ascending: false })
                .limit(50);

            if (campaign_id) query = query.eq('campaign_id', campaign_id);
            if (exclude_id) query = query.neq('id', exclude_id);

            const { data, error } = await query;
            if (error) {
                log.error({ err: error }, 'Thread history error');
                throw new AppError('Failed to fetch thread history', 500);
            }

            res.json(data || []);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Thread history error');
            next(new AppError('Failed to fetch thread history', 500));
        }
    }
);

// GET /api/email-replies/stats — summary statistics
// Issue 6: restricted to non-viewer roles
// Issue 10: single aggregation via RPC instead of 4 separate COUNTs
router.get(
    '/stats',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;

            const { data, error } = await supabaseAdmin
                .rpc('get_email_reply_stats', { p_tenant_id: tenantId })
                .single();

            if (error) {
                log.error({ err: error }, 'Email replies stats error');
                throw new AppError('Failed to fetch stats', 500);
            }

            const stats = data as { total: number; unread: number; matched: number; unmatched: number };
            res.json({
                total: Number(stats.total),
                unread: Number(stats.unread),
                matched: Number(stats.matched),
                unmatched: Number(stats.unmatched),
            });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Email replies stats error');
            next(new AppError('Failed to fetch stats', 500));
        }
    }
);

// GET /api/email-replies/campaigns — distinct campaign list for filter dropdown
// Issue 6: restricted to non-viewer roles
router.get(
    '/campaigns',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const db = dbClient(req);

            const { data, error } = await db
                .from('email_replies')
                .select('campaign_id, campaign_name')
                .eq('tenant_id', tenantId)
                .not('campaign_id', 'is', null)
                .order('replied_at', { ascending: false })
                .limit(500);

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
            next(new AppError('Failed to fetch campaigns', 500));
        }
    }
);

// PATCH /api/email-replies/:id/read — set read status explicitly
// Issue 2: UUID validation on :id
// Issue 5 (Option A): client sends desired status; eliminates fetch-then-write race condition
// Issue 11: standardized response shape
router.patch(
    '/:id/read',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(readStatusBodySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid reply ID' });
                return;
            }
            const { id } = paramResult.data;
            const { read_status } = req.body;
            const tenantId = req.tenantId!;
            const db = dbClient(req);

            const { data, error } = await db
                .from('email_replies')
                .update({ read_status })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select('id, read_status, match_status, company_id, contact_id, updated_at')
                .single();

            if (error) {
                if ((error as any).code === 'PGRST116') {
                    throw new AppError('Email reply not found', 404);
                }
                log.error({ err: error }, 'Set read status error');
                throw new AppError('Failed to update read status', 500);
            }
            if (!data) {
                throw new AppError('Email reply not found', 404);
            }

            res.json(data);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Set read status error');
            next(new AppError('Failed to update read status', 500));
        }
    }
);

// PATCH /api/email-replies/:id/assign — manually assign company/contact
// Issue 1: verify company belongs to user's tenant before assigning
// Issue 2: UUID validation on :id
// Issue 11: standardized response shape
router.patch(
    '/:id/assign',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(assignReplySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid reply ID' });
                return;
            }
            const { id } = paramResult.data;
            const { company_id, contact_id } = req.body;
            const tenantId = req.tenantId!;
            const db = dbClient(req);

            // Issue 1: verify company belongs to this tenant
            const { data: company, error: companyErr } = await db
                .from('companies')
                .select('id')
                .eq('id', company_id)
                .eq('tenant_id', tenantId)
                .single();

            if (companyErr || !company) {
                throw new AppError('Company not found in your workspace', 404);
            }

            // If contact provided, verify it belongs to this company
            if (contact_id) {
                const { data: contact, error: contactErr } = await db
                    .from('contacts')
                    .select('id')
                    .eq('id', contact_id)
                    .eq('company_id', company_id)
                    .single();

                if (contactErr || !contact) {
                    throw new AppError('Contact not found for this company', 404);
                }
            }

            const { data, error } = await db
                .from('email_replies')
                .update({
                    company_id,
                    contact_id: contact_id || null,
                    match_status: 'matched',
                })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select('id, read_status, match_status, company_id, contact_id, updated_at')
                .single();

            if (error) {
                if ((error as any).code === 'PGRST116') {
                    throw new AppError('Email reply not found', 404);
                }
                log.error({ err: error, id, tenantId }, 'Assign company error');
                throw new AppError('Failed to assign company', 500);
            }
            if (!data) {
                throw new AppError('Email reply not found', 404);
            }

            res.json(data);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Assign company error');
            next(new AppError('Failed to assign company', 500));
        }
    }
);

// POST /api/email-replies/rematch-batch — re-run matching for a specific set of reply IDs
// Used by the frontend bulk-rematch flow to process in chunks and show progress.
router.post(
    '/rematch-batch',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const ids: unknown = req.body.ids;

            if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50) {
                res.status(400).json({ error: 'ids must be a non-empty array of up to 50 UUIDs' });
                return;
            }
            const validIds = ids.filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id));
            if (validIds.length === 0) {
                res.status(400).json({ error: 'No valid UUIDs provided' });
                return;
            }

            const { data: replies, error: fetchErr } = await supabaseAdmin
                .from('email_replies')
                .select('id, sender_email')
                .in('id', validIds)
                .eq('tenant_id', tenantId);

            if (fetchErr) throw new AppError('Failed to fetch replies', 500);

            // Group by sender_email to call matchSenderEmail once per sender
            const bySender = new Map<string, string[]>();
            for (const r of replies || []) {
                const arr = bySender.get(r.sender_email) || [];
                arr.push(r.id);
                bySender.set(r.sender_email, arr);
            }

            const { matchSenderEmail } = await import('../lib/emailMatcher.js');
            let matched = 0;

            for (const [senderEmail, senderIds] of bySender) {
                let match;
                try {
                    match = await matchSenderEmail(senderEmail, tenantId);
                } catch {
                    continue;
                }
                if (match.match_status !== 'matched') continue;

                const { error: updateErr } = await supabaseAdmin
                    .from('email_replies')
                    .update({ company_id: match.company_id, contact_id: match.contact_id, match_status: 'matched' })
                    .in('id', senderIds)
                    .eq('tenant_id', tenantId);

                if (!updateErr) matched += senderIds.length;
            }

            res.json({ matched, processed: validIds.length });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Rematch-batch error');
            next(new AppError('Failed to process batch', 500));
        }
    }
);

// POST /api/email-replies/rematch-all — re-run matching for all unmatched replies in the tenant
// Groups by unique sender_email to avoid redundant matchSenderEmail calls.
router.post(
    '/rematch-all',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;

            // Fetch all unmatched replies (id + sender_email only)
            const { data: unmatched, error: fetchErr } = await supabaseAdmin
                .from('email_replies')
                .select('id, sender_email')
                .eq('tenant_id', tenantId)
                .eq('match_status', 'unmatched');

            if (fetchErr) {
                log.error({ err: fetchErr }, 'Rematch-all fetch error');
                throw new AppError('Failed to fetch unmatched replies', 500);
            }

            if (!unmatched || unmatched.length === 0) {
                res.json({ matched: 0, stillUnmatched: 0, total: 0 });
                return;
            }

            // Group reply ids by sender_email to call matchSenderEmail once per sender
            const bySender = new Map<string, string[]>();
            for (const r of unmatched) {
                const ids = bySender.get(r.sender_email) || [];
                ids.push(r.id);
                bySender.set(r.sender_email, ids);
            }

            const { matchSenderEmail } = await import('../lib/emailMatcher.js');

            let matchedCount = 0;
            let stillUnmatched = 0;

            // Process each unique sender sequentially to avoid hammering the DB
            for (const [senderEmail, ids] of bySender) {
                let match;
                try {
                    match = await matchSenderEmail(senderEmail, tenantId);
                } catch (matchErr) {
                    log.warn({ err: matchErr, senderEmail }, 'Rematch-all: sender match failed, skipping');
                    stillUnmatched += ids.length;
                    continue;
                }

                if (match.match_status === 'matched') {
                    const { error: updateErr } = await supabaseAdmin
                        .from('email_replies')
                        .update({
                            company_id: match.company_id,
                            contact_id: match.contact_id,
                            match_status: 'matched',
                        })
                        .in('id', ids)
                        .eq('tenant_id', tenantId);

                    if (updateErr) {
                        log.warn({ err: updateErr, senderEmail }, 'Rematch-all: update failed for sender');
                        stillUnmatched += ids.length;
                    } else {
                        matchedCount += ids.length;
                    }
                } else {
                    stillUnmatched += ids.length;
                }
            }

            log.info({ tenantId, matchedCount, stillUnmatched, total: unmatched.length }, 'Rematch-all completed');
            res.json({ matched: matchedCount, stillUnmatched, total: unmatched.length });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Rematch-all error');
            next(new AppError('Failed to rematch all replies', 500));
        }
    }
);

// POST /api/email-replies/:id/rematch — re-run automatic email matching for a single reply
router.post(
    '/:id/rematch',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid reply ID' });
                return;
            }
            const { id } = paramResult.data;
            const tenantId = req.tenantId!;
            const db = dbClient(req);

            // Fetch the reply to get the sender email
            const { data: existing, error: fetchErr } = await db
                .from('email_replies')
                .select('id, sender_email')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (fetchErr || !existing) {
                throw new AppError('Email reply not found', 404);
            }

            // Re-run matching
            const { matchSenderEmail } = await import('../lib/emailMatcher.js');
            const match = await matchSenderEmail(existing.sender_email, tenantId);

            const { data, error } = await db
                .from('email_replies')
                .update({
                    company_id: match.company_id,
                    contact_id: match.contact_id,
                    match_status: match.match_status,
                })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select('id, read_status, match_status, company_id, contact_id, updated_at')
                .single();

            if (error) {
                log.error({ err: error }, 'Rematch update error');
                throw new AppError('Failed to update match', 500);
            }

            res.json(data);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Rematch error');
            next(new AppError('Failed to rematch email reply', 500));
        }
    }
);

// GET /api/email-replies/by-company/:companyId — emails linked to a specific company
router.get(
    '/by-company/:companyId',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { companyId } = req.params;

            if (!/^[0-9a-f-]{36}$/i.test(companyId)) {
                res.status(400).json({ error: 'Invalid company ID' });
                return;
            }

            const { data, error } = await supabaseAdmin
                .from('email_replies')
                .select('id, sender_email, reply_body, replied_at, read_status, match_status, campaign_id, campaign_name, company_id, contact_id, category, category_confidence, created_at, tenant_id')
                .eq('tenant_id', tenantId)
                .eq('company_id', companyId)
                .order('replied_at', { ascending: false })
                .limit(100);

            if (error) {
                log.error({ err: error }, 'By-company emails error');
                throw new AppError('Failed to fetch emails', 500);
            }

            res.json(data || []);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            next(new AppError('Failed to fetch emails', 500));
        }
    }
);

// DELETE /api/email-replies/:id — remove a reply (superadmin + ops_agent only)
// Issue 16: allow removal of false positives / test data
router.delete(
    '/:id',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid reply ID' });
                return;
            }
            const { id } = paramResult.data;
            const tenantId = req.tenantId!;
            const db = dbClient(req);

            const { error } = await db
                .from('email_replies')
                .delete()
                .eq('id', id)
                .eq('tenant_id', tenantId);

            if (error) {
                log.error({ err: error }, 'Delete email reply error');
                throw new AppError('Failed to delete email reply', 500);
            }

            res.status(204).send();
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Delete email reply error');
            next(new AppError('Failed to delete email reply', 500));
        }
    }
);

export default router;
