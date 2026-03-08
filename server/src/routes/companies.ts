import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

// Valid stages for companies
const VALID_STAGES = [
    'new', 'researching', 'contacted', 'meeting_scheduled',
    'proposal_sent', 'negotiation', 'won', 'lost', 'on_hold',
] as const;

// Valid sort columns (whitelist to prevent injection)
const SORT_COLUMNS: Record<string, string> = {
    name: 'name',
    stage: 'stage',
    industry: 'industry',
    location: 'location',
    updated_at: 'updated_at',
    created_at: 'created_at',
};

// GET /api/companies — List with pagination, search, filter, sort
router.get('/', async (req: Request, res: Response): Promise<void> => {
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

        // Sort params
        const sortBy = SORT_COLUMNS[req.query.sortBy as string] || 'updated_at';
        const sortOrder = (req.query.sortOrder as string) === 'asc';

        // Build count query with filters
        let countQuery = supabaseAdmin
            .from('companies')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId);

        // Build data query with filters (contacts(count) gives embedded contact count)
        let dataQuery = supabaseAdmin
            .from('companies')
            .select('id, name, website, location, industry, employee_size, product_services, description, linkedin, company_phone, stage, deal_summary, next_step, assigned_to, created_at, updated_at, contacts(count)')
            .eq('tenant_id', tenantId);

        // Apply search (ILIKE on multiple columns)
        if (search) {
            const pattern = `%${search}%`;
            const searchFilter = `name.ilike.${pattern},website.ilike.${pattern},industry.ilike.${pattern},next_step.ilike.${pattern}`;
            countQuery = countQuery.or(searchFilter);
            dataQuery = dataQuery.or(searchFilter);
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

        const { count, error: countError } = await countQuery;

        if (countError) {
            throw new AppError('Failed to count companies', 500);
        }

        // Apply sort and pagination
        const { data, error } = await dataQuery
            .order(sortBy, { ascending: sortOrder })
            .range(offset, offset + limit - 1);

        if (error) {
            throw new AppError('Failed to fetch companies', 500);
        }

        const totalPages = Math.ceil((count || 0) / limit);

        // Flatten contacts count: Supabase returns contacts as [{ count: N }]
        const companies = (data || []).map((c: any) => ({
            ...c,
            contact_count: (c.contacts?.[0]?.count ?? 0) as number,
            contacts: undefined,
        }));

        res.json({
            data: companies,
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
        if (err instanceof AppError) throw err;
        console.error('List companies error:', err);
        res.status(500).json({ error: 'Failed to fetch companies' });
    }
});

// GET /api/companies/:id — Get single company
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
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
        console.error('Get company error:', err);
        res.status(500).json({ error: 'Failed to fetch company' });
    }
});

// POST /api/companies — Create new company
router.post(
    '/',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const {
                name, website, location, industry, employee_size, product_services, description, linkedin, company_phone,
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

            // 1. Insert Company
            const { data: company, error: companyError } = await supabaseAdmin
                .from('companies')
                .insert({
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
                    stage: stage || 'new',
                    deal_summary: deal_summary || null,
                    internal_notes: internal_notes || null,
                    next_step: next_step || null,
                    custom_fields: custom_fields || {},
                    assigned_to: req.user!.id,
                })
                .select()
                .single();

            if (companyError) {
                console.error('Insert company error:', companyError);
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
                    console.error('Insert initial contact error:', contactError);
                    // Do not fail the whole request since company was created
                } else {
                    contact = newContact;
                }
            }

            res.status(201).json({ data: { ...company, contacts: contact ? [contact] : [] } });
        } catch (err) {
            if (err instanceof AppError) throw err;
            console.error('Create company error:', err);
            res.status(500).json({ error: 'Failed to create company' });
        }
    }
);

// PUT /api/companies/:id — Update company
router.put(
    '/:id',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response): Promise<void> => {
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

            const { name, website, location, industry, employee_size, product_services, description, linkedin, company_phone, stage, deal_summary, internal_notes, next_step, custom_fields } = req.body;

            // Validate stage if provided
            if (stage && !VALID_STAGES.includes(stage)) {
                res.status(400).json({
                    error: `Invalid stage. Valid stages: ${VALID_STAGES.join(', ')}`
                });
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
            if (stage !== undefined) updateData.stage = stage;
            if (deal_summary !== undefined) updateData.deal_summary = deal_summary;
            if (internal_notes !== undefined) updateData.internal_notes = internal_notes;
            if (next_step !== undefined) updateData.next_step = next_step;
            if (custom_fields !== undefined) updateData.custom_fields = custom_fields;

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
            if (err instanceof AppError) throw err;
            console.error('Update company error:', err);
            res.status(500).json({ error: 'Failed to update company' });
        }
    }
);

// DELETE /api/companies/:id — Delete company (superadmin only)
router.delete(
    '/:id',
    requireRole('superadmin'),
    async (req: Request, res: Response): Promise<void> => {
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
            if (err instanceof AppError) throw err;
            console.error('Delete company error:', err);
            res.status(500).json({ error: 'Failed to delete company' });
        }
    }
);

export default router;
