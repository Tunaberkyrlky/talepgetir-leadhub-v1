import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireRole } from '../middleware/auth.js';
import { autoMapHeaders, getAvailableDbFields } from '../lib/importMapper.js';
import { parseCSV, parseXLSX, executeImport } from '../lib/importProcessor.js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router();

// Configure multer for file uploads
const upload = multer({
    dest: '/tmp/leadhub-uploads/',
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.csv', '.xlsx'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV and XLSX files are allowed'));
        }
    },
});

// POST /api/import/preview — Upload file and get header mapping suggestions
router.post(
    '/preview',
    requireRole('superadmin', 'ops_agent'),
    upload.single('file'),
    async (req: Request, res: Response): Promise<void> => {
        try {
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
            res.status(500).json({ error: err.message || 'Failed to preview file' });
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

            // Verify file exists
            if (!fs.existsSync(filePath)) {
                res.status(400).json({ error: 'Upload expired. Please re-upload the file.' });
                return;
            }

            // Parse file again
            let rows: Record<string, string>[];
            if (fileType === 'csv') {
                const result = await parseCSV(filePath);
                rows = result.rows;
            } else {
                const result = await parseXLSX(filePath);
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
            try { fs.unlinkSync(filePath); } catch { /* ignore */ }

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
