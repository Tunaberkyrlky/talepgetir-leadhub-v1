/** Y2 customs/trade CSV preview, import, and batch history. */
import { createHash } from 'crypto';
import path from 'path';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod/v4';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { normalizeTradeCsv, type TradeCsvResult } from '../../lib/research/trade/normalizer.js';
import { enqueueJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPES } from '../../lib/research/jobTypes.js';
import { availableCredits } from '../../lib/research/engine/ledger.js';

const log = createLogger('route:research:trade');
const router = Router();
const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');
const uuidSchema = z.string().uuid();
const INSERT_BATCH_SIZE = 500;
const researchBatchSchema = z.object({ icp_id: z.string().uuid() });

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
        cb(null, path.extname(file.originalname).toLowerCase() === '.csv');
    },
});

function runUpload(req: Request, res: Response): Promise<void> {
    return new Promise((resolve, reject) => {
        upload.single('file')(req, res, (error) => error ? reject(error) : resolve());
    });
}

function parseUploadedFile(req: Request): TradeCsvResult {
    if (!req.file) throw new AppError('A CSV file is required', 400);
    try {
        return normalizeTradeCsv(req.file.buffer);
    } catch (error) {
        throw new AppError(error instanceof Error ? error.message : 'Invalid CSV file', 400);
    }
}

async function assertProject(tenantId: string, projectId: string): Promise<void> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_projects')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('id', projectId)
        .maybeSingle();
    if (error) throw new AppError('Failed to verify research project', 500);
    if (!data) throw new AppError('Research project not found', 404);
}

function previewPayload(result: TradeCsvResult) {
    return {
        totalRows: result.totalRows,
        acceptedRows: result.acceptedRows,
        reviewRows: result.reviewRows,
        rejectedRows: result.rejectedRows,
        rows: result.rows.slice(0, 20).map(({ raw: _raw, ...row }) => row),
    };
}

// POST /api/research/trade/preview
router.post('/preview', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        await runUpload(req, res);
        const result = parseUploadedFile(req);
        res.json({ fileName: req.file!.originalname, ...previewPayload(result) });
    } catch (error) {
        if (error instanceof multer.MulterError) {
            return next(new AppError(error.code === 'LIMIT_FILE_SIZE' ? 'CSV file is too large (max 10MB)' : error.message, 400));
        }
        next(error);
    }
});

