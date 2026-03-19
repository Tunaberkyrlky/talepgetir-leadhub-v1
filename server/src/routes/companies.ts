import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { lookupCoordinates } from '../lib/geocoder.js';
import { translateTexts } from '../lib/deepl.js';

const log = createLogger('route:companies');

const COMPANY_TRANSLATE_FIELDS = ['product_services', 'description', 'deal_summary', 'next_step', 'industry'] as const;

const router = Router();

// Sanitize search input for safe use in PostgREST .or() filter strings.
// Strips characters that PostgREST interprets as structural delimiters.
function sanitizeSearch(value: string): string {
    return value.replace(/[,().\\]/g, '');
}

// Valid stages for companies
const VALID_STAGES = [
    'cold', 'in_queue', 'first_contact', 'connected', 'qualified',
    'in_meeting', 'follow_up', 'proposal_sent', 'negotiation',
    'won', 'lost', 'on_hold',
] as const;

const VALID_EMAIL_STATUSES = ['valid', 'uncertain', 'invalid'] as const;

/** Basic email format validation */
function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Valid sort columns (whitelist to prevent injection)
const SORT_COLUMNS: Record<string, string> = {
    name: 'name',
    stage: 'stage',
    industry: 'industry',
    location: 'location',
    employee_size: 'employee_size',
    contact_count: 'contact_count',
    updated_at: 'updated_at',
    created_at: 'created_at',
};

// GET /api/companies — List with pagination, search, filter, sort
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
        const offset = (page - 1) * limit;

        // Search & filter params
        const search = (req.query.search as string || '').trim();
        const stages = (req.query.stages as string || '').split(',').filter(Boolean);
        const industries = (req.query.industries as string || '').split(',').filter(Boolean);
        const locations = (req.query.locations as string || '').split(',').filter(Boolean);
        const products = (req.query.products as string || '').split(',').filter(Boolean);

        // Sort params
        const sortBy = SORT_COLUMNS[req.query.sortBy as string] || 'updated_at';
        const sortOrder = (req.query.sortOrder as string) === 'asc';

        // Build count query with filters
        let countQuery = supabaseAdmin
            .from('companies')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId);

        // Use view that includes pre-computed contact_count (enables sorting by it)
        let dataQuery = supabaseAdmin
            .from('companies_with_counts')
            .select('id, name, website, location, industry, employee_size, product_services, description, linkedin, company_phone, company_email, email_status, stage, deal_summary, next_step, assigned_to, created_at, updated_at, contact_count')
            .eq('tenant_id', tenantId);

        // Apply search (ILIKE on multiple columns)
        if (search) {
            const safe = sanitizeSearch(search);
            if (safe.length > 0) {
                const pattern = `%${safe}%`;
                const searchFilter = `name.ilike.${pattern},website.ilike.${pattern},industry.ilike.${pattern},next_step.ilike.${pattern},location.ilike.${pattern}`;
                countQuery = countQuery.or(searchFilter);
                dataQuery = dataQuery.or(searchFilter);
            }
        }

        // Apply stage filter
        if (stages.length > 0) {
            countQuery = countQuery.in('stage', stages);
            dataQuery = dataQuery.in('stage', stages);
        }

        // Apply industry filter
        if (industries.length > 0) {
            countQuery = countQuery.in('industry', industries);
            dataQuery = dataQuery.in('industry', industries);
        }

        // Apply location filter
        if (locations.length > 0) {
            countQuery = countQuery.in('location', locations);
            dataQuery = dataQuery.in('location', locations);
        }

        // Apply product_services filter
        if (products.length > 0) {
            countQuery = countQuery.in('product_services', products);
            dataQuery = dataQuery.in('product_services', products);
        }

        const { count, error: countError } = await countQuery;

        if (countError) {
            throw new AppError('Failed to count companies', 500);
        }

        // Apply sort and pagination
        // nullsFirst: false ensures NULLs always go to end regardless of sort direction
        const { data, error } = await dataQuery
            .order(sortBy, { ascending: sortOrder, nullsFirst: false })
            .order('id', { ascending: true })
            .range(offset, offset + limit - 1);

        if (error) {
            throw new AppError('Failed to fetch companies', 500);
        }

        const totalPages = Math.ceil((count || 0) / limit);

        res.json({
            data: data || [],
            pagination: {
                page,
                limit,
                total: count || 0,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'List companies error');
        res.status(500).json({ error: 'Failed to fetch companies' });
    }
});

// Active pipeline stages (excludes cold + terminal: won, lost, on_hold)
const PIPELINE_STAGES = VALID_STAGES.filter(
    (s) => !['cold', 'won', 'lost', 'on_hold'].includes(s)
);

