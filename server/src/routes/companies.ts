import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin, createUserClient } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { lookupCoordinates } from '../lib/geocoder.js';
import { translateTexts } from '../lib/deepl.js';
import { validateBody, createCompanySchema, updateCompanySchema, sanitizeEmail } from '../lib/validation.js';
import { isInternalRole } from '../lib/roles.js';
import { sanitizeSearch } from '../lib/queryUtils.js';
import { getValidStageSlugs, getPipelineStageSlugs, getTerminalStageSlugs, getTenantStages } from './settings.js';
import { invalidateOverviewCache, invalidatePipelineStatsCache } from './statistics.js';
import posthog from '../lib/posthog.js';

const log = createLogger('route:companies');

const COMPANY_TRANSLATE_FIELDS = ['product_services', 'product_portfolio', 'company_summary', 'next_step', 'industry'] as const;

const router = Router();

// For read endpoints: internal roles may be operating cross-tenant (X-Tenant-Id header),
// so they require supabaseAdmin. Client roles access only their own tenant — use the
// user client so RLS acts as a second isolation layer.
function dbClient(req: Request) {
    if (isInternalRole(req.user!.role)) return supabaseAdmin;
    return createUserClient(req.accessToken!);
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
        const countries = (req.query.country as string || '').split(',').map(c => c.trim()).filter(Boolean);
        const products = (req.query.products as string || '').split(',').filter(Boolean);

        const dateFrom = req.query.dateFrom as string | undefined;
        const dateTo = req.query.dateTo as string | undefined;

        // Validate date params
        if (dateFrom && isNaN(Date.parse(dateFrom))) {
            res.status(400).json({ error: 'Please enter a valid start date' });
            return;
        }
        if (dateTo && isNaN(Date.parse(dateTo))) {
            res.status(400).json({ error: 'Please enter a valid end date' });
            return;
        }
        if (dateFrom && dateTo && new Date(dateFrom) > new Date(dateTo)) {
            res.status(400).json({ error: 'Start date must be before end date' });
            return;
        }

        // Sort params
        const sortBy = SORT_COLUMNS[req.query.sortBy as string] || 'updated_at';
        const sortOrder = (req.query.sortOrder as string) === 'asc';

        const db = dbClient(req);

        // Build count query with filters
        let countQuery = db
            .from('companies')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId);

        let dataQuery = db
            .from('companies')
            .select('id, name, website, location, latitude, industry, employee_size, product_services, product_portfolio, linkedin, company_phone, company_email, email_status, stage, company_summary, next_step, assigned_to, fit_score, custom_field_1, custom_field_2, custom_field_3, contact_count, created_at, updated_at')
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

        // Apply combined location/country filter (single dropdown in the UI; OR'd together).
        // Locations support special tokens __empty__ (location IS NULL) and __not_geocoded__
        // (latitude IS NULL); these are also OR'd into the same expression.
        if (locations.length > 0 || countries.length > 0) {
            const includesEmpty = locations.includes('__empty__');
            const includesNotGeocoded = locations.includes('__not_geocoded__');
            const namedLocations = locations.filter(l => l !== '__empty__' && l !== '__not_geocoded__');

            const orParts: string[] = [];
            if (includesEmpty) orParts.push('location.is.null');
            if (includesNotGeocoded) orParts.push('latitude.is.null');
            if (namedLocations.length > 0) orParts.push(`location.in.(${namedLocations.join(',')})`);
            if (countries.length > 0) orParts.push(`country.in.(${countries.join(',')})`);

            if (orParts.length > 1) {
                const orFilter = orParts.join(',');
                countQuery = countQuery.or(orFilter);
                dataQuery = dataQuery.or(orFilter);
            } else if (includesEmpty) {
                countQuery = countQuery.is('location', null);
                dataQuery = dataQuery.is('location', null);
            } else if (includesNotGeocoded) {
                countQuery = countQuery.is('latitude', null);
                dataQuery = dataQuery.is('latitude', null);
            } else if (namedLocations.length > 0) {
                countQuery = countQuery.in('location', namedLocations);
                dataQuery = dataQuery.in('location', namedLocations);
            } else {
                countQuery = countQuery.in('country', countries);
                dataQuery = dataQuery.in('country', countries);
            }
        }

        // Apply product_services filter
        if (products.length > 0) {
            countQuery = countQuery.in('product_services', products);
            dataQuery = dataQuery.in('product_services', products);
        }

        // Apply date filters
        if (dateFrom) {
            countQuery = countQuery.gte('created_at', dateFrom);
            dataQuery = dataQuery.gte('created_at', dateFrom);
        }
        if (dateTo) {
            countQuery = countQuery.lte('created_at', dateTo);
            dataQuery = dataQuery.lte('created_at', dateTo);
        }

        const { count, error: countError } = await countQuery;

        if (countError) {
            log.error({ err: countError }, 'Failed to get company count');
            throw new AppError('Failed to list companies', 500);
        }

        // Apply sort and pagination
        // nullsFirst: false ensures NULLs always go to end regardless of sort direction
        const { data, error } = await dataQuery
            .order(sortBy, { ascending: sortOrder, nullsFirst: false })
            .order('id', { ascending: true })
            .range(offset, offset + limit - 1);

        if (error) {
            log.error({ err: error }, 'Failed to list companies');
            throw new AppError('Failed to list companies', 500);
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

        const db = dbClient(req);

        let query = db
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

        // Terminal stage companies + counts
        let terminalQuery = db
            .from('companies')
            .select('id, name, industry, stage, next_step, company_summary, updated_at, stage_changed_at, contact_count')
            .eq('tenant_id', tenantId)
            .in('stage', terminalStages)
            .order('updated_at', { ascending: false });

        if (search) {
            const safe = sanitizeSearch(search);
            if (safe.length > 0) {
                const pattern = `%${safe}%`;
                terminalQuery = terminalQuery.or(`name.ilike.${pattern},next_step.ilike.${pattern},company_summary.ilike.${pattern}`);
            }
        }

        const { data: terminalData, error: terminalError } = await terminalQuery;

        if (terminalError) {
            log.error({ err: terminalError }, 'Terminal stage query error');
            throw new AppError('Failed to fetch terminal stage data', 500);
        }

        // Fetch closing report activities for terminal companies
        const terminalIds = (terminalData ?? []).map((c: any) => c.id);
        let closingReports: Record<string, { summary: string; detail: string | null; outcome: string; occurred_at: string }> = {};
        if (terminalIds.length > 0) {
            const { data: reports } = await db
                .from('activities')
                .select('company_id, summary, detail, outcome, occurred_at')
                .eq('tenant_id', tenantId)
                .eq('type', 'sonlandirma_raporu')
                .in('company_id', terminalIds)
                .order('occurred_at', { ascending: false });
            // Keep only the latest report per company
            for (const r of reports ?? []) {
                if (!closingReports[r.company_id]) {
                    closingReports[r.company_id] = { summary: r.summary, detail: r.detail, outcome: r.outcome, occurred_at: r.occurred_at };
                }
            }
        }

        const terminalColumns: Record<string, any[]> = {};
        const terminalCounts: Record<string, number> = {};
        for (const stage of terminalStages) {
            terminalColumns[stage] = [];
            terminalCounts[stage] = 0;
        }
        for (const company of terminalData ?? []) {
            const col = terminalColumns[company.stage];
            if (col) {
                col.push({ ...company, closing_report: closingReports[company.id] || null });
                terminalCounts[company.stage]++;
            }
        }

        res.json({ columns, terminalCounts, terminalColumns });
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

        const db = dbClient(req);

        const { data, error } = await db
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
        const { data: contacts } = await db
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
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(createCompanySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const {
                name, website, location, industry, employee_size, product_services, product_portfolio, linkedin, company_phone,
                company_email: rawCompanyEmail, email_status,
                stage, company_summary, internal_notes, next_step, custom_fields,
                fit_score, custom_field_1, custom_field_2, custom_field_3,
                contact_first_name, contact_last_name, contact_title, contact_email: rawContactEmail, contact_phone_e164
            } = req.body;

            const company_email = sanitizeEmail(rawCompanyEmail);
            const contact_email = sanitizeEmail(rawContactEmail);

            if (!name || typeof name !== 'string' || name.trim().length === 0) {
                res.status(400).json({ error: 'Company name is required' });
                return;
            }

            // Validate stage if provided
            if (stage) {
                const validSlugs = await getValidStageSlugs(tenantId);
                if (!validSlugs.includes(stage)) {
                    res.status(400).json({ error: 'The selected pipeline stage is not valid' });
                    return;
                }
            }

            // Validate email_status if provided
            if (email_status && !VALID_EMAIL_STATUSES.includes(email_status)) {
                res.status(400).json({ error: 'The selected email status is not valid' });
                return;
            }

            // Validate company_email format if provided
            if (company_email && !isValidEmail(company_email)) {
                res.status(400).json({ error: 'Please enter a valid company email address' });
                return;
            }

            // Validate contact_email format if provided
            if (contact_email && !isValidEmail(contact_email)) {
                res.status(400).json({ error: 'Please enter a valid contact email address' });
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
                internal_notes: isInternalRole(req.user!.role) ? (internal_notes || null) : null,
                next_step: next_step || null,
                custom_fields: custom_fields || {},
                fit_score: fit_score || null,
                custom_field_1: custom_field_1 || null,
                custom_field_2: custom_field_2 || null,
                custom_field_3: custom_field_3 || null,
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
                        .update({ latitude: coords.lat, longitude: coords.lng, country: coords.country })
                        .eq('id', company.id);
                }
            }

            posthog.capture({
                distinctId: req.user!.id,
                event: 'company_created',
                properties: {
                    company_id: company.id,
                    company_name: company.name,
                    stage: company.stage,
                    industry: company.industry,
                    tenant_id: tenantId,
                    has_contact: !!contact,
                },
            });
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
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(updateCompanySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            // Verify company belongs to tenant (also fetch fields needed for auto-geocoding)
            const { data: existing } = await supabaseAdmin
                .from('companies')
                .select('id, location, latitude')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (!existing) {
                res.status(404).json({ error: 'Company not found' });
                return;
            }

            const { name, website, location, industry, employee_size, product_services, product_portfolio, linkedin, company_phone, company_email: rawCompanyEmail, email_status, stage, company_summary, internal_notes, next_step, custom_fields, fit_score, custom_field_1, custom_field_2, custom_field_3 } = req.body;

            const company_email = sanitizeEmail(rawCompanyEmail);

            // Validate stage if provided
            if (stage) {
                const validSlugs = await getValidStageSlugs(tenantId);
                if (!validSlugs.includes(stage)) {
                    res.status(400).json({ error: 'The selected pipeline stage is not valid' });
                    return;
                }
            }

            // Validate email_status if provided
            if (email_status && !VALID_EMAIL_STATUSES.includes(email_status)) {
                res.status(400).json({ error: 'The selected email status is not valid' });
                return;
            }

            // Validate company_email format if provided
            if (company_email && !isValidEmail(company_email)) {
                res.status(400).json({ error: 'Please enter a valid company email address' });
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
            if (stage !== undefined) {
                updateData.stage = stage;
                updateData.stage_changed_at = new Date().toISOString();
            }
            if (company_summary !== undefined) updateData.company_summary = company_summary;
            if (internal_notes !== undefined && isInternalRole(req.user!.role)) updateData.internal_notes = internal_notes;
            if (fit_score !== undefined) updateData.fit_score = fit_score;
            if (custom_field_1 !== undefined) updateData.custom_field_1 = custom_field_1;
            if (custom_field_2 !== undefined) updateData.custom_field_2 = custom_field_2;
            if (custom_field_3 !== undefined) updateData.custom_field_3 = custom_field_3;
            if (next_step !== undefined) updateData.next_step = next_step;
            if (custom_fields !== undefined) updateData.custom_fields = custom_fields;

            // Re-geocode when location field is explicitly changed
            if (location !== undefined) {
                const coords = location ? lookupCoordinates(location) : null;
                updateData.latitude  = coords?.lat ?? null;
                updateData.longitude = coords?.lng ?? null;
                updateData.country   = coords?.country ?? null;
            }

            // Auto-geocode when stage moves into pipeline/terminal and location exists but no coords yet
            if (stage !== undefined && location === undefined && existing.location && existing.latitude == null) {
                const allStages = await getTenantStages(tenantId);
                const isPipelineOrTerminal = allStages.some(
                    (s) => s.slug === stage && (s.stage_type === 'pipeline' || s.stage_type === 'terminal')
                );
                if (isPipelineOrTerminal) {
                    const coords = lookupCoordinates(existing.location);
                    if (coords) {
                        updateData.latitude  = coords.lat;
                        updateData.longitude = coords.lng;
                        updateData.country   = coords.country;
                    }
                }
            }

            const { data, error } = await supabaseAdmin
                .from('companies')
                .update(updateData)
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select()
                .single();

            if (error) {
                log.error({ err: error }, 'Update company error');
                throw new AppError('Failed to update company', 500);
            }

            // Stage changed via edit form — keep statistics cache consistent
            if (updateData.stage !== undefined) {
                invalidateOverviewCache(tenantId);
                invalidatePipelineStatsCache(tenantId);
            }

            res.json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Update company error');
            res.status(500).json({ error: 'Failed to update company' });
        }
    }
);

