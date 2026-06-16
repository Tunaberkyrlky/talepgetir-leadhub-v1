import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { validateBody, uuidField } from '../lib/validation.js';

const log = createLogger('route:attachment-templates');
const router = Router();

const STORAGE_BUCKET = 'email-attachments';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB — matches the bucket's file_size_limit
const ALLOWED_EXTS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.txt'];

// Throttle uploads specifically (the rest of the CRUD stays on the general limiter).
const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many upload requests, please try again later' },
});

// In-memory upload: we push the buffer straight to Supabase Storage, no temp file.
const uploadFile = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, ALLOWED_EXTS.includes(ext));
    },
});

// Run a multer middleware as a promise so we can catch LIMIT_FILE_SIZE / filter rejects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function runMulter(middleware: any, req: Request, res: Response): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Promise((resolve, reject) => middleware(req, res, (err: any) => (err ? reject(err) : resolve())));
}

function humanizeBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let val = bytes / 1024;
    let i = 0;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

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

// GET /api/attachment-templates — list tenant's reusable library templates
// (one-off uploads have is_library = false and are intentionally excluded)
router.get(
    '/',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { data, error } = await supabaseAdmin
                .from('email_attachment_templates')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('is_library', true)
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

// POST /api/attachment-templates/upload — upload a file → store in Supabase
// Storage → create an attachment row (link card, same send path as URL templates).
// Body (multipart): file, saveToLibrary ('true' keeps it in the reusable library;
// default false = one-off, used for this mail only and hidden from the library list).
router.post(
    '/upload',
    uploadLimiter,
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            try {
                await runMulter(uploadFile.single('file'), req, res);
            } catch (err) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if ((err as any)?.code === 'LIMIT_FILE_SIZE') {
                    res.status(413).json({ error: 'File too large (max 10MB)' });
                    return;
                }
                res.status(400).json({ error: 'File upload failed' });
                return;
            }

            const file = req.file;
            if (!file) {
                res.status(400).json({ error: 'No file provided' });
                return;
            }
            const ext = path.extname(file.originalname).toLowerCase();
            if (!ALLOWED_EXTS.includes(ext)) {
                res.status(400).json({ error: 'Unsupported file type' });
                return;
            }

            const tenantId = req.tenantId!;
            const saveToLibrary = req.body?.saveToLibrary === 'true' || req.body?.saveToLibrary === true;
            const objectPath = `${tenantId}/${randomUUID()}${ext}`;

            const { error: uploadError } = await supabaseAdmin.storage
                .from(STORAGE_BUCKET)
                .upload(objectPath, file.buffer, {
                    contentType: file.mimetype || 'application/octet-stream',
                    upsert: false,
                });
            if (uploadError) {
                log.error({ err: uploadError, objectPath }, 'Storage upload failed');
                throw new AppError('Failed to store file', 500);
            }

            const publicUrl = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(objectPath).data.publicUrl;
            const label = path.basename(file.originalname, ext).slice(0, 200) || 'attachment';

            const row = {
                tenant_id: tenantId,
                label,
                file_type: ext.replace('.', '').slice(0, 50),
                file_url: publicUrl,
                file_size: humanizeBytes(file.size),
                size_bytes: file.size,
                storage_path: objectPath,
                original_filename: file.originalname.slice(0, 500),
                is_library: saveToLibrary,
            };

            const { data, error } = await supabaseAdmin
                .from('email_attachment_templates')
                .insert(row)
                .select()
                .single();

            if (error || !data) {
                // Roll back the orphaned object so we don't leak storage on a failed insert.
                await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([objectPath]).catch(() => { /* best effort */ });
                log.error({ err: error, objectPath }, 'Attachment row insert failed');
                throw new AppError('Failed to save attachment', 500);
            }

            res.status(201).json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Upload attachment error');
            next(new AppError('Failed to upload attachment', 500));
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
            const { data: deleted, error } = await supabaseAdmin
                .from('email_attachment_templates')
                .delete()
                .eq('id', paramResult.data.id)
                .eq('tenant_id', tenantId)
                .select('storage_path')
                .maybeSingle();

            if (error) throw new AppError('Failed to delete template', 500);

            // Clean up the stored file for uploaded attachments (URL-only templates have no storage_path).
            if (deleted?.storage_path) {
                await supabaseAdmin.storage
                    .from(STORAGE_BUCKET)
                    .remove([deleted.storage_path])
                    .catch((err) => log.warn({ err, path: deleted.storage_path }, 'Storage cleanup failed'));
            }

            res.json({ success: true });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Delete template error');
            next(new AppError('Failed to delete template', 500));
        }
    }
);

export default router;
