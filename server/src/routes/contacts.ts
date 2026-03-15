import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('route:contacts');

// Sanitize search input for safe use in PostgREST .or() filter strings.
function sanitizeSearch(value: string): string {
    return value.replace(/[,().\\]/g, '');
}

const router = Router();

// GET /api/contacts/filter-options — distinct filter values for PeoplePage dropdowns
router.get('/filter-options', async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        const [seniorityRes, countryRes, companyRes] = await Promise.all([
            supabaseAdmin
                .from('contacts')
                .select('seniority')
                .eq('tenant_id', tenantId)
                .not('seniority', 'is', null),
            supabaseAdmin
                .from('contacts')
                .select('country')
                .eq('tenant_id', tenantId)
                .not('country', 'is', null),
            supabaseAdmin
                .from('companies')
                .select('id, name')
                .eq('tenant_id', tenantId)
                .eq('is_active', true)
                .order('name'),
        ]);

        const unique = <T>(arr: T[]): T[] => [...new Set(arr)];

        res.json({
            data: {
                seniorities: unique((seniorityRes.data || []).map((r: any) => r.seniority)).sort(),
                countries: unique((countryRes.data || []).map((r: any) => r.country)).sort(),
                companies: (companyRes.data || []).map((c: any) => ({ id: c.id, name: c.name })),
            },
        });
    } catch (err) {
        log.error({ err }, 'Filter options error');
        res.status(500).json({ error: 'Failed to fetch filter options' });
    }
});

// GET /api/contacts — List contacts with pagination, search, sort, filter
router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const companyId = req.query.company_id as string | undefined;

        // When fetching for a company detail page (company_id provided), simple ordered list
        if (companyId) {
            const { data, error } = await supabaseAdmin
                .from('contacts')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('company_id', companyId)
                .order('is_primary', { ascending: false })
                .order('created_at', { ascending: true });

            if (error) {
                res.status(500).json({ error: 'Failed to fetch contacts' });
                return;
            }
            res.json({ data: data || [] });
            return;
        }

        // PeoplePage: full pagination + filtering
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
        const offset = (page - 1) * limit;
        const search = (req.query.search as string || '').trim();
        const sortBy = (req.query.sortBy as string) || 'updated_at';
        const sortOrder = req.query.sortOrder === 'asc';

        const filterCompanyIds = req.query.company_ids
            ? (req.query.company_ids as string).split(',').filter(Boolean)
            : [];
        const filterSeniorities = req.query.seniorities
            ? (req.query.seniorities as string).split(',').filter(Boolean)
            : [];
        const filterCountries = req.query.countries
            ? (req.query.countries as string).split(',').filter(Boolean)
            : [];

        const allowedSortFields = ['first_name', 'last_name', 'email', 'country', 'seniority', 'created_at', 'updated_at'];
        const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'updated_at';

        let query = supabaseAdmin
            .from('contacts')
            .select(`*, companies(id, name, stage)`, { count: 'exact' })
            .eq('tenant_id', tenantId);

        if (search) {
            const safe = sanitizeSearch(search);
            if (safe.length > 0) {
                query = query.or(
                    `first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,email.ilike.%${safe}%,title.ilike.%${safe}%`
                );
            }
        }
        if (filterCompanyIds.length > 0) query = query.in('company_id', filterCompanyIds);
        if (filterSeniorities.length > 0) query = query.in('seniority', filterSeniorities);
        if (filterCountries.length > 0) query = query.in('country', filterCountries);

        // nullsFirst: false ensures NULLs always go to end regardless of sort direction
        query = query
            .order(safeSortBy, { ascending: sortOrder, nullsFirst: false })
            .order('id', { ascending: true })
            .range(offset, offset + limit - 1);

        const { data, error, count } = await query;

        if (error) {
            log.error({ err: error }, 'List contacts error');
            res.status(500).json({ error: 'Failed to fetch contacts' });
            return;
        }

        const total = count || 0;
        const totalPages = Math.ceil(total / limit);

        res.json({
            data: data || [],
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        log.error({ err }, 'List contacts error');
        res.status(500).json({ error: 'Failed to fetch contacts' });
    }
});

