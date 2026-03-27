import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { createLogger } from '../lib/logger.js';

const log = createLogger('route:import');
import path from 'path';
import fs from 'fs';
import os from 'os';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { autoMapHeaders, getAvailableDbFields } from '../lib/importMapper.js';
import { parseCSV, parseXLSX, executeImport, createImportJob } from '../lib/importProcessor.js';
import { detectMatchStrategy, matchFiles } from '../lib/dataMatcher.js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router();

// Use OS temp dir (works on all platforms including serverless)
const UPLOAD_DIR = path.join(os.tmpdir(), 'leadhub-uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Configure multer for file uploads (temp only — parsed data goes to DB)
const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.csv', '.xlsx'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV and XLSX files are allowed'));
        }
    },
});

// Helper: run multer middleware and catch its errors (e.g. LIMIT_FILE_SIZE)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function runMulter(middleware: any) {
    return (req: Request, res: Response): Promise<void> =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new Promise((resolve, reject) => middleware(req, res, (err: any) => (err ? reject(err) : resolve())));
}

/**
 * Store parsed file data in DB and return the cache ID.
 * Replaces the old in-memory fileStore Map — survives deploys/restarts.
 */
async function storeFileCache(
    tenantId: string,
    fileName: string,
    fileType: string,
    headers: string[],
    rows: Record<string, string>[],
): Promise<string> {
    const { data, error } = await supabaseAdmin
        .from('import_file_cache')
        .insert({
            tenant_id: tenantId,
            file_name: fileName,
            file_type: fileType,
            headers,
            row_data: rows,
        })
        .select('id')
        .single();

    if (error || !data) {
        throw new AppError('Failed to cache file data: ' + (error?.message || 'unknown'), 500);
    }
    return data.id;
}

/**
 * Retrieve cached file data from DB. Returns null if not found (expired/invalid).
 */
async function getFileCache(fileId: string, tenantId: string): Promise<{
    headers: string[];
    rows: Record<string, string>[];
} | null> {
    const { data, error } = await supabaseAdmin
        .from('import_file_cache')
        .select('headers, row_data')
        .eq('id', fileId)
        .eq('tenant_id', tenantId)
        .single();

    if (error || !data) return null;
    return { headers: data.headers, rows: data.row_data };
}

/**
 * Delete cached file data from DB after use.
 */
async function deleteFileCache(fileId: string): Promise<void> {
    await supabaseAdmin.from('import_file_cache').delete().eq('id', fileId);
}

/**
 * Purge expired cache entries (older than 2 hours).
 * Called opportunistically — no dependency on pg_cron.
 */
async function purgeExpiredCache(): Promise<void> {
    try {
        const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const { count } = await supabaseAdmin
            .from('import_file_cache')
            .delete({ count: 'exact' })
            .lt('created_at', cutoff);
        if (count && count > 0) {
            log.info({ purged: count }, 'Purged expired file cache entries');
        }
    } catch (err) {
        log.warn({ err }, 'Cache purge failed (non-critical)');
    }
}

// Purge on server startup
purgeExpiredCache();

/**
 * Clean up temp file from disk (best-effort).
 */
function cleanupTempFile(filePath: string) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

// POST /api/import/begin — Pre-create import job and return jobId for progress polling
router.post(
    '/begin',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { fileName, fileType, totalRows, mapping } = req.body;

            if (!fileName || !fileType || !totalRows || !mapping) {
                res.status(400).json({ error: 'Missing required fields: fileName, fileType, totalRows, mapping' });
                return;
            }

            const jobId = await createImportJob(
                req.tenantId!,
                req.user!.id,
                fileName,
                fileType,
                Number(totalRows),
                mapping,
            );

            res.json({ jobId });
        } catch (err: any) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Import begin error');
            res.status(500).json({ error: 'Failed to begin import' });
        }
    }
);

