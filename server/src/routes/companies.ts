import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin, createUserClient } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { lookupCoordinates } from '../lib/geocoder.js';
import { translateTexts } from '../lib/deepl.js';
import { validateBody, createCompanySchema, updateCompanySchema, bulkOwnerSchema, sanitizeEmail } from '../lib/validation.js';
import { resolveUsers, ownerDisplayName } from '../lib/userResolver.js';
import { parseList } from '../lib/parseList.js';
import { isInternalRole } from '../lib/roles.js';
import { sanitizeSearch } from '../lib/queryUtils.js';
import { getValidStageSlugs, getPipelineStageSlugs, getTerminalStageSlugs, getTenantStages } from './settings.js';
import { invalidateOverviewCache, invalidatePipelineStatsCache } from './statistics.js';
import posthog from '../lib/posthog.js';

const log = createLogger('route:companies');

// product_services / product_portfolio are now text[] lists (product categories) —
// excluded from translation (the values are short keywords that don't need DeepL).
const COMPANY_TRANSLATE_FIELDS = ['company_summary', 'next_step', 'industry'] as const;

const router = Router();

// For read endpoints: internal roles may be operating cross-tenant (X-Tenant-Id header),
// so they require supabaseAdmin. Client roles access only their own tenant — use the
// user client so RLS acts as a second isolation layer.
function dbClient(req: Request) {
    if (isInternalRole(req.user!.role)) return supabaseAdmin;
    return createUserClient(req.accessToken!);
}


const VALID_EMAIL_STATUSES = ['valid', 'uncertain', 'invalid'] as const;

// "Last contact" on the pipeline card counts only genuine human-touch activities.
// System-generated types (status_change on stage moves, sonlandirma_raporu closing reports)
// are intentionally excluded — they are audit lines, not outreach. Mirrors the human-facing
// activity set (ALLOWED_ACTIVITY_TYPES = not/meeting/follow_up) plus the outbound touches
// call and campaign_email.
const HUMAN_CONTACT_ACTIVITY_TYPES = ['not', 'meeting', 'follow_up', 'call', 'campaign_email'] as const;

// Split an id list into fixed-size chunks so a `.in('company_id', ids)` filter never
// balloons the request URL (PostgREST inlines every value) or hits a single huge scan.
function chunkIds<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}
const PIPELINE_ID_CHUNK = 100;

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ensures an owner is an active member of the tenant before we assign a company to them.
// Self-assignment (creator keeping/taking their own lead) is always allowed — an internal
// role operating cross-tenant may not itself be a member of the target tenant, which mirrors
// the existing create-company behaviour of defaulting assigned_to to the acting user.
async function assertAssignableOwner(tenantId: string, userId: string | null | undefined, currentUserId: string) {
    if (!userId || userId === currentUserId) return;
    const { data, error } = await supabaseAdmin
        .from('memberships')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('user_id', userId)
        .eq('is_active', true)
        .maybeSingle();
    if (error) throw new AppError('Failed to validate owner', 500);
    if (!data) throw new AppError('Owner is not an active member of this workspace', 422);
}

// Records an owner change on each company's timeline as a system `status_change` activity
// (the type is intentionally reused — no new activity type). Names are resolved so the entry
// reads "Sahip değişikliği: Ali → Ayşe"; a null owner reads as the unassigned queue. Internal
// visibility keeps it as an ops audit line. Best-effort: a failure here must not undo the
// owner update itself, so the caller ignores the result.
const OWNER_UNASSIGNED_LABEL = 'Sahipsiz';
async function recordOwnerChanges(
    tenantId: string,
    actorId: string,
    changes: Array<{ companyId: string; oldOwner: string | null; newOwner: string | null }>,
): Promise<void> {
    if (changes.length === 0) return;
    try {
        const users = await resolveUsers(changes.flatMap((c) => [c.oldOwner || '', c.newOwner || '']).filter(Boolean));
        const label = (id: string | null) => {
            if (!id) return OWNER_UNASSIGNED_LABEL;
            return ownerDisplayName(users.get(id) || null) || OWNER_UNASSIGNED_LABEL;
        };
        const now = new Date().toISOString();
        const rows = changes.map((c) => ({
            tenant_id: tenantId,
            company_id: c.companyId,
            type: 'status_change',
            summary: `Sahip değişikliği: ${label(c.oldOwner)} → ${label(c.newOwner)}`,
            visibility: 'internal',
            occurred_at: now,
            created_by: actorId,
        }));
        const { error } = await supabaseAdmin.from('activities').insert(rows);
        if (error) log.warn({ err: error }, 'Record owner change activity failed');
    } catch (err) {
        log.warn({ err }, 'Record owner change activity failed');
    }
}

