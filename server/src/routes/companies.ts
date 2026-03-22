import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { lookupCoordinates } from '../lib/geocoder.js';
import { translateTexts } from '../lib/deepl.js';
import { getValidStageSlugs, getPipelineStageSlugs, getTerminalStageSlugs } from './settings.js';
import { invalidateOverviewCache, invalidatePipelineStatsCache } from './statistics.js';

const log = createLogger('route:companies');

const COMPANY_TRANSLATE_FIELDS = ['product_services', 'product_portfolio', 'company_summary', 'next_step', 'industry'] as const;

const router = Router();

// Sanitize search input for safe use in PostgREST .or() filter strings.
function sanitizeSearch(value: string): string {
    return value.replace(/[,().\\]/g, '');
}

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

        let dataQuery = supabaseAdmin
            .from('companies')
            .select('id, name, website, location, industry, employee_size, product_services, product_portfolio, linkedin, company_phone, company_email, email_status, stage, company_summary, next_step, assigned_to, fit_score, partnership_observation_1, partnership_observation_2, partnership_observation_3, contact_count, created_at, updated_at')
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

// GET /api/companies/pipeline — Companies grouped by active stage (for kanban board)
router.get('/pipeline', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const search = (req.query.search as string || '').trim();

        // Dynamic pipeline stages from tenant config
        const pipelineStages = await getPipelineStageSlugs(tenantId);
        const terminalStages = await getTerminalStageSlugs(tenantId);

        let query = supabaseAdmin
            .from('companies')
            .select('id, name, industry, stage, next_step, company_summary, updated_at, stage_changed_at, contact_count')
            .eq('tenant_id', tenantId)
            .in('stage', pipelineStages);

        if (search) {
            const safe = sanitizeSearch(search);
            if (safe.length > 0) {
                const pattern = `%${safe}%`;
                query = query.or(`name.ilike.${pattern},next_step.ilike.${pattern},company_summary.ilike.${pattern}`);
            }
        }

        const { data, error } = await query.order('updated_at', { ascending: false });

        if (error) {
            log.error({ err: error }, 'Pipeline query error');
            throw new AppError('Failed to fetch pipeline data', 500);
        }

        // Group by stage
        const columns: Record<string, any[]> = {};
        for (const stage of pipelineStages) {
            columns[stage] = [];
        }
        for (const company of data ?? []) {
            const col = columns[company.stage];
            if (col) col.push(company);
        }

        // Terminal stage counts
        const terminalResults = await Promise.all(
            terminalStages.map((stage) =>
                supabaseAdmin
                    .from('companies')
                    .select('*', { count: 'exact', head: true })
                    .eq('tenant_id', tenantId)
                    .eq('stage', stage)
            )
        );
        const terminalCounts: Record<string, number> = {};
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
                name, website, location, industry, employee_size, product_services, product_portfolio, linkedin, company_phone,
                company_email, email_status,
                stage, company_summary, internal_notes, next_step, custom_fields,
                fit_score, partnership_observation_1, partnership_observation_2, partnership_observation_3,
                contact_first_name, contact_last_name, contact_title, contact_email, contact_phone_e164
            } = req.body;

            if (!name || typeof name !== 'string' || name.trim().length === 0) {
                res.status(400).json({ error: 'Company name is required' });
                return;
            }

            // Validate stage if provided
            if (stage) {
                const validSlugs = await getValidStageSlugs(tenantId);
                if (!validSlugs.includes(stage)) {
                    res.status(400).json({ error: `Invalid stage. Valid stages: ${validSlugs.join(', ')}` });
                    return;
                }
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
                product_portfolio: product_portfolio || null,
                linkedin: linkedin || null,
                company_phone: company_phone || null,
                company_email: company_email || null,
                email_status: email_status || null,
                stage: stage || 'cold',
                company_summary: company_summary || null,
                internal_notes: internal_notes || null,
                next_step: next_step || null,
                custom_fields: custom_fields || {},
                fit_score: fit_score || null,
                partnership_observation_1: partnership_observation_1 || null,
                partnership_observation_2: partnership_observation_2 || null,
                partnership_observation_3: partnership_observation_3 || null,
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

            const { name, website, location, industry, employee_size, product_services, product_portfolio, linkedin, company_phone, company_email, email_status, stage, company_summary, internal_notes, next_step, custom_fields, fit_score, partnership_observation_1, partnership_observation_2, partnership_observation_3 } = req.body;

            // Validate stage if provided
            if (stage) {
                const validSlugs = await getValidStageSlugs(tenantId);
                if (!validSlugs.includes(stage)) {
                    res.status(400).json({ error: `Invalid stage. Valid stages: ${validSlugs.join(', ')}` });
                    return;
                }
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
            if (product_portfolio !== undefined) updateData.product_portfolio = product_portfolio;
            if (linkedin !== undefined) updateData.linkedin = linkedin;
            if (company_phone !== undefined) updateData.company_phone = company_phone;
            if (company_email !== undefined) updateData.company_email = company_email;
            if (email_status !== undefined) updateData.email_status = email_status;
            if (stage !== undefined) updateData.stage = stage;
            if (company_summary !== undefined) updateData.company_summary = company_summary;
            if (internal_notes !== undefined) updateData.internal_notes = internal_notes;
            if (fit_score !== undefined) updateData.fit_score = fit_score;
            if (partnership_observation_1 !== undefined) updateData.partnership_observation_1 = partnership_observation_1;
            if (partnership_observation_2 !== undefined) updateData.partnership_observation_2 = partnership_observation_2;
            if (partnership_observation_3 !== undefined) updateData.partnership_observation_3 = partnership_observation_3;
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

            const validSlugs = await getValidStageSlugs(tenantId);
            if (!stage || !validSlugs.includes(stage)) {
                res.status(400).json({ error: `Invalid stage. Valid stages: ${validSlugs.join(', ')}` });
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

            invalidateOverviewCache(tenantId);
            invalidatePipelineStatsCache(tenantId);
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

            const validSlugs = await getValidStageSlugs(tenantId);
            if (!stage || !validSlugs.includes(stage)) {
                res.status(400).json({ error: `Invalid stage. Valid stages: ${validSlugs.join(', ')}` });
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

            invalidateOverviewCache(tenantId);
            invalidatePipelineStatsCache(tenantId);
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