// POST /api/import/preview — Upload file and get header mapping suggestions
router.post(
    '/preview',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            // Opportunistic cleanup of expired cache entries
            purgeExpiredCache();

            await runMulter(upload.single('file'))(req, res);
            if (!req.file) {
                res.status(400).json({ error: 'No file uploaded' });
                return;
            }

            const ext = path.extname(req.file.originalname).toLowerCase();
            const filePath = req.file.path;

            let headers: string[];
            let rows: Record<string, string>[];

            if (ext === '.csv') {
                const result = await parseCSV(filePath);
                headers = result.headers;
                rows = result.rows;
            } else {
                const result = await parseXLSX(filePath);
                headers = result.headers;
                rows = result.rows;
            }

            // Clean up temp file immediately — data goes to DB
            cleanupTempFile(filePath);

            // Get auto-mapping suggestions
            const suggestions = autoMapHeaders(headers);
            const availableFields = getAvailableDbFields();

            // Return preview (first 5 rows)
            const previewRows = rows.slice(0, 5);

            // Store parsed data in DB (survives deploys/restarts)
            const fileId = await storeFileCache(
                req.tenantId!,
                req.file.originalname,
                ext.replace('.', ''),
                headers,
                rows,
            );

            res.json({
                fileName: req.file.originalname,
                fileType: ext.replace('.', ''),
                fileId,
                totalRows: rows.length,
                headers,
                suggestions,
                availableFields,
                previewRows,
            });
        } catch (err: any) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Import preview error');
            const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
            res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 10MB)' : 'Failed to preview file' });
        }
    }
);

// POST /api/import/match-preview — Upload two files and get matching preview
router.post(
    '/match-preview',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            await runMulter(upload.fields([
                { name: 'companyFile', maxCount: 1 },
                { name: 'peopleFile', maxCount: 1 },
            ]))(req, res);
            const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
            const companyFile = files?.companyFile?.[0];
            const peopleFile = files?.peopleFile?.[0];

            if (!companyFile || !peopleFile) {
                res.status(400).json({ error: 'Both company and people files are required' });
                return;
            }

            // Parse both files
            const parseFile = async (file: Express.Multer.File) => {
                const ext = path.extname(file.originalname).toLowerCase();
                return ext === '.csv' ? parseCSV(file.path) : parseXLSX(file.path);
            };

            const [companyData, peopleData] = await Promise.all([
                parseFile(companyFile),
                parseFile(peopleFile),
            ]);

            // Clean up temp files immediately
            cleanupTempFile(companyFile.path);
            cleanupTempFile(peopleFile.path);

            // Detect strategy and match
            const strategy = detectMatchStrategy(companyData.headers, peopleData.headers);
            const matchResult = matchFiles(
                companyData.headers,
                companyData.rows,
                peopleData.headers,
                peopleData.rows,
                strategy,
            );

            // Auto-map merged headers
            const suggestions = autoMapHeaders(matchResult.mergedHeaders);
            const availableFields = getAvailableDbFields();

            // Build preview: prefer rows that have people data (matched rows)
            const peopleOnlyCols = matchResult.mergedHeaders.filter(
                (h) => !companyData.headers.includes(h),
            );
            const hasPersonData = (row: Record<string, string>) =>
                peopleOnlyCols.some((col) => row[col]);
            const matchedPreview = matchResult.mergedRows.filter(hasPersonData).slice(0, 5);
            const previewRows = matchedPreview.length > 0
                ? matchedPreview
                : matchResult.mergedRows.slice(0, 5);

            // Store merged data in DB (survives deploys/restarts)
            const fileId = await storeFileCache(
                req.tenantId!,
                `${companyFile.originalname} + ${peopleFile.originalname}`,
                'matched',
                matchResult.mergedHeaders,
                matchResult.mergedRows,
            );

            res.json({
                // Match info
                matchStrategy: strategy,
                matchedCount: matchResult.matchedCount,
                unmatchedPeopleCount: matchResult.unmatchedPeople.length,
                unmatchedPeople: matchResult.unmatchedPeople.slice(0, 20),
                totalCompanyRows: matchResult.totalCompanyRows,
                totalPeopleRows: matchResult.totalPeopleRows,
                // Standard preview fields
                fileId,
                fileName: `${companyFile.originalname} + ${peopleFile.originalname}`,
                fileType: 'matched',
                totalRows: matchResult.mergedRows.length,
                headers: matchResult.mergedHeaders,
                suggestions,
                availableFields,
                previewRows,
                companyHeaders: companyData.headers,
                peopleHeaders: peopleData.headers,
            });
        } catch (err: any) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Match preview error');
            const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
            res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 10MB)' : 'Failed to match files' });
        }
    }
);

