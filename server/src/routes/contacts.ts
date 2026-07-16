import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin, createUserClient } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { translateTexts } from '../lib/deepl.js';
import { validateBody, createContactSchema, updateContactSchema, mergeContactsSchema, BUYING_ROLES, RELATIONSHIP_STATUSES } from '../lib/validation.js';
import { isInternalRole } from '../lib/roles.js';
import { sanitizeSearch } from '../lib/queryUtils.js';
import { isMissingFunctionError, isMissingColumnError } from '../lib/supabaseErrors.js';
import { invalidateOverviewCache } from './statistics.js';
import posthog from '../lib/posthog.js';

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
        let [filterRes, companyRes] = await Promise.all([
            // Archive-aware RPC (migration 137) derives seniority/country options from
            // ACTIVE contacts only. Falls back to the pre-137 RPC (which counts all
            // contacts) if the new function is missing.
            supabaseAdmin.rpc('get_contact_filter_options_archive', { p_tenant_id: tenantId }),
            dbClient(req)
                .from('companies')
                .select('id, name')
                .eq('tenant_id', tenantId)
                .is('archived_at', null) // company dropdown lists active companies only
                .order('name'),
        ]);

        if (filterRes.error && isMissingFunctionError(filterRes.error)) {
            log.warn({ err: filterRes.error }, 'get_contact_filter_options_archive missing (migration 137 pending); falling back to get_contact_filter_options');
            filterRes = await supabaseAdmin.rpc('get_contact_filter_options', { p_tenant_id: tenantId });
        }

        // Pre-137 DB: companies.archived_at doesn't exist yet, so the `.is('archived_at', null)`
        // filter above errors and the companies dropdown comes back EMPTY (companyRes.error set,
        // data null). Retry archived_at-free so the dropdown still lists every company.
        if (companyRes.error && isMissingColumnError(companyRes.error, 'archived_at')) {
            log.warn({ err: companyRes.error }, 'companies.archived_at missing (migration 137 pending); listing all companies for the filter dropdown');
            companyRes = await dbClient(req)
                .from('companies')
                .select('id, name')
                .eq('tenant_id', tenantId)
                .order('name');
        }

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

        // Archive view: default hides archived contacts; ?archived=only returns only them.
        const archivedOnly = (req.query.archived as string || '').trim() === 'only';

        const db = dbClient(req);

        // When fetching for a company detail page (company_id provided), simple ordered list
        if (companyId) {
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
                res.status(400).json({ error: 'Invalid company ID' }); return;
            }
            let byCompanyQuery = db
                .from('contacts')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('company_id', companyId)
                .is('merged_into_id', null);
            byCompanyQuery = archivedOnly
                ? byCompanyQuery.not('archived_at', 'is', null)
                : byCompanyQuery.is('archived_at', null);
            const { data, error } = await byCompanyQuery
                .order('is_primary', { ascending: false })
                .order('created_at', { ascending: true });

            if (error) {
                log.error({ err: error }, 'List contacts by company error');
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
        // Contact-intelligence filters (migration 134). Applied on the no-search path;
        // the search_contacts RPC does not yet project these columns (see route notes).
        // Validate defensively: a repeated query param arrives as an array (no .split),
        // and values must be within the known enum — reject with 400 otherwise.
        const parseEnumFilter = (
            raw: unknown,
            allowed: readonly string[],
        ): { ok: true; values: string[] } | { ok: false } => {
            if (raw === undefined) return { ok: true, values: [] };
            if (typeof raw !== 'string') return { ok: false };
            const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
            if (values.some((v) => !allowed.includes(v))) return { ok: false };
            return { ok: true, values };
        };

        const buyingRolesParsed = parseEnumFilter(req.query.buying_roles, BUYING_ROLES);
        if (!buyingRolesParsed.ok) {
            res.status(400).json({ error: 'Invalid buying_roles filter' });
            return;
        }
        const relationshipStatusesParsed = parseEnumFilter(req.query.relationship_statuses, RELATIONSHIP_STATUSES);
        if (!relationshipStatusesParsed.ok) {
            res.status(400).json({ error: 'Invalid relationship_statuses filter' });
            return;
        }
        const filterBuyingRoles = buyingRolesParsed.values;
        const filterRelationshipStatuses = relationshipStatusesParsed.values;

        const allowedSortFields = ['first_name', 'last_name', 'email', 'country', 'seniority', 'created_at', 'updated_at'];
        const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'updated_at';

        // ── Ranked search path ────────────────────────────────────────────
        // When a search query is present, defer to the search_contacts RPC which
        // ranks: full-name / email exact → first/last exact → email prefix
        // → first/last prefix → contains across first/last/email → title contains.
        if (search.length > 0) {
            const safe = sanitizeSearch(search);
            const searchParams = {
                p_tenant_id:   tenantId,
                p_search:      safe,
                p_company_ids: filterCompanyIds.length > 0 ? filterCompanyIds : null,
                p_seniorities: filterSeniorities.length > 0 ? filterSeniorities : null,
                p_countries:   filterCountries.length > 0 ? filterCountries : null,
                p_limit:       limit,
                p_offset:      offset,
            };

            // Primary path: archive-aware RPC (migration 137) pushes the archive predicate
            // into the WHERE before pagination, so pages/totals are archive-correct (incl.
            // ?archived=only). Falls back to search_contacts + in-page filter if missing.
            let usedArchiveRpc = true;
            // These RPCs are SECURITY DEFINER and accept p_tenant_id, so they must
            // never be callable with the end user's Supabase token. The HTTP auth
            // layer has already resolved tenantId; execute only through service_role.
            let { data: rows, error: rpcErr } = await supabaseAdmin.rpc('search_contacts_archive', {
                ...searchParams,
                p_archived_only: archivedOnly,
            });
            if (rpcErr && isMissingFunctionError(rpcErr)) {
                log.warn({ err: rpcErr }, 'search_contacts_archive missing (migration 137 pending); falling back to search_contacts + in-page archive filter');
                usedArchiveRpc = false;
                ({ data: rows, error: rpcErr } = await supabaseAdmin.rpc('search_contacts', searchParams));
            }

            if (rpcErr) {
                log.error({ err: rpcErr }, 'search_contacts RPC failed');
                res.status(500).json({ error: 'Failed to search contacts' });
                return;
            }

            const list = (rows ?? []) as Array<{
                id: string; first_name: string; last_name: string | null; email: string | null;
                phone_e164: string | null; title: string | null; country: string | null;
                seniority: string | null; is_primary: boolean; linkedin: string | null;
                company_id: string; company_name: string | null; company_stage: string | null;
                created_at: string; updated_at: string; total_count: number;
            }>;
            const total = list.length > 0 ? Number(list[0].total_count) : 0;
            let data = list.map(({ total_count: _ignore, company_name, company_stage, company_id, ...rest }) => ({
                ...rest,
                company_id,
                companies: company_id ? { id: company_id, name: company_name, stage: company_stage } : null,
            }));
            const totalPages = Math.ceil(total / limit);

            // In-page archive filter is ONLY needed on the fallback path (search_contacts_archive
            // already filtered server-side). search_contacts (migration 037) neither returns nor
            // filters archived_at, so identify the archived rows on THIS page with a lightweight id
            // lookup and drop them (default) or keep only them (?archived=only). On the fallback,
            // total_count can slightly over-count archived matches — an accepted edge.
            if (!usedArchiveRpc && data.length > 0) {
                const pageIds = data.map((r) => r.id);
                const { data: archRows, error: archErr } = await db
                    .from('contacts')
                    .select('id')
                    .eq('tenant_id', tenantId)
                    .in('id', pageIds)
                    .not('archived_at', 'is', null);
                // Pre-137 DB: this fallback only runs because search_contacts_archive was
                // missing — so migration 137 hasn't landed and archived_at doesn't exist. A
                // missing-column error means "archive feature off": skip filtering (all rows
                // stay, ?archived is a no-op) rather than 500. Any OTHER error is a real fault.
                if (archErr && !isMissingColumnError(archErr, 'archived_at')) {
                    log.error({ err: archErr }, 'search_contacts archive filter failed');
                    res.status(500).json({ error: 'Failed to search contacts' });
                    return;
                }
                if (!archErr) {
                    const archivedSet = new Set((archRows ?? []).map((r) => r.id));
                    data = archivedOnly
                        ? data.filter((r) => archivedSet.has(r.id))
                        : data.filter((r) => !archivedSet.has(r.id));
                }
            }

            // search_contacts does NOT exclude merged-away sources, so drop any merged row
            // from THIS page with a lightweight id lookup (mirrors the companies path).
            // Page-scoped: `total` above (from the RPC) can slightly OVER-count when merged
            // rows matched — an accepted edge until search_contacts filters merged_into_id.
            if (data.length > 0) {
                const pageIds = data.map((r) => r.id);
                const { data: mergedRows, error: mErr } = await db
                    .from('contacts')
                    .select('id')
                    .eq('tenant_id', tenantId)
                    .in('id', pageIds)
                    .not('merged_into_id', 'is', null);
                if (mErr) {
                    log.error({ err: mErr }, 'search_contacts merged filter failed');
                    res.status(500).json({ error: 'Failed to search contacts' });
                    return;
                }
                const mergedSet = new Set((mergedRows ?? []).map((r) => r.id));
                data = data.filter((r) => !mergedSet.has(r.id));
            }

            res.json({
                data,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages,
                    hasNext: page < totalPages,
                    hasPrev: page > 1,
                },
            });
            return;
        }

        // ── No-search path: original filter+sortBy listing ────────────────
        let query = db
            .from('contacts')
            .select(
                `id, first_name, last_name, email, phone_e164, title, country, seniority,
                 buying_role, relationship_status, preferred_channel,
                 is_primary, linkedin, created_at, updated_at, archived_at,
                 companies(id, name, stage)`,
                { count: 'exact' }
            )
            .eq('tenant_id', tenantId);

        query = archivedOnly ? query.not('archived_at', 'is', null) : query.is('archived_at', null);
        // Hide merged-away sources (merged_into_id NOT NULL) from the default listing —
        // NULL = a live record. The detail route (GET /:id) still returns them 200.
        query = query.is('merged_into_id', null);

        if (filterCompanyIds.length > 0) query = query.in('company_id', filterCompanyIds);
        if (filterSeniorities.length > 0) query = query.in('seniority', filterSeniorities);
        if (filterCountries.length > 0) query = query.in('country', filterCountries);
        if (filterBuyingRoles.length > 0) query = query.in('buying_role', filterBuyingRoles);
        if (filterRelationshipStatuses.length > 0) query = query.in('relationship_status', filterRelationshipStatuses);

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

