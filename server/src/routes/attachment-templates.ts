import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { validateBody, uuidField } from '../lib/validation.js';

const log = createLogger('route:attachment-templates');
const router = Router();

const idParamSchema = z.object({ id: uuidField('Invalid template ID') });

const createSchema = z.object({
    label: z.string().min(1).max(200),
    file_type: z.string().min(1).max(50).default('pdf'),
    file_url: z.string().url().max(2000),
    file_size: z.string().max(50).default(''),
    sort_order: z.number().int().min(0).default(0),
    is_active: z.boolean().default(true),
});

const updateSchema = createSchema.partial();

// GET /api/attachment-templates — list tenant's templates
router.get(
    '/',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { data, error } = await supabaseAdmin
                .from('email_attachment_templates')
                .select('*')
                .eq('tenant_id', tenantId)
                .order('sort_order')
                .order('created_at');

            if (error) throw new AppError('Failed to fetch templates', 500);
            res.json({ data: data || [] });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'List templates error');
            next(new AppError('Failed to fetch templates', 500));
        }
    }
);

// POST /api/attachment-templates — create new template
router.post(
    '/',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(createSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const row = { tenant_id: tenantId, ...req.body };

            const { data, error } = await supabaseAdmin
                .from('email_attachment_templates')
                .insert(row)
                .select()
                .single();

            if (error) {
                log.error({ err: error }, 'Create template error');
                throw new AppError('Failed to create template', 500);
            }

            res.status(201).json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Create template error');
            next(new AppError('Failed to create template', 500));
        }
    }
);

// PUT /api/attachment-templates/:id — update template
router.put(
    '/:id',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(updateSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid template ID' });
                return;
            }

            const tenantId = req.tenantId!;
            const { data, error } = await supabaseAdmin
                .from('email_attachment_templates')
                .update(req.body)
                .eq('id', paramResult.data.id)
                .eq('tenant_id', tenantId)
                .select()
                .single();

            if (error || !data) throw new AppError('Template not found', 404);
            res.json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Update template error');
            next(new AppError('Failed to update template', 500));
        }
    }
);

// DELETE /api/attachment-templates/:id — delete template
router.delete(
    '/:id',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid template ID' });
                return;
            }

            const tenantId = req.tenantId!;
            const { error } = await supabaseAdmin
                .from('email_attachment_templates')
                .delete()
                .eq('id', paramResult.data.id)
                .eq('tenant_id', tenantId);

            if (error) throw new AppError('Failed to delete template', 500);
            res.json({ success: true });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Delete template error');
            next(new AppError('Failed to delete template', 500));
        }
    }
);

export default router;