// POST /api/research/trade/import
router.post('/import', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let batchId: string | null = null;
    try {
        await runUpload(req, res);
        const parsedProjectId = uuidSchema.safeParse(req.body.project_id);
        if (!parsedProjectId.success) throw new AppError('A valid project_id is required', 400);
        const projectId = parsedProjectId.data;
        const tenantId = req.tenantId!;
        await assertProject(tenantId, projectId);

        const result = parseUploadedFile(req);
        if (result.acceptedRows === 0) throw new AppError('No buyer company could be identified in this CSV', 400);
        const sha256 = createHash('sha256').update(req.file!.buffer).digest('hex');

        const { data: duplicate, error: duplicateError } = await researchSupabaseAdmin
            .from('research_trade_import_batches')
            .select('id, status, job_id, created_at')
            .eq('tenant_id', tenantId)
            .eq('project_id', projectId)
            .eq('source_sha256', sha256)
            .maybeSingle();
        if (duplicateError) throw new AppError('Failed to check trade import history', 500);
        if (duplicate) {
            res.status(409).json({ error: 'This file has already been imported into this project', batch: duplicate });
            return;
        }

        const { data: batch, error: batchError } = await researchSupabaseAdmin
            .from('research_trade_import_batches')
            .insert({
                tenant_id: tenantId,
                project_id: projectId,
                file_name: req.file!.originalname.slice(0, 500),
                source_sha256: sha256,
                total_rows: result.totalRows,
                accepted_rows: result.acceptedRows,
                review_rows: result.reviewRows,
                rejected_rows: result.rejectedRows,
                created_by: req.user?.id ?? null,
            })
            .select('*')
            .single();
        if (batchError?.code === '23505') {
            throw new AppError('This file has already been imported into this project', 409);
        }
        if (batchError || !batch) throw new AppError('Failed to create trade import batch', 500);
        batchId = batch.id as string;

        const inserts = result.rows.map((row) => ({
            tenant_id: tenantId,
            project_id: projectId,
            batch_id: batchId,
            row_number: row.rowNumber,
            company_name: row.companyName,
            hs_codes: row.hsCodes,
            export_value: row.exportValue,
            website: row.website,
            country: row.country,
            summary: row.summary,
            email: row.email,
            phone: row.phone,
            currency: row.currency,
            confidence: row.confidence,
            needs_review: row.needsReview,
            review_reasons: row.reviewReasons.join('; ') || null,
            raw: row.raw,
            status: row.rejected ? 'rejected' : 'pending',
        }));

        for (let offset = 0; offset < inserts.length; offset += INSERT_BATCH_SIZE) {
            const { error } = await researchSupabaseAdmin
                .from('research_trade_imports')
                .insert(inserts.slice(offset, offset + INSERT_BATCH_SIZE));
            if (error) {
                log.error({ err: error, batchId, offset }, 'trade rows insert failed');
                throw new AppError('Failed to store normalized trade rows', 500);
            }
        }

        const job = await enqueueJob({
            tenantId,
            projectId,
            type: RESEARCH_JOB_TYPES.TRADE_INGEST,
            payload: { batch_id: batchId },
            maxAttempts: 3,
            createdBy: req.user?.id ?? null,
        });
        const { error: linkError } = await researchSupabaseAdmin
            .from('research_trade_import_batches')
            .update({ job_id: job.id })
            .eq('tenant_id', tenantId)
            .eq('id', batchId);
        if (linkError) log.warn({ err: linkError, batchId, jobId: job.id }, 'failed to link trade batch job');

        res.status(202).json({ batch: { ...batch, job_id: job.id }, job, ...previewPayload(result) });
    } catch (error) {
        if (batchId) {
            await researchSupabaseAdmin.from('research_trade_import_batches').delete().eq('id', batchId);
        }
        if (error instanceof multer.MulterError) {
            return next(new AppError(error.code === 'LIMIT_FILE_SIZE' ? 'CSV file is too large (max 10MB)' : error.message, 400));
        }
        if (!(error instanceof AppError)) log.error({ err: error }, 'trade import failed');
        next(error instanceof AppError ? error : new AppError('Failed to import trade CSV', 500));
    }
});