// GET /api/companies/pipeline — Companies grouped by active stage (for kanban board)
router.get('/pipeline', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const search = (req.query.search as string || '').trim();

        let data: any[] | null = null;
        let error: any = null;

        let query = supabaseAdmin
            .from('companies_with_counts')
            .select('id, name, industry, stage, next_step, deal_summary, updated_at, stage_changed_at, contact_count')
            .eq('tenant_id', tenantId)
            .in('stage', PIPELINE_STAGES);

        if (search) {
            const safe = sanitizeSearch(search);
            if (safe.length > 0) {
                const pattern = `%${safe}%`;
                query = query.or(`name.ilike.${pattern},next_step.ilike.${pattern},deal_summary.ilike.${pattern}`);
            }
        }

        const result = await query.order('updated_at', { ascending: false });
        data = result.data;
        error = result.error;

        // Fallback: if stage_changed_at column doesn't exist yet (migration not applied)
        if (error) {
            log.warn({ err: error }, 'Pipeline query failed, retrying without stage_changed_at');
            let fallback = supabaseAdmin
                .from('companies_with_counts')
                .select('id, name, industry, stage, next_step, deal_summary, updated_at, contact_count')
                .eq('tenant_id', tenantId)
                .in('stage', PIPELINE_STAGES);

            if (search) {
                const safe = sanitizeSearch(search);
                if (safe.length > 0) {
                    const pattern = `%${safe}%`;
                    fallback = fallback.or(`name.ilike.${pattern},next_step.ilike.${pattern},deal_summary.ilike.${pattern}`);
                }
            }

            const fallbackResult = await fallback.order('updated_at', { ascending: false });
            data = (fallbackResult.data || []).map((c: any) => ({ ...c, stage_changed_at: null }));
            error = fallbackResult.error;
        }

        if (error) {
            log.error({ err: error }, 'Pipeline query error');
            throw new AppError('Failed to fetch pipeline data', 500);
        }

        // Group by stage
        const columns: Record<string, typeof data> = {};
        for (const stage of PIPELINE_STAGES) {
            columns[stage] = [];
        }
        for (const company of data ?? []) {
            const col = columns[company.stage];
            if (col) col.push(company);
        }

        // Terminal stage counts
        const terminalStages = ['won', 'lost', 'on_hold'] as const;
        const terminalResults = await Promise.all(
            terminalStages.map((stage) =>
                supabaseAdmin
                    .from('companies')
                    .select('*', { count: 'exact', head: true })
                    .eq('tenant_id', tenantId)
                    .eq('stage', stage)
            )
        );
        const terminalCounts: Record<string, number> = { won: 0, lost: 0, on_hold: 0 };
        terminalStages.forEach((stage, i) => {
            terminalCounts[stage] = terminalResults[i].count || 0;
        });

        res.json({ columns, terminalCounts });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Pipeline data error');
        res.status(500).json({ error: 'Failed to fetch pipeline data' });
    }
});

// GET /api/companies/:id — Get single company
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { id } = req.params;

        const { data, error } = await supabaseAdmin
            .from('companies')
            .select('*')
            .eq('id', id)
            .eq('tenant_id', tenantId)
            .single();

        if (error || !data) {
            // Return 404 instead of 403 to not leak info about other tenants
            res.status(404).json({ error: 'Company not found' });
            return;
        }

        // Fetch contacts for this company
        const { data: contacts } = await supabaseAdmin
            .from('contacts')
            .select('*')
            .eq('company_id', id)
            .eq('tenant_id', tenantId)
            .order('is_primary', { ascending: false })
            .order('created_at', { ascending: true });

        res.json({ data: { ...data, contacts: contacts || [] } });
    } catch (err) {
        log.error({ err }, 'Get company error');
        res.status(500).json({ error: 'Failed to fetch company' });
    }
});

