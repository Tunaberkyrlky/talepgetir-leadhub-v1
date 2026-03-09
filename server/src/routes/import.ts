import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireRole } from '../middleware/auth.js';
import { autoMapHeaders, getAvailableDbFields } from '../lib/importMapper.js';
import { parseCSV, parseXLSX, executeImport } from '../lib/importProcessor.js';
import { detectMatchStrategy, matchFiles } from '../lib/dataMatcher.js';
import { supabaseAdmin } from '../lib/supabase.js';
import crypto from 'crypto';

const router = Router();

const UPLOAD_DIR = '/tmp/leadhub-uploads/';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Configure multer for file uploads
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

// POST /api/import/preview — Upload file and get header mapping suggestions
router.post(
    '/preview',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response): Promise<void> => {
        try {
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

            // Get auto-mapping suggestions
            const suggestions = autoMapHeaders(headers);
            const availableFields = getAvailableDbFields();

            // Return preview (first 5 rows)
            const previewRows = rows.slice(0, 5);

            res.json({
                fileName: req.file.originalname,
                fileType: ext.replace('.', ''),
                filePath, // server-side temp path for execute step
                totalRows: rows.length,
                headers,
                suggestions,
                availableFields,
                previewRows,
            });
        } catch (err: any) {
            console.error('Import preview error:', err);
            const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
            res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 10MB)' : (err.message || 'Failed to preview file') });
        }
    }
);

// POST /api/import/match-preview — Upload two files and get matching preview
router.post(
    '/match-preview',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response): Promise<void> => {
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

            // Detect strategy and match
            const strategy = detectMatchStrategy(companyData.headers, peopleData.headers);
            const matchResult = matchFiles(
                companyData.headers,
                companyData.rows,
                peopleData.headers,
                peopleData.rows,
                strategy,
            );

            // Save merged rows as temp JSON for the execute step
            const tempId = crypto.randomUUID();
            const mergedFilePath = path.join('/tmp/leadhub-uploads/', `${tempId}-matched.json`);
            fs.writeFileSync(mergedFilePath, JSON.stringify(matchResult.mergedRows));

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

            // Clean up original uploaded files
            try { fs.unlinkSync(companyFile.path); } catch { /* ignore */ }
            try { fs.unlinkSync(peopleFile.path); } catch { /* ignore */ }

            res.json({
                // Match info
                matchStrategy: strategy,
                matchedCount: matchResult.matchedCount,
                unmatchedPeopleCount: matchResult.unmatchedPeople.length,
                unmatchedPeople: matchResult.unmatchedPeople.slice(0, 20),
                totalCompanyRows: matchResult.totalCompanyRows,
                totalPeopleRows: matchResult.totalPeopleRows,
                // Standard preview fields
                filePath: mergedFilePath,
                fileName: `${companyFile.originalname} + ${peopleFile.originalname}`,
                fileType: 'matched',
                totalRows: matchResult.mergedRows.length,
                headers: matchResult.mergedHeaders,
                suggestions,
                availableFields,
                previewRows,
            });
        } catch (err: any) {
            console.error('Match preview error:', err);
            const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
            res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 10MB)' : (err.message || 'Failed to match files') });
        }
    }
);

// POST /api/import/execute — Execute import with confirmed mapping
router.post(
    '/execute',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const { filePath, fileName, fileType, mapping } = req.body;

            if (!filePath || !fileName || !fileType || !mapping) {
                res.status(400).json({ error: 'Missing required fields: filePath, fileName, fileType, mapping' });
                return;
            }

            // Verify file is within the upload directory (prevent path traversal)
            const resolvedPath = path.resolve(filePath);
            const resolvedUploadDir = path.resolve(UPLOAD_DIR);
            if (!resolvedPath.startsWith(resolvedUploadDir + path.sep)) {
                res.status(400).json({ error: 'Invalid file path.' });
                return;
            }

            // Verify file exists
            if (!fs.existsSync(resolvedPath)) {
                res.status(400).json({ error: 'Upload expired. Please re-upload the file.' });
                return;
            }

            // Parse file again
            let rows: Record<string, string>[];
            if (fileType === 'matched') {
                // Matched JSON from match-preview step
                const raw = fs.readFileSync(resolvedPath, 'utf-8');
                rows = JSON.parse(raw);
            } else if (fileType === 'csv') {
                const result = await parseCSV(resolvedPath);
                rows = result.rows;
            } else {
                const result = await parseXLSX(resolvedPath);
                rows = result.rows;
            }

            // Execute import
            const result = await executeImport(
                req.tenantId!,
                req.user!.id,
                fileName,
                fileType,
                rows,
                mapping,
            );

            // Clean up temp file
            try { fs.unlinkSync(resolvedPath); } catch { /* ignore */ }

            res.json(result);
        } catch (err: any) {
            console.error('Import execute error:', err);
            res.status(500).json({ error: err.message || 'Import failed' });
        }
    }
);

// GET /api/import/jobs — List import history
router.get(
    '/jobs',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response): Promise<void> => {
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
            console.error('List jobs error:', err);
            res.status(500).json({ error: 'Failed to fetch import jobs' });
        }
    }
);

// GET /api/import/jobs/:id — Get specific job with error details
router.get(
    '/jobs/:id',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response): Promise<void> => {
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
            console.error('Get job error:', err);
            res.status(500).json({ error: 'Failed to fetch import job' });
        }
    }
);

export default router;
