import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { validateBody } from '../lib/validation.js';

const log = createLogger('route:feedback');
const router = Router();

// ── Schemas ──

const createFeedbackSchema = z.object({
    type: z.enum(['feature_request', 'bug_report']),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
});

const updateStatusSchema = z.object({
    status: z.enum(['open', 'in_progress', 'resolved', 'closed']),
});

const idParamSchema = z.object({
    id: z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
});

// ── POST /api/feedback — submit feedback (any authenticated user) ──

router.post(
    '/',
    validateBody(createFeedbackSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { type, title, description } = req.body;
            const tenantId = req.tenantId!;
            const userId = req.user?.id;
            const userEmail = req.user?.email || '';

            if (!userId) {
                res.status(401).json({ error: 'User not authenticated' });
                return;
            }

            const { data, error } = await supabaseAdmin
                .from('feedback')
                .insert({
                    tenant_id: tenantId,
                    user_id: userId,
                    user_email: userEmail,
                    type,
                    title,
                    description: description || null,
                })
                .select()
                .single();

            if (error) {
                log.error({ err: error }, 'Create feedback error');
                throw new AppError('Failed to submit feedback', 500);
            }

            res.status(201).json(data);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Create feedback error');
            next(new AppError('Failed to submit feedback', 500));
        }
    }
);

// ── GET /api/feedback — list all feedback (superadmin only) ──

router.get(
    '/',
    requireRole('superadmin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { type, status, search } = req.query;
            const page = Math.max(1, parseInt(req.query.page as string) || 1);
            const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
            const offset = (page - 1) * limit;

            let query = supabaseAdmin
                .from('feedback')
                .select('*', { count: 'exact' })
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1);

            if (type && typeof type === 'string') {
                query = query.eq('type', type);
            }
            if (status && typeof status === 'string') {
                query = query.eq('status', status);
            }
            if (search && typeof search === 'string') {
                query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%,user_email.ilike.%${search}%`);
            }

            const { data, error, count } = await query;

            if (error) {
                log.error({ err: error }, 'List feedback error');
                throw new AppError('Failed to fetch feedback', 500);
            }

            res.json({
                data: data || [],
                pagination: {
                    total: count || 0,
                    page,
                    limit,
                    hasNext: offset + limit < (count || 0),
                },
            });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'List feedback error');
            next(new AppError('Failed to fetch feedback', 500));
        }
    }
);

// ── PATCH /api/feedback/:id/status — update status (superadmin only) ──

router.patch(
    '/:id/status',
    requireRole('superadmin'),
    validateBody(updateStatusSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid feedback ID' });
                return;
            }

            const { id } = paramResult.data;
            const { status } = req.body;

            const { data, error } = await supabaseAdmin
                .from('feedback')
                .update({ status })
                .eq('id', id)
                .select()
                .single();

            if (error) {
                log.error({ err: error }, 'Update feedback status error');
                throw new AppError('Failed to update feedback status', 500);
            }

            res.json(data);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Update feedback status error');
            next(new AppError('Failed to update feedback status', 500));
        }
    }
);

// ── DELETE /api/feedback/:id — delete feedback (superadmin only) ──

router.delete(
    '/:id',
    requireRole('superadmin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid feedback ID' });
                return;
            }

            const { id } = paramResult.data;

            const { error } = await supabaseAdmin
                .from('feedback')
                .delete()
                .eq('id', id);

            if (error) {
                log.error({ err: error }, 'Delete feedback error');
                throw new AppError('Failed to delete feedback', 500);
            }

            res.status(204).send();
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Delete feedback error');
            next(new AppError('Failed to delete feedback', 500));
        }
    }
);

export default router;