// POST /api/companies — Create new company
router.post(
    '/',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const {
                name, website, location, industry, employee_size, product_services, description, linkedin, company_phone,
                company_email, email_status,
                stage, deal_summary, internal_notes, next_step, custom_fields,
                contact_first_name, contact_last_name, contact_title, contact_email, contact_phone_e164
            } = req.body;

            if (!name || typeof name !== 'string' || name.trim().length === 0) {
                res.status(400).json({ error: 'Company name is required' });
                return;
            }

            // Validate stage if provided
            if (stage && !VALID_STAGES.includes(stage)) {
                res.status(400).json({
                    error: `Invalid stage. Valid stages: ${VALID_STAGES.join(', ')}`
                });
                return;
            }

            // Validate email_status if provided
            if (email_status && !VALID_EMAIL_STATUSES.includes(email_status)) {
                res.status(400).json({
                    error: `Invalid email_status. Valid values: ${VALID_EMAIL_STATUSES.join(', ')}`
                });
                return;
            }

            // Validate company_email format if provided
            if (company_email && !isValidEmail(company_email)) {
                res.status(400).json({ error: 'Invalid company email format' });
                return;
            }

            // Validate contact_email format if provided
            if (contact_email && !isValidEmail(contact_email)) {
                res.status(400).json({ error: 'Invalid contact email format' });
                return;
            }

            // 1. Build payload
            const companyPayload: Record<string, unknown> = {
                tenant_id: tenantId,
                name: name.trim(),
                website: website || null,
                location: location || null,
                industry: industry ? industry.charAt(0).toUpperCase() + industry.slice(1) : null,
                employee_size: employee_size || null,
                product_services: product_services || null,
                description: description || null,
                linkedin: linkedin || null,
                company_phone: company_phone || null,
                company_email: company_email || null,
                email_status: email_status || null,
                stage: stage || 'cold',
                deal_summary: deal_summary || null,
                internal_notes: internal_notes || null,
                next_step: next_step || null,
                custom_fields: custom_fields || {},
                assigned_to: req.user!.id,
            };

            const { data: company, error: companyError } = await supabaseAdmin
                .from('companies')
                .insert(companyPayload)
                .select()
                .single();

            if (companyError) {
                log.error({ err: companyError }, 'Insert company error');
                throw new AppError('Failed to create company', 500);
            }

            // 2. Insert Contact if details are provided
            let contact = null;
            if (contact_first_name && contact_first_name.trim().length > 0) {
                const { data: newContact, error: contactError } = await supabaseAdmin
                    .from('contacts')
                    .insert({
                        tenant_id: tenantId,
                        company_id: company.id,
                        first_name: contact_first_name.trim(),
                        last_name: contact_last_name?.trim() || null,
                        title: contact_title || null,
                        email: contact_email || null,
                        phone_e164: contact_phone_e164 || null,
                        is_primary: true
                    })
                    .select()
                    .single();

                if (contactError) {
                    log.error({ err: contactError }, 'Insert initial contact error');
                    // Do not fail the whole request since company was created
                } else {
                    contact = newContact;
                }
            }

            // Auto-geocode location if provided
            if (location && company?.id) {
                const coords = lookupCoordinates(location);
                if (coords) {
                    await supabaseAdmin
                        .from('companies')
                        .update({ latitude: coords.lat, longitude: coords.lng })
                        .eq('id', company.id);
                }
            }

            res.status(201).json({ data: { ...company, contacts: contact ? [contact] : [] } });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Create company error');
            res.status(500).json({ error: 'Failed to create company' });
        }
    }
);

// PUT /api/companies/:id — Update company
router.put(
    '/:id',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            // Verify company belongs to tenant
            const { data: existing } = await supabaseAdmin
                .from('companies')
                .select('id')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (!existing) {
                res.status(404).json({ error: 'Company not found' });
                return;
            }

            const { name, website, location, industry, employee_size, product_services, description, linkedin, company_phone, company_email, email_status, stage, deal_summary, internal_notes, next_step, custom_fields } = req.body;

            // Validate stage if provided
            if (stage && !VALID_STAGES.includes(stage)) {
                res.status(400).json({
                    error: `Invalid stage. Valid stages: ${VALID_STAGES.join(', ')}`
                });
                return;
            }

            // Validate email_status if provided
            if (email_status && !VALID_EMAIL_STATUSES.includes(email_status)) {
                res.status(400).json({
                    error: `Invalid email_status. Valid values: ${VALID_EMAIL_STATUSES.join(', ')}`
                });
                return;
            }

            // Validate company_email format if provided
            if (company_email && !isValidEmail(company_email)) {
                res.status(400).json({ error: 'Invalid company email format' });
                return;
            }

            // Build update object (only include provided fields)
            const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
            if (name !== undefined) updateData.name = name.trim();
            if (website !== undefined) updateData.website = website;
            if (location !== undefined) updateData.location = location;
            if (industry !== undefined) updateData.industry = industry ? industry.charAt(0).toUpperCase() + industry.slice(1) : industry;
            if (employee_size !== undefined) updateData.employee_size = employee_size;
            if (product_services !== undefined) updateData.product_services = product_services;
            if (description !== undefined) updateData.description = description;
            if (linkedin !== undefined) updateData.linkedin = linkedin;
            if (company_phone !== undefined) updateData.company_phone = company_phone;
            if (company_email !== undefined) updateData.company_email = company_email;
            if (email_status !== undefined) updateData.email_status = email_status;
            if (stage !== undefined) updateData.stage = stage;
            if (deal_summary !== undefined) updateData.deal_summary = deal_summary;
            if (internal_notes !== undefined) updateData.internal_notes = internal_notes;
            if (next_step !== undefined) updateData.next_step = next_step;
            if (custom_fields !== undefined) updateData.custom_fields = custom_fields;

            // Re-geocode when location changes
            if (location !== undefined) {
                const coords = location ? lookupCoordinates(location) : null;
                updateData.latitude  = coords?.lat ?? null;
                updateData.longitude = coords?.lng ?? null;
            }

            const { data, error } = await supabaseAdmin
                .from('companies')
                .update(updateData)
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select()
                .single();

            if (error) {
                throw new AppError('Failed to update company', 500);
            }

            res.json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Update company error');
            res.status(500).json({ error: 'Failed to update company' });
        }
    }
);