// GET /api/contacts/:id/duplicates — Possible duplicate contacts within the SAME
// company (merge_contacts is same-company only). Normalised email / phone / name
// matching via find_duplicate_contacts. Read-only, capped at 5.
router.get('/:id/duplicates', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const id = String(req.params.id);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            res.status(400).json({ error: 'Invalid contact id' });
            return;
        }

        const { data: contact, error: cErr } = await supabaseAdmin
            .from('contacts')
            .select('id')
            .eq('id', id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (cErr) throw new AppError('Failed to load contact', 500);
        if (!contact) { res.status(404).json({ error: 'Contact not found' }); return; }

        const { data, error } = await supabaseAdmin.rpc('find_duplicate_contacts', {
            p_tenant_id: tenantId,
            p_contact_id: id,
        });
        if (error) {
            if (isMissingFunctionError(error)) { res.json({ data: [] }); return; }
            log.error({ err: error }, 'find_duplicate_contacts failed');
            throw new AppError('Failed to find duplicates', 500);
        }
        res.json({ data: data || [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Contact duplicates error');
        res.status(500).json({ error: 'Failed to find duplicates' });
    }
});

// POST /api/contacts/merge — Merge a source contact into a target contact (same
// company only). Atomic single merge_contacts RPC: children repoint, field winners
// apply, the source is disabled without data loss, crm_merge_log is written.
router.post(
    '/merge',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(mergeContactsSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { source_id, target_id, field_winners } = req.body;

            const { data: rows, error: chkErr } = await supabaseAdmin
                .from('contacts')
                .select('id')
                .eq('tenant_id', tenantId)
                .in('id', [source_id, target_id]);
            if (chkErr) throw new AppError('Failed to validate contacts', 500);
            const found = new Set((rows || []).map((r) => r.id));
            if (!found.has(source_id) || !found.has(target_id)) {
                res.status(404).json({ error: 'Contact not found' });
                return;
            }

            const { data, error } = await supabaseAdmin.rpc('merge_contacts', {
                p_tenant_id: tenantId,
                p_source_id: source_id,
                p_target_id: target_id,
                p_field_winners: field_winners || {},
                p_performed_by: req.user!.id,
            });
            if (error) {
                if (error.message?.includes('already_merged')) {
                    res.status(409).json({ error: 'One of the records was already merged' });
                    return;
                }
                if (error.message?.includes('same company')) {
                    res.status(422).json({ error: 'Contacts must belong to the same company' });
                    return;
                }
                if (error.message?.includes('must differ')) {
                    res.status(400).json({ error: 'source and target must differ' });
                    return;
                }
                if (error.message?.includes('not found')) {
                    res.status(404).json({ error: 'Contact not found' });
                    return;
                }
                log.error({ err: error }, 'merge_contacts failed');
                throw new AppError('Failed to merge contacts', 500);
            }
            res.json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Merge contacts error');
            res.status(500).json({ error: 'Failed to merge contacts' });
        }
    }
);