// POST /api/research/trade/batches/:id/research
router.post('/batches/:id/research', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsedBatchId = uuidSchema.safeParse(req.params.id);
        const parsedBody = researchBatchSchema.safeParse(req.body);
        if (!parsedBatchId.success) throw new AppError('Invalid batch ID', 400);
        if (!parsedBody.success) throw new AppError('A valid icp_id is required', 400);
        const tenantId = req.tenantId!;

        const [{ data: batch, error: batchError }, { data: icp, error: icpError }] = await Promise.all([
            researchSupabaseAdmin
                .from('research_trade_import_batches')
                .select('id, project_id, status, processed_rows')
                .eq('tenant_id', tenantId)
                .eq('id', parsedBatchId.data)
                .maybeSingle(),
            researchSupabaseAdmin
                .from('research_icps')
                .select('id, project_id, status')
                .eq('tenant_id', tenantId)
                .eq('id', parsedBody.data.icp_id)
                .maybeSingle(),
        ]);
        if (batchError || icpError) throw new AppError('Failed to verify trade research request', 500);
        if (!batch) throw new AppError('Trade import batch not found', 404);
        if (!icp) throw new AppError('ICP not found', 404);
        if (batch.status !== 'processed' || batch.processed_rows < 1) {
            throw new AppError('Trade import batch is not ready for research', 409);
        }
        if (icp.status !== 'approved') throw new AppError('ICP must be approved before research', 409);
        if (icp.project_id !== batch.project_id) {
            throw new AppError('ICP and trade batch must belong to the same project', 409);
        }

        const available = await availableCredits(tenantId);
        if (available < 1) {
            res.status(402).json({ error: 'Insufficient research credits', available });
            return;
        }

        const { data: inflight, error: inflightError } = await researchSupabaseAdmin
            .from('research_jobs')
            .select('id')
            .eq('tenant_id', tenantId)
            .in('type', [
                RESEARCH_JOB_TYPES.HARVEST_RUN,
                RESEARCH_JOB_TYPES.MAPS_HARVEST,
                RESEARCH_JOB_TYPES.TRADE_HARVEST,
            ])
            .in('status', ['queued', 'running'])
            .contains('payload', { icp_id: parsedBody.data.icp_id })
            .limit(1)
            .maybeSingle();
        if (inflightError) throw new AppError('Failed to start trade research', 500);
        if (inflight) {
            res.status(409).json({
                error: 'A research run for this ICP is already queued or running',
                job_id: inflight.id,
            });
            return;
        }

        const job = await enqueueJob({
            tenantId,
            projectId: batch.project_id,
            type: RESEARCH_JOB_TYPES.TRADE_HARVEST,
            payload: {
                batch_id: batch.id,
                icp_id: icp.id,
                geography: 'Customs import batch',
                source: 'trade',
            },
            maxAttempts: 1,
            createdBy: req.user?.id ?? null,
        });
        res.status(202).json(job);
    } catch (error) {
        if (error instanceof AppError) return next(error);
        log.error({ err: error }, 'trade research enqueue failed');
        next(new AppError('Failed to start trade research', 500));
    }
});

// GET /api/research/trade/batches?project_id=...
router.get('/batches', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : null;
        if (projectId && !uuidSchema.safeParse(projectId).success) throw new AppError('Invalid project_id', 400);
        const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
        const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? '20'), 10) || 20));
        const offset = (page - 1) * limit;
        let query = researchSupabaseAdmin
            .from('research_trade_import_batches')
            .select('id, project_id, job_id, file_name, status, total_rows, accepted_rows, review_rows, rejected_rows, processed_rows, linked_companies, error, created_at, updated_at', { count: 'exact' })
            .eq('tenant_id', req.tenantId!)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (projectId) query = query.eq('project_id', projectId);
        const { data, error, count } = await query;
        if (error) throw new AppError('Failed to fetch trade import batches', 500);
        res.json({
            data: (data ?? []).map((batch) => ({
                ...batch,
                error: batch.status === 'failed' ? 'Trade import failed' : null,
            })),
            pagination: { total: count ?? 0, page, limit },
        });
    } catch (error) {
        next(error instanceof AppError ? error : new AppError('Failed to fetch trade import batches', 500));
    }
});

// GET /api/research/trade/batches/:id/rows
router.get('/batches/:id/rows', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsedId = uuidSchema.safeParse(req.params.id);
        if (!parsedId.success) throw new AppError('Invalid batch ID', 400);
        const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));
        const { data, error } = await researchSupabaseAdmin
            .from('research_trade_imports')
            .select('id, row_number, company_name, hs_codes, export_value, currency, website, country, summary, email, phone, confidence, needs_review, review_reasons, status, company_id')
            .eq('tenant_id', req.tenantId!)
            .eq('batch_id', parsedId.data)
            .order('row_number')
            .limit(limit);
        if (error) throw new AppError('Failed to fetch trade import rows', 500);
        res.json({ data: data ?? [] });
    } catch (error) {
        next(error instanceof AppError ? error : new AppError('Failed to fetch trade import rows', 500));
    }
});

export default router;
