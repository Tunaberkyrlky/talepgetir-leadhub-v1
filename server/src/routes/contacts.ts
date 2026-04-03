import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin, createUserClient } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { translateTexts } from '../lib/deepl.js';
import { validateBody, createContactSchema, updateContactSchema } from '../lib/validation.js';
import { isInternalRole } from '../lib/roles.js';
import { sanitizeSearch } from '../lib/queryUtils.js';

const log = createLogger('route:contacts');

// For read endpoints: internal roles may be operating cross-tenant (X-Tenant-Id header),
// so they require supabaseAdmin. Client roles access only their own tenant — use the
// user client so RLS acts as a second isolation layer.
function dbClient(req: Request) {
    if (isInternalRole(req.user!.role)) return supabaseAdmin;
    return createUserClient(req.accessToken!);
}

const router = Router();

// GET /api/contacts/filter-options — distinct filter values for PeoplePage dropdowns
router.get('/filter-options', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        // Use RPC for seniorities + countries: single query with SQL DISTINCT,
        // far more efficient than fetching all rows and deduplicating in JS.
        // Companies are fetched separately since we need id+name pairs, not just distinct values.
        const [filterRes, companyRes] = await Promise.all([
            supabaseAdmin.rpc('get_contact_filter_options', { p_tenant_id: tenantId }),
            dbClient(req)
                .from('companies')
                .select('id, name')
                .eq('tenant_id', tenantId)
                .order('name'),
        ]);

        if (filterRes.error) {
            log.error({ err: filterRes.error }, 'get_contact_filter_options RPC error');
            throw new AppError('Failed to fetch filter options', 500);
        }

        res.json({
            data: {
                seniorities: filterRes.data?.seniorities || [],
                countries: filterRes.data?.countries || [],
                companies: (companyRes.data || []).map((c: any) => ({ id: c.id, name: c.name })),
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Filter options error');
        res.status(500).json({ error: 'Failed to fetch filter options' });
    }
});

// GET /api/contacts — List contacts with pagination, search, sort, filter
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const companyId = req.query.company_id as string | undefined;

        const db = dbClient(req);

        // When fetching for a company detail page (company_id provided), simple ordered list
        if (companyId) {
            const { data, error } = await db
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

        let query = db
            .from('contacts')
            .select(
                `id, first_name, last_name, email, phone_e164, title, country, seniority,
                 is_primary, linkedin, created_at, updated_at,
                 companies(id, name, stage)`,
                { count: 'exact' }
            )
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
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'List contacts error');
        res.status(500).json({ error: 'Failed to fetch contacts' });
    }
});

// GET /api/contacts/:id — Single contact + company info
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { id } = req.params;

        const { data, error } = await dbClient(req)
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
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Get contact error');
        res.status(500).json({ error: 'Failed to fetch contact' });
    }
});

// POST /api/contacts — Create contact
router.post(
    '/',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(createContactSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { company_id, first_name, last_name, title, email, phone_e164, linkedin, country, seniority, department, is_primary } = req.body;

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

            // Ensure at most one primary per company — unset others before inserting
            if (is_primary) {
                await supabaseAdmin
                    .from('contacts')
                    .update({ is_primary: false })
                    .eq('company_id', company_id)
                    .eq('tenant_id', tenantId);
            }

            // Build payload
            const contactPayload: Record<string, unknown> = {
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
            };

            const { data, error } = await supabaseAdmin
                .from('contacts')
                .insert(contactPayload)
                .select()
                .single();

            if (error) {
                res.status(500).json({ error: 'Failed to create contact' });
                return;
            }

            res.status(201).json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Create contact error');
            res.status(500).json({ error: 'Failed to create contact' });
        }
    }
);

// PUT /api/contacts/:id — Update contact
router.put(
    '/:id',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(updateContactSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            const { company_id, first_name, last_name, title, email, phone_e164, linkedin, country, seniority, department, is_primary } = req.body;

            const updateData: Record<string, unknown> = {};
            if (company_id !== undefined) updateData.company_id = company_id;
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

            // Ensure at most one primary per company — unset others before this update
            if (is_primary === true) {
                const { data: existing } = await supabaseAdmin
                    .from('contacts')
                    .select('company_id')
                    .eq('id', id)
                    .eq('tenant_id', tenantId)
                    .single();

                if (existing?.company_id) {
                    await supabaseAdmin
                        .from('contacts')
                        .update({ is_primary: false })
                        .eq('company_id', existing.company_id)
                        .eq('tenant_id', tenantId)
                        .neq('id', id);
                }
            }

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
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Update contact error');
            res.status(500).json({ error: 'Failed to update contact' });
        }
    }
);

// POST /api/contacts/:id/translate — Translate contact text fields to Turkish
router.post(
    '/:id/translate',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            const { data: contact, error: fetchError } = await supabaseAdmin
                .from('contacts')
                .select('*')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (fetchError || !contact) {
                res.status(404).json({ error: 'Contact not found' });
                return;
            }

            // Collect translatable texts
            const texts: Array<{ field: string; text: string }> = [];

            if (contact.title && contact.title.trim().length >= 2) {
                texts.push({ field: 'title', text: contact.title });
            }

            if (texts.length === 0) {
                res.status(400).json({ error: 'There is no text available to translate' });
                return;
            }

            const translated = await translateTexts(texts);

            if (Object.keys(translated).length === 0) {
                res.status(200).json({ data: contact, message: 'Already in Turkish or no translation needed' });
                return;
            }

            // Build translations object
            const translations: Record<string, unknown> = { translated_at: new Date().toISOString() };
            if (translated.title) translations.title = translated.title;

            const { data: updated, error: updateError } = await supabaseAdmin
                .from('contacts')
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
            log.error({ err }, 'Translate contact error');
            res.status(500).json({ error: 'Translation failed' });
        }
    }
);

// DELETE /api/contacts/:id — Delete contact
router.delete(
    '/:id',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Delete contact error');
            res.status(500).json({ error: 'Failed to delete contact' });
        }
    }
);

export default router;