// POST /api/contacts — Create contact
router.post(
    '/',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(createContactSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { company_id, first_name, last_name, title, email, phone_e164, linkedin, country, seniority, department, buying_role, relationship_status, preferred_channel, is_primary } = req.body;

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
                const { error: clearErr } = await supabaseAdmin
                    .from('contacts')
                    .update({ is_primary: false })
                    .eq('company_id', company_id)
                    .eq('tenant_id', tenantId);
                if (clearErr) {
                    log.error({ err: clearErr }, 'Failed to clear existing primary contacts');
                    throw new AppError('Failed to update primary contact', 500);
                }
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
                buying_role: buying_role || null,
                relationship_status: relationship_status || null,
                preferred_channel: preferred_channel || null,
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

            posthog.capture({
                distinctId: req.user!.id,
                event: 'contact_created',
                properties: {
                    contact_id: data.id,
                    company_id,
                    is_primary: is_primary || false,
                    tenant_id: req.tenantId!,
                },
            });
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

            const { company_id, first_name, last_name, title, email, phone_e164, linkedin, country, seniority, department, buying_role, relationship_status, preferred_channel, is_primary } = req.body;

            // Validate company_id belongs to the same tenant
            if (company_id !== undefined) {
                const { data: targetCompany } = await supabaseAdmin
                    .from('companies')
                    .select('id')
                    .eq('id', company_id)
                    .eq('tenant_id', tenantId)
                    .single();
                if (!targetCompany) {
                    res.status(404).json({ error: 'Company not found' });
                    return;
                }
            }

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
            if (buying_role !== undefined) updateData.buying_role = buying_role;
            if (relationship_status !== undefined) updateData.relationship_status = relationship_status;
            if (preferred_channel !== undefined) updateData.preferred_channel = preferred_channel;
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
                    const { error: clearErr } = await supabaseAdmin
                        .from('contacts')
                        .update({ is_primary: false })
                        .eq('company_id', existing.company_id)
                        .eq('tenant_id', tenantId)
                        .neq('id', id);
                    if (clearErr) {
                        log.error({ err: clearErr }, 'Failed to clear existing primary contacts');
                        throw new AppError('Failed to update primary contact', 500);
                    }
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

// POST /api/contacts/:id/archive — Soft-archive a contact (reversible; hides it from the
// default People list + company detail card list). UI default instead of delete.
router.post(
    '/:id/archive',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { data, error } = await supabaseAdmin
                .from('contacts')
                .update({ archived_at: new Date().toISOString(), archived_by: req.user!.id })
                .eq('id', req.params.id)
                .eq('tenant_id', req.tenantId!)
                .select()
                .maybeSingle();

            if (error) throw new AppError('Failed to archive contact', 500);
            if (!data) {
                res.status(404).json({ error: 'Contact not found' });
                return;
            }

            // Archiving a contact changes companies.contact_count (trigger) and the
            // dashboard contact totals, so drop the cached overview for this tenant.
            invalidateOverviewCache(req.tenantId!);

            posthog.capture({
                distinctId: req.user!.id,
                event: 'contact_archived',
                properties: { contact_id: req.params.id, tenant_id: req.tenantId! },
            });
            res.json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Archive contact error');
            res.status(500).json({ error: 'Failed to archive contact' });
        }
    }
);