// POST /api/companies/geocode — Batch geocode pipeline companies missing coordinates
// Streams progress via SSE (text/event-stream); each event is a JSON line prefixed with "data: "
router.post(
    '/geocode',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response): Promise<void> => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/Railway buffering
        res.flushHeaders();

        const send = (data: object) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            // compression middleware adds flush(); call it to push bytes immediately
            if (typeof (res as any).flush === 'function') (res as any).flush();
        };

        try {
            const tenantId = req.tenantId!;

            send({ type: 'progress', message: 'Hazırlanıyor...' });

            send({ type: 'progress', message: 'Konumları eksik şirketler aranıyor...' });

            // Process every stage so the country column gets backfilled for the whole
            // tenant (filter dropdown needs every company's country, not just pipeline
            // ones). Coordinates are also written; the globe map separately filters to
            // pipeline+terminal stages, so writing lat/lng on cold-stage rows is a no-op
            // for the visible map.
            const [totalPipelineRes, noLocationRes, companiesRes] = await Promise.all([
                supabaseAdmin
                    .from('companies')
                    .select('*', { count: 'exact', head: true })
                    .eq('tenant_id', tenantId),
                supabaseAdmin
                    .from('companies')
                    .select('*', { count: 'exact', head: true })
                    .eq('tenant_id', tenantId)
                    .is('location', null)
                    .is('latitude', null),
                // Fetch every company with a location but missing coordinates OR country.
                supabaseAdmin
                    .from('companies')
                    .select('id, location')
                    .eq('tenant_id', tenantId)
                    .not('location', 'is', null)
                    .or('latitude.is.null,country.is.null')
                    .limit(10000),
            ]);

            if (companiesRes.error) {
                send({ type: 'error', message: 'Şirketler yüklenemedi' });
                res.end();
                return;
            }

            const totalPipeline = totalPipelineRes.count || 0;
            const noLocation = noLocationRes.count || 0;
            const companies = companiesRes.data;
            const total = companies?.length || 0;

            send({
                type: 'progress',
                message: `${totalPipeline} şirket tarandı — ${noLocation > 0 ? `${noLocation} şehir bilgisi eksik, ` : ''}${total} koordinatsız şirket bulundu`,
            });

            if (total === 0) {
                send({ type: 'result', total: 0, geocoded: 0, skipped: 0, noLocation, totalPipeline });
                res.end();
                return;
            }

            send({ type: 'progress', message: `${total} şirket için koordinatlar çözümleniyor...` });

            // Resolve coordinates for each company and batch by (lat, lng, country) value
            const updates = new Map<string, { lat: number; lng: number; country: string | null; ids: string[] }>();
            let skipped = 0;
            for (const company of companies || []) {
                if (!company.location) continue;
                const coords = lookupCoordinates(company.location);
                if (coords) {
                    const key = `${coords.lat},${coords.lng},${coords.country ?? ''}`;
                    const group = updates.get(key);
                    if (group) {
                        group.ids.push(company.id);
                    } else {
                        updates.set(key, { lat: coords.lat, lng: coords.lng, country: coords.country, ids: [company.id] });
                    }
                } else {
                    skipped++;
                }
            }

            const resolvable = total - skipped;
            send({
                type: 'progress',
                message: skipped > 0
                    ? `${resolvable} koordinat çözümlendi, ${skipped} konum tanınamadı`
                    : `${resolvable} koordinat çözümlendi`,
            });

            if (resolvable === 0) {
                send({ type: 'result', total, geocoded: 0, skipped, noLocation, totalPipeline });
                res.end();
                return;
            }

            send({ type: 'progress', message: 'Veritabanı güncelleniyor...' });

            // Write coordinates — one UPDATE per unique (lat, lng, country) triple (bulk by id list)
            let geocoded = 0;
            for (const { lat, lng, country, ids } of updates.values()) {
                const { error: updateError } = await supabaseAdmin
                    .from('companies')
                    .update({ latitude: lat, longitude: lng, country })
                    .in('id', ids)
                    .eq('tenant_id', tenantId);
                if (!updateError) geocoded += ids.length;
            }

            log.info({ tenantId, total, geocoded, skipped, noLocation, totalPipeline }, 'Batch geocode complete');
            send({ type: 'result', total, geocoded, skipped, noLocation, totalPipeline });
            res.end();
        } catch (err) {
            log.error({ err }, 'Batch geocode error');
            send({ type: 'error', message: 'Geocoding sırasında bir hata oluştu' });
            res.end();
        }
    }
);