// GET /api/contacts/:id — Single contact + company info
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { id } = req.params;

        const { data, error } = await supabaseAdmin
            .from('contacts')
            .select(`*, companies(id, name, website, stage, location, industry)`)
            .eq('id', id)
            .eq('tenant_id', tenantId)
            .single();

        if (error || !data) {
            res.status(404).json({ error: 'Contact not found' });
            return;
        }

        res.json({ data });
    } catch (err) {
        log.error({ err }, 'Get contact error');
        res.status(500).json({ error: 'Failed to fetch contact' });
    }
});

// POST /api/contacts — Create contact
router.post(
    '/',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { company_id, first_name, last_name, title, email, phone_e164, linkedin, country, seniority, department, is_primary, notes } = req.body;

            if (!company_id || !first_name) {
                res.status(400).json({ error: 'company_id and first_name are required' });
                return;
            }

            const { data: company } = await supabaseAdmin
                .from('companies')
                .select('id')
                .eq('id', company_id)
                .eq('tenant_id', tenantId)
                .single();

            if (!company) {
                res.status(404).json({ error: 'Company not found' });
                return;
            }

            const { data, error } = await supabaseAdmin
                .from('contacts')
                .insert({
                    tenant_id: tenantId,
                    company_id,
                    first_name,
                    last_name: last_name || null,
                    title: title || null,
                    email: email || null,
                    phone_e164: phone_e164 || null,
                    linkedin: linkedin || null,
                    country: country || null,
                    seniority: seniority || null,
                    department: department || null,
                    is_primary: is_primary || false,
                    notes: notes || null,
                })
                .select()
                .single();

            if (error) {
                res.status(500).json({ error: 'Failed to create contact' });
                return;
            }

            res.status(201).json({ data });
        } catch (err) {
            log.error({ err }, 'Create contact error');
            res.status(500).json({ error: 'Failed to create contact' });
        }
    }
);

// PUT /api/contacts/:id — Update contact
router.put(
    '/:id',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            const { first_name, last_name, title, email, phone_e164, linkedin, country, seniority, department, is_primary, notes } = req.body;

            const updateData: Record<string, unknown> = {};
            if (first_name !== undefined) updateData.first_name = first_name;
            if (last_name !== undefined) updateData.last_name = last_name;
            if (title !== undefined) updateData.title = title;
            if (email !== undefined) updateData.email = email;
            if (phone_e164 !== undefined) updateData.phone_e164 = phone_e164;
            if (linkedin !== undefined) updateData.linkedin = linkedin;
            if (country !== undefined) updateData.country = country;
            if (seniority !== undefined) updateData.seniority = seniority;
            if (department !== undefined) updateData.department = department;
            if (is_primary !== undefined) updateData.is_primary = is_primary;
            if (notes !== undefined) updateData.notes = notes;

            const { data, error } = await supabaseAdmin
                .from('contacts')
                .update(updateData)
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select()
                .single();

            if (error || !data) {
                res.status(404).json({ error: 'Contact not found' });
                return;
            }

            res.json({ data });
        } catch (err) {
            log.error({ err }, 'Update contact error');
            res.status(500).json({ error: 'Failed to update contact' });
        }
    }
);

// DELETE /api/contacts/:id — Delete contact (superadmin only)
router.delete(
    '/:id',
    requireRole('superadmin'),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const { error } = await supabaseAdmin
                .from('contacts')
                .delete()
                .eq('id', req.params.id)
                .eq('tenant_id', req.tenantId!);

            if (error) {
                res.status(500).json({ error: 'Failed to delete contact' });
                return;
            }

            res.status(204).send();
        } catch (err) {
            log.error({ err }, 'Delete contact error');
            res.status(500).json({ error: 'Failed to delete contact' });
        }
    }
);

export default router;