// POST /api/contacts/:id/unarchive — Restore an archived contact (one-tap undo).
router.post(
    '/:id/unarchive',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { data, error } = await supabaseAdmin
                .from('contacts')
                .update({ archived_at: null, archived_by: null })
                .eq('id', req.params.id)
                .eq('tenant_id', req.tenantId!)
                .select()
                .maybeSingle();

            if (error) throw new AppError('Failed to restore contact', 500);
            if (!data) {
                res.status(404).json({ error: 'Contact not found' });
                return;
            }

            // Restoring re-adds the contact to companies.contact_count and the dashboard
            // totals, so drop the cached overview for this tenant.
            invalidateOverviewCache(req.tenantId!);

            posthog.capture({
                distinctId: req.user!.id,
                event: 'contact_unarchived',
                properties: { contact_id: req.params.id, tenant_id: req.tenantId! },
            });
            res.json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Unarchive contact error');
            res.status(500).json({ error: 'Failed to restore contact' });
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

            posthog.capture({
                distinctId: req.user!.id,
                event: 'contact_deleted',
                properties: {
                    contact_id: req.params.id,
                    tenant_id: req.tenantId!,
                },
            });
            res.status(204).send();
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Delete contact error');
            res.status(500).json({ error: 'Failed to delete contact' });
        }
    }
);

export default router;