// PATCH /api/companies/bulk-stage — Bulk update stage for multiple companies
router.patch(
    '/bulk-stage',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { ids, stage } = req.body;

            if (!Array.isArray(ids) || ids.length === 0) {
                res.status(400).json({ error: 'Please select at least one company' });
                return;
            }

            if (ids.length > 500) {
                res.status(400).json({ error: 'Cannot update more than 500 companies at once' });
                return;
            }

            const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!ids.every((id: unknown) => typeof id === 'string' && UUID_RE.test(id))) {
                res.status(400).json({ error: 'Some selected companies are not valid. Please refresh and try again.' });
                return;
            }

            const validSlugs = await getValidStageSlugs(tenantId);
            if (!stage || !validSlugs.includes(stage)) {
                res.status(400).json({ error: 'The selected pipeline stage is not valid' });
                return;
            }

            // Terminal stages cannot be set via bulk update — each company requires a closing report
            const terminalSlugs = await getTerminalStageSlugs(tenantId);
            if (terminalSlugs.includes(stage)) {
                res.status(400).json({ error: `Terminal stages (${terminalSlugs.join(', ')}) cannot be set via bulk update. Each company requires an individual closing report.` });
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
            posthog.capture({
                distinctId: req.user!.id,
                event: 'company_bulk_stage_updated',
                properties: {
                    new_stage: stage,
                    count: data?.length || 0,
                    tenant_id: tenantId,
                },
            });
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
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;
            const { stage } = req.body;

            const [validSlugs, pipelineSlugs, terminalSlugs] = await Promise.all([
                getValidStageSlugs(tenantId),
                getPipelineStageSlugs(tenantId),
                getTerminalStageSlugs(tenantId),
            ]);
            if (!stage || !validSlugs.includes(stage)) {
                res.status(400).json({ error: 'The selected pipeline stage is not valid' });
                return;
            }

            // Auto-geocode when entering pipeline/terminal and location exists but no coords yet
            const geocodeData: { latitude?: number; longitude?: number; country?: string | null } = {};
            if (pipelineSlugs.includes(stage) || terminalSlugs.includes(stage)) {
                const { data: companyData } = await supabaseAdmin
                    .from('companies')
                    .select('location, latitude')
                    .eq('id', id)
                    .eq('tenant_id', tenantId)
                    .single();
                if (companyData?.location && companyData.latitude == null) {
                    const coords = lookupCoordinates(companyData.location);
                    if (coords) {
                        geocodeData.latitude = coords.lat;
                        geocodeData.longitude = coords.lng;
                        geocodeData.country = coords.country;
                    }
                }
            }

            const now = new Date().toISOString();
            const { data, error } = await supabaseAdmin
                .from('companies')
                .update({ stage, updated_at: now, stage_changed_at: now, ...geocodeData })
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
            posthog.capture({
                distinctId: req.user!.id,
                event: 'company_stage_changed',
                properties: {
                    company_id: data.id,
                    company_name: data.name,
                    new_stage: data.stage,
                    tenant_id: tenantId,
                },
            });
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
                res.status(400).json({ error: 'There is no text available to translate' });
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

            posthog.capture({
                distinctId: req.user!.id,
                event: 'company_deleted',
                properties: {
                    company_id: id,
                    tenant_id: tenantId,
                },
            });
            res.status(204).send();
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Delete company error');
            res.status(500).json({ error: 'Failed to delete company' });
        }
    }
);

export default router;