// Attaches a resolved { id, name, email } owner to each row so the client never receives a
// bare assigned_to UUID. resolveUsers batches + caches the auth lookups. Mutates in place.
async function enrichOwners(rows: Array<Record<string, unknown>>): Promise<void> {
    const users = await resolveUsers(rows.map((r) => (r.assigned_to as string) || '').filter(Boolean));
    for (const row of rows) {
        const ownerId = row.assigned_to as string | null;
        const resolved = ownerId ? users.get(ownerId) || null : null;
        row.assigned_user = resolved
            ? { id: resolved.id, name: ownerDisplayName(resolved), email: resolved.email }
            : null;
    }
}

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

        // Owner filter: 'me' (current user), 'unassigned' (assigned_to IS NULL), or a member UUID.
        // Resolved to a concrete predicate once, then applied to the no-search path below.
        const ownerParam = (req.query.owner as string || '').trim();
        let ownerFilter: { mode: 'me' | 'unassigned' | 'uuid'; id?: string } | null = null;
        if (ownerParam === 'me') ownerFilter = { mode: 'me', id: req.user!.id };
        else if (ownerParam === 'unassigned') ownerFilter = { mode: 'unassigned' };
        else if (ownerParam) {
            if (!UUID_RE.test(ownerParam)) {
                res.status(400).json({ error: 'Invalid owner filter' });
                return;
            }
            ownerFilter = { mode: 'uuid', id: ownerParam };
        }

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

        // ── Ranked search path ────────────────────────────────────────────
        // When a search query is present, defer to the search_companies RPC
        // which returns rows ordered by match strength (exact name match first,
        // then prefix, then substring across name/website/industry/location/next_step).
        // User-selected sortBy is ignored in this path — relevance dominates.
        if (search.length > 0) {
            const safe = sanitizeSearch(search);
            const namedLocations = locations.filter(l => l !== '__empty__' && l !== '__not_geocoded__');
            const locationsParam = locations.length > 0 ? locations : null;

            const { data: rows, error: rpcErr } = await db.rpc('search_companies', {
                p_tenant_id:  tenantId,
                p_search:     safe,
                p_stages:     stages.length > 0 ? stages : null,
                p_industries: industries.length > 0 ? industries : null,
                p_locations:  locationsParam,
                p_countries:  countries.length > 0 ? countries : null,
                p_products:   products.length > 0 ? products : null,
                p_date_from:  dateFrom || null,
                p_date_to:    dateTo || null,
                p_limit:      limit,
                p_offset:     offset,
            });
            void namedLocations; // resolved inside the RPC

            if (rpcErr) {
                log.error({ err: rpcErr }, 'search_companies RPC failed');
                throw new AppError('Failed to search companies', 500);
            }

            const list = (rows ?? []) as Array<Record<string, unknown> & { total_count: number }>;
            const total = list.length > 0 ? Number(list[0].total_count) : 0;
            const data = list.map(({ total_count: _ignore, ...rest }) => rest);
            const totalPages = Math.ceil(total / limit);

            // Owner filter is intentionally NOT applied in the ranked-search path (the
            // search_companies RPC has no owner parameter); still enrich so the owner NAME
            // shows and no raw UUID leaks while a text search is active.
            await enrichOwners(data);

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
        // Build count query with filters
        let countQuery = db
            .from('companies')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId);

        let dataQuery = db
            .from('companies')
            .select('id, name, website, location, latitude, industry, employee_size, product_services, product_portfolio, linkedin, company_phone, company_email, email_status, stage, company_summary, next_step, assigned_to, fit_score, custom_field_1, custom_field_2, custom_field_3, contact_count, created_at, updated_at')
            .eq('tenant_id', tenantId);

        // (search handled via RPC in the ranked path above — no ILIKE here)

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

        // Apply product_services filter — product_services is text[], so match
        // companies whose list overlaps any of the selected products.
        if (products.length > 0) {
            countQuery = countQuery.overlaps('product_services', products);
            dataQuery = dataQuery.overlaps('product_services', products);
        }

        // Apply owner filter (me / unassigned / specific member)
        if (ownerFilter) {
            if (ownerFilter.mode === 'unassigned') {
                countQuery = countQuery.is('assigned_to', null);
                dataQuery = dataQuery.is('assigned_to', null);
            } else {
                countQuery = countQuery.eq('assigned_to', ownerFilter.id!);
                dataQuery = dataQuery.eq('assigned_to', ownerFilter.id!);
            }
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

        const rows = (data || []) as Array<Record<string, unknown>>;
        await enrichOwners(rows);

        res.json({
            data: rows,
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

        // Work-signal filters are mutually exclusive: a company either has an overdue task or
        // has no task at all — never both. AND-ing them always yields an empty board, so reject
        // the combination up front (400) instead of silently returning nothing.
        const hasOverdueTaskFilter = req.query.has_overdue_task === 'true';
        const noTaskFilter = req.query.no_task === 'true';
        if (hasOverdueTaskFilter && noTaskFilter) {
            throw new AppError('Filters are mutually exclusive', 400);
        }

        // Dynamic pipeline stages from tenant config
        const pipelineStages = await getPipelineStageSlugs(tenantId);
        const terminalStages = await getTerminalStageSlugs(tenantId);

        const db = dbClient(req);

        let query = db
            .from('companies')
            .select('id, name, industry, stage, next_step, company_summary, updated_at, stage_changed_at, contact_count, assigned_to')
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

        // --- Working signals (A3): next pending task, last human contact, owner ----------
        // Batched, chunked queries keyed on the company-id list — never per-company (N+1).
        // Each company id lives in exactly one chunk, so keeping the first row seen per company
        // (ordered within its chunk) still yields that company's true min-due / latest-contact.
        const activeRows = data ?? [];
        const activeIds = activeRows.map((c: any) => c.id);
        const idChunks = chunkIds(activeIds, PIPELINE_ID_CHUNK);

        // Next pending task per company = smallest due_at (idx_tasks_company_due already covers
        // tenant_id, company_id, due_at WHERE status = 'pending'). is_overdue is a request-time
        // hint; the client recomputes it from due_at so a cached card can't go stale.
        const nextTasks: Record<string, { id: string; title: string; due_at: string; is_overdue: boolean }> = {};
        for (const idChunk of idChunks) {
            const { data: taskRows, error: taskErr } = await db
                .from('tasks')
                .select('company_id, id, title, due_at')
                .eq('tenant_id', tenantId)
                .eq('status', 'pending')
                .in('company_id', idChunk)
                .order('due_at', { ascending: true })
                .limit(2000);
            if (taskErr) {
                // Don't blank signals silently — log and leave this chunk's cards task-hint-free.
                log.warn({ err: taskErr }, 'Pipeline next-task signal query failed for a chunk; leaving those cards without a task hint');
                continue;
            }
            for (const tk of taskRows ?? []) {
                if (!nextTasks[tk.company_id]) {
                    nextTasks[tk.company_id] = {
                        id: tk.id,
                        title: tk.title,
                        due_at: tk.due_at,
                        is_overdue: new Date(tk.due_at).getTime() < Date.now(),
                    };
                }
            }
        }

        // Last contact = latest occurred_at across human-touch activity types only.
        const lastContacts: Record<string, string> = {};
        for (const idChunk of idChunks) {
            const { data: actRows, error: actErr } = await db
                .from('activities')
                .select('company_id, occurred_at')
                .eq('tenant_id', tenantId)
                .in('type', [...HUMAN_CONTACT_ACTIVITY_TYPES])
                .in('company_id', idChunk)
                .order('occurred_at', { ascending: false })
                .limit(5000); // per-chunk row cap; a company whose latest contact sorts past this row is missed — PostgREST has no per-group limit, so the true fix is a window-function RPC (deferred).
            if (actErr) {
                // Don't blank signals silently — log and leave this chunk's cards contact-hint-free.
                log.warn({ err: actErr }, 'Pipeline last-contact signal query failed for a chunk; leaving those cards without a contact hint');
                continue;
            }
            for (const a of actRows ?? []) {
                if (!lastContacts[a.company_id]) lastContacts[a.company_id] = a.occurred_at;
            }
        }

        // Resolve owners once (batched + cached); never expose the raw assigned_to UUID.
        await enrichOwners(activeRows);

        // Additive work-signal filters — applied BEFORE grouping so per-column counts and the
        // client's active total stay consistent. (Read + validated mutually exclusive above.)
        const filteredRows = activeRows.filter((c: any) => {
            if (noTaskFilter && nextTasks[c.id]) return false;
            if (hasOverdueTaskFilter && !nextTasks[c.id]?.is_overdue) return false;
            return true;
        });

        // Group by stage
        const columns: Record<string, any[]> = {};
        for (const stage of pipelineStages) {
            columns[stage] = [];
        }
        for (const company of filteredRows) {
            const col = columns[company.stage];
            if (!col) continue;
            // enrichOwners already attached assigned_user — drop the raw owner UUID so it
            // never leaks to the client in the pipeline response.
            delete (company as any).assigned_to;
            col.push({
                ...company,
                next_task: nextTasks[company.id] || null,
                last_contact_at: lastContacts[company.id] || null,
            });
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

        const enriched = { ...data } as Record<string, unknown>;
        await enrichOwners([enriched]);
        res.json({ data: { ...enriched, contacts: contacts || [] } });
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
                fit_score, custom_field_1, custom_field_2, custom_field_3, assigned_to,
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

            // Owner contract: omit assigned_to (undefined) -> default to the creator; an explicit
            // null -> unassigned (queue); an explicit uuid must be an active member of the tenant.
            const ownerId = assigned_to === undefined ? req.user!.id : assigned_to;
            await assertAssignableOwner(tenantId, ownerId, req.user!.id);

            // 1. Build payload
            const companyPayload: Record<string, unknown> = {
                tenant_id: tenantId,
                name: name.trim(),
                website: website || null,
                location: location || null,
                industry: industry ? industry.charAt(0).toUpperCase() + industry.slice(1) : null,
                employee_size: employee_size || null,
                product_services: parseList(product_services),
                product_portfolio: parseList(product_portfolio),
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
                assigned_to: ownerId,
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

            // Verify company belongs to tenant (also fetch fields needed for auto-geocoding + owner change)
            const { data: existing } = await supabaseAdmin
                .from('companies')
                .select('id, location, latitude, assigned_to')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (!existing) {
                res.status(404).json({ error: 'Company not found' });
                return;
            }

            const { name, website, location, industry, employee_size, product_services, product_portfolio, linkedin, company_phone, company_email: rawCompanyEmail, email_status, stage, company_summary, internal_notes, next_step, custom_fields, fit_score, custom_field_1, custom_field_2, custom_field_3, assigned_to } = req.body;

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
            if (product_services !== undefined) updateData.product_services = parseList(product_services);
            if (product_portfolio !== undefined) updateData.product_portfolio = parseList(product_portfolio);
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

            // Owner (re)assignment — null clears the owner (unassigned queue).
            const ownerChanged = assigned_to !== undefined && (assigned_to || null) !== (existing.assigned_to || null);
            if (ownerChanged) {
                await assertAssignableOwner(tenantId, assigned_to, req.user!.id);
                updateData.assigned_to = assigned_to || null;
            }

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

            // Owner change → timeline audit line (best-effort, does not block the response)
            if (ownerChanged) {
                await recordOwnerChanges(tenantId, req.user!.id, [{
                    companyId: id as string,
                    oldOwner: existing.assigned_to || null,
                    newOwner: assigned_to || null,
                }]);
            }

            const enriched = { ...(data as Record<string, unknown>) };
            await enrichOwners([enriched]);
            res.json({ data: enriched });
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

            // Only geocode companies visible on the map: pipeline + terminal stages.
            // Country backfill for non-pipeline rows is handled separately via a one-shot
            // SQL pass on the location column (most are direct country names) — keeps this
            // endpoint snappy for the typical "resolve missing coordinates" use case.
            const allStages = await getTenantStages(tenantId);
            const targetStages = allStages
                .filter((s) => s.stage_type === 'pipeline' || s.stage_type === 'terminal')
                .map((s) => s.slug);

            if (targetStages.length === 0) {
                send({ type: 'result', total: 0, geocoded: 0, skipped: 0 });
                res.end();
                return;
            }

            send({ type: 'progress', message: 'Konumları eksik şirketler aranıyor...' });

            const [totalPipelineRes, noLocationRes, companiesRes] = await Promise.all([
                supabaseAdmin
                    .from('companies')
                    .select('*', { count: 'exact', head: true })
                    .eq('tenant_id', tenantId)
                    .in('stage', targetStages),
                supabaseAdmin
                    .from('companies')
                    .select('*', { count: 'exact', head: true })
                    .eq('tenant_id', tenantId)
                    .in('stage', targetStages)
                    .is('location', null)
                    .is('latitude', null),
                // Pipeline companies with a location but missing coordinates OR country.
                supabaseAdmin
                    .from('companies')
                    .select('id, location')
                    .eq('tenant_id', tenantId)
                    .in('stage', targetStages)
                    .not('location', 'is', null)
                    .or('latitude.is.null,country.is.null'),
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

            log.info({ tenantId, targetStages, total, geocoded, skipped, noLocation, totalPipeline }, 'Batch geocode complete');
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

// PATCH /api/companies/bulk-owner — Bulk (re)assign owner for multiple companies
router.patch(
    '/bulk-owner',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(bulkOwnerSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { ids, assigned_to } = req.body as { ids: string[]; assigned_to: string | null };

            await assertAssignableOwner(tenantId, assigned_to, req.user!.id);

            // Snapshot current owners (tenant-scoped) so we can record precise per-company
            // timeline entries and skip companies that already have this owner.
            const { data: before, error: beforeError } = await supabaseAdmin
                .from('companies')
                .select('id, assigned_to')
                .in('id', ids)
                .eq('tenant_id', tenantId);

            if (beforeError) throw new AppError('Failed to load companies', 500);

            const changes = (before || [])
                .filter((c) => (c.assigned_to || null) !== (assigned_to || null))
                .map((c) => ({ companyId: c.id as string, oldOwner: (c.assigned_to as string) || null, newOwner: assigned_to }));

            const { data, error } = await supabaseAdmin
                .from('companies')
                .update({ assigned_to, updated_at: new Date().toISOString() })
                .in('id', ids)
                .eq('tenant_id', tenantId)
                .select('id');

            if (error) throw new AppError('Failed to bulk assign owner', 500);

            await recordOwnerChanges(tenantId, req.user!.id, changes);

            invalidateOverviewCache(tenantId);
            invalidatePipelineStatsCache(tenantId);
            posthog.capture({
                distinctId: req.user!.id,
                event: 'company_bulk_owner_assigned',
                properties: {
                    unassigned: assigned_to === null,
                    count: data?.length || 0,
                    tenant_id: tenantId,
                },
            });
            res.json({ updated: data?.length || 0 });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Bulk owner assign error');
            res.status(500).json({ error: 'Failed to bulk assign owner' });
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