// POST /api/import/execute — Execute import synchronously
// Without geocoding, 242 rows takes ~5s. Max 10 000 rows for synchronous execution.
const MAX_SYNC_ROWS = 10_000;
router.post(
    '/execute',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        let fileId_cleanup: string | null = null;
        try {
            const { fileId, fileName, fileType, mapping, jobId, defaultCompanyName } = req.body;

            if (!fileId || !fileName || !fileType || !mapping) {
                res.status(400).json({ error: 'Missing required fields: fileId, fileName, fileType, mapping' });
                return;
            }

            if (!jobId) {
                res.status(400).json({ error: 'Missing required field: jobId. Call /api/import/begin first.' });
                return;
            }
            log.info({ fileName, fileType, jobId }, 'Import execute started');

            // Retrieve cached file data from DB
            const cached = await getFileCache(fileId, req.tenantId!);
            if (!cached) {
                res.status(400).json({ error: 'Upload expired or invalid. Please re-upload the file.' });
                return;
            }
            fileId_cleanup = fileId;

            const { rows } = cached;

            if (rows.length > MAX_SYNC_ROWS) {
                res.status(400).json({ error: `Dosya çok büyük: ${rows.length} satır. Maksimum ${MAX_SYNC_ROWS} satır desteklenmektedir.` });
                return;
            }

            // Check if any custom fields were mapped, and save their labels
            const newSettings: Record<string, string> = {};
            for (const [header, dbField] of Object.entries(mapping)) {
                if (dbField === 'companies.custom_field_1') newSettings.custom_field_1_label = header;
                if (dbField === 'companies.custom_field_2') newSettings.custom_field_2_label = header;
                if (dbField === 'companies.custom_field_3') newSettings.custom_field_3_label = header;
            }

            if (Object.keys(newSettings).length > 0) {
                const { data: tenant } = await supabaseAdmin
                    .from('tenants')
                    .select('settings')
                    .eq('id', req.tenantId!)
                    .single();
                
                const currentSettings = (tenant?.settings as Record<string, unknown>) || {};
                await supabaseAdmin
                    .from('tenants')
                    .update({ settings: { ...currentSettings, ...newSettings } })
                    .eq('id', req.tenantId!);
            }

            // Execute import synchronously
            const result = await executeImport(
                req.tenantId!,
                req.user!.id,
                fileName,
                fileType,
                rows,
                mapping,
                jobId,
                defaultCompanyName || undefined,
            );

            log.info({ jobId, successCount: result.successCount, errorCount: result.errorCount }, 'Import execute completed');
            res.json(result);
        } catch (err: any) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Import execute error');
            res.status(500).json({ error: 'Import failed' });
        } finally {
            if (fileId_cleanup) {
                deleteFileCache(fileId_cleanup).catch((e) =>
                    log.error({ err: e, fileId: fileId_cleanup }, 'Failed to delete file cache')
                );
            }
        }
    }
);

// POST /api/import/cancel/:id — Cancel an in-progress import
router.post(
    '/cancel/:id',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { error } = await supabaseAdmin
                .from('import_jobs')
                .update({ cancelled: true })
                .eq('id', req.params.id)
                .eq('tenant_id', req.tenantId!)
                .eq('status', 'processing');

            if (error) {
                res.status(500).json({ error: 'Failed to cancel import' });
                return;
            }

            res.json({ ok: true });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Cancel import error');
            res.status(500).json({ error: 'Failed to cancel import' });
        }
    }
);

// GET /api/import/jobs — List import history
router.get(
    '/jobs',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { data, error } = await supabaseAdmin
                .from('import_jobs')
                .select('id, file_name, file_type, status, total_rows, success_count, error_count, created_at, completed_at')
                .eq('tenant_id', req.tenantId!)
                .order('created_at', { ascending: false })
                .limit(50);

            if (error) {
                res.status(500).json({ error: 'Failed to fetch import jobs' });
                return;
            }

            res.json({ data: data || [] });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'List jobs error');
            res.status(500).json({ error: 'Failed to fetch import jobs' });
        }
    }
);

// GET /api/import/jobs/:id — Get specific job with error details
router.get(
    '/jobs/:id',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { data, error } = await supabaseAdmin
                .from('import_jobs')
                .select('*')
                .eq('id', req.params.id)
                .eq('tenant_id', req.tenantId!)
                .single();

            if (error || !data) {
                res.status(404).json({ error: 'Import job not found' });
                return;
            }

            res.json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Get job error');
            res.status(500).json({ error: 'Failed to fetch import job' });
        }
    }
);

export default router;