// PATCH /api/companies/bulk-stage — Bulk update stage for multiple companies
router.patch(
    '/bulk-stage',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { ids, stage } = req.body;

            if (!Array.isArray(ids) || ids.length === 0) {
                res.status(400).json({ error: 'ids must be a non-empty array' });
                return;
            }

            if (!stage || !VALID_STAGES.includes(stage)) {
                res.status(400).json({
                    error: `Invalid stage. Valid stages: ${VALID_STAGES.join(', ')}`,
                });
                return;
            }

            const { data, error } = await supabaseAdmin
                .from('companies')
                .update({ stage, updated_at: new Date().toISOString() })
                .in('id', ids)
                .eq('tenant_id', tenantId)
                .select('id');

            if (error) {
                throw new AppError('Failed to bulk update stages', 500);
            }

            res.json({ updated: data?.length || 0 });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Bulk stage update error');
            res.status(500).json({ error: 'Failed to bulk update stages' });
        }
    }
);

// PATCH /api/companies/:id/stage — Lightweight stage update (drag-drop)
router.patch(
    '/:id/stage',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;
            const { stage } = req.body;

            if (!stage || !VALID_STAGES.includes(stage)) {
                res.status(400).json({
                    error: `Invalid stage. Valid stages: ${VALID_STAGES.join(', ')}`,
                });
                return;
            }

            const { data, error } = await supabaseAdmin
                .from('companies')
                .update({ stage, updated_at: new Date().toISOString() })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select('id, name, stage, updated_at')
                .single();

            if (error || !data) {
                res.status(404).json({ error: 'Company not found' });
                return;
            }

            res.json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Patch stage error');
            res.status(500).json({ error: 'Failed to update stage' });
        }
    }
);

// POST /api/companies/:id/translate — Translate company text fields to Turkish
router.post(
    '/:id/translate',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            const { data: company, error: fetchError } = await supabaseAdmin
                .from('companies')
                .select('*')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (fetchError || !company) {
                res.status(404).json({ error: 'Company not found' });
                return;
            }

            // Collect non-empty translatable fields
            const texts = COMPANY_TRANSLATE_FIELDS
                .filter((f) => typeof company[f] === 'string' && company[f].trim().length >= 2)
                .map((f) => ({ field: f, text: company[f] as string }));

            if (texts.length === 0) {
                res.status(400).json({ error: 'No translatable text fields found' });
                return;
            }

            const translated = await translateTexts(texts);

            if (Object.keys(translated).length === 0) {
                res.status(200).json({ data: company, message: 'Already in Turkish or no translation needed' });
                return;
            }

            const translations = { ...translated, translated_at: new Date().toISOString() };

            const { data: updated, error: updateError } = await supabaseAdmin
                .from('companies')
                .update({ translations })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select()
                .single();

            if (updateError) {
                throw new AppError('Failed to save translations', 500);
            }

            res.json({ data: updated });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Translate company error');
            res.status(500).json({ error: 'Translation failed' });
        }
    }
);

// DELETE /api/companies/:id — Delete company (superadmin only)
router.delete(
    '/:id',
    requireRole('superadmin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            const { error } = await supabaseAdmin
                .from('companies')
                .delete()
                .eq('id', id)
                .eq('tenant_id', tenantId);

            if (error) {
                throw new AppError('Failed to delete company', 500);
            }

            res.status(204).send();
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Delete company error');
            res.status(500).json({ error: 'Failed to delete company' });
        }
    }
);

export default router;
