import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin, createUserClient } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { lookupCoordinates } from '../lib/geocoder.js';
import { translateTexts } from '../lib/deepl.js';
import { validateBody, createCompanyQualifiedSchema, updateCompanyQualifiedSchema, bulkOwnerSchema, bulkUpdateCompaniesSchema, stagePatchSchema, sanitizeEmail, mergeCompaniesSchema, COMPANY_PRIORITIES, QUALIFICATION_STATUSES } from '../lib/validation.js';
import { transitionCompanyStage, assertStageTransition, recordStageChangeActivity } from '../lib/stageTransition.js';
import { resolveUsers, ownerDisplayName } from '../lib/userResolver.js';
import { parseList } from '../lib/parseList.js';
import { isInternalRole } from '../lib/roles.js';
import { sanitizeSearch } from '../lib/queryUtils.js';
import { isMissingFunctionError, isMissingColumnError } from '../lib/supabaseErrors.js';
import { getValidStageSlugs, getPipelineStageSlugs, getTerminalStageSlugs, getTenantStages } from './settings.js';
import { invalidateOverviewCache, invalidatePipelineStatsCache } from './statistics.js';
import posthog from '../lib/posthog.js';

const log = createLogger('route:companies');

// product_services is a text[] list (product categories) —
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

type PipelineSignals = {
    nextTasks: Record<string, { id: string; title: string; due_at: string; is_overdue: boolean }>;
    lastContacts: Record<string, string>;
};

// Fallback for the get_pipeline_signals RPC (migration 119): the original chunked
// PostgREST queries. Correct but per-chunk-capped — a company whose latest human
// contact sorts past the activities cap loses its contact hint (the window-function
// RPC has no per-group cap). Used only when the RPC isn't present / errors.
async function computePipelineSignalsFallback(
    db: ReturnType<typeof dbClient>,
    tenantId: string,
    activeIds: string[],
): Promise<PipelineSignals> {
    const idChunks = chunkIds(activeIds, PIPELINE_ID_CHUNK);

    // Next pending task per company = smallest due_at (idx_tasks_company_due already covers
    // tenant_id, company_id, due_at WHERE status = 'pending'). is_overdue is a request-time
    // hint; the client recomputes it from due_at so a cached card can't go stale.
    const nextTasks: PipelineSignals['nextTasks'] = {};
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
    const lastContacts: PipelineSignals['lastContacts'] = {};
    for (const idChunk of idChunks) {
        const { data: actRows, error: actErr } = await db
            .from('activities')
            .select('company_id, occurred_at')
            .eq('tenant_id', tenantId)
            .in('type', [...HUMAN_CONTACT_ACTIVITY_TYPES])
            .in('company_id', idChunk)
            .order('occurred_at', { ascending: false })
            .limit(5000); // per-chunk row cap; a company whose latest contact sorts past this row is missed — the get_pipeline_signals RPC (migration 119) removes this cap.
        if (actErr) {
            // Don't blank signals silently — log and leave this chunk's cards contact-hint-free.
            log.warn({ err: actErr }, 'Pipeline last-contact signal query failed for a chunk; leaving those cards without a contact hint');
            continue;
        }
        for (const a of actRows ?? []) {
            if (!lastContacts[a.company_id]) lastContacts[a.company_id] = a.occurred_at;
        }
    }

    return { nextTasks, lastContacts };
}

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
// reads "Sahip değişikliği: Ali → Ayşe"; a null owner reads as the unassigned queue. The
// resolved from/to names are also stored as a JSON payload in `detail` so the client can
// render a localized line (never a raw UUID). visibility stays `internal` (an ops audit line,
// per the 2026-07-11 product decision) — this slice localizes the text only.
// Best-effort: a failure here must not undo the owner update itself, so the caller ignores
// the result.
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
        // For the STRUCTURED payload the client localizes, an unassigned owner is a locale-neutral
        // null (the client renders null as a localized "unassigned" via parseOwnerChange). The
        // Turkish OWNER_UNASSIGNED_LABEL survives ONLY in the legacy `summary` fallback below.
        const nameOrNull = (id: string | null) => (id ? ownerDisplayName(users.get(id) || null) || null : null);
        const now = new Date().toISOString();
        const rows = changes.map((c) => ({
            tenant_id: tenantId,
            company_id: c.companyId,
            type: 'status_change',
            // Human-readable Turkish fallback for legacy / non-localized views.
            summary: `Sahip değişikliği: ${label(c.oldOwner)} → ${label(c.newOwner)}`,
            // Structured payload the client renders as a localized line — resolved names only.
            detail: JSON.stringify({ k: 'owner_change', from: nameOrNull(c.oldOwner), to: nameOrNull(c.newOwner) }),
            // Stays 'internal' per the 2026-07-11 product decision (reassign is an ops audit line).
            // The timeline already shows internal rows to client roles (with a badge); this slice
            // only localizes the text, it does NOT reclassify the row's visibility.
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

// Resolve the DISTINCT set of company ids in a tenant carrying ANY of the given
// tag ids (v2 Phase 6 tag filter). Returns [] when no company matches — the caller
// then short-circuits to an empty page rather than passing an empty `.in()`.
async function resolveTagCompanyIds(
    db: ReturnType<typeof dbClient>,
    tenantId: string,
    tagIds: string[],
): Promise<string[]> {
    const { data, error } = await db
        .from('company_tags')
        .select('company_id')
        .eq('tenant_id', tenantId)
        .in('tag_id', tagIds);
    if (error) {
        log.error({ err: error }, 'Tag filter resolution failed');
        throw new AppError('Failed to filter by tags', 500);
    }
    return Array.from(new Set((data || []).map((r) => r.company_id as string)));
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
        // Qualification filters (v2 Phase 6). These + the tag filter apply on the
        // no-search path only — the ranked search RPC has no parameter for them, so
        // they are ignored when a free-text search is also active (documented).
        const tags = (req.query.tags as string || '').split(',').filter(Boolean);
        const priorityFilter = (req.query.priority as string || '').split(',').filter(Boolean);
        const qualStatusFilter = (req.query.qualification_status as string || '').split(',').filter(Boolean);
        if (tags.some((t) => !UUID_RE.test(t))) {
            res.status(400).json({ error: 'Invalid tag filter' });
            return;
        }
        if (priorityFilter.some((p) => !COMPANY_PRIORITIES.includes(p as typeof COMPANY_PRIORITIES[number]))) {
            res.status(400).json({ error: 'Invalid priority filter' });
            return;
        }
        if (qualStatusFilter.some((q) => !QUALIFICATION_STATUSES.includes(q as typeof QUALIFICATION_STATUSES[number]))) {
            res.status(400).json({ error: 'Invalid qualification status filter' });
            return;
        }

        // Archive view: the default listing hides archived rows (archived_at IS NULL);
        // ?archived=only returns ONLY archived rows (the "Arşiv" view + restore flow).
        const archivedOnly = (req.query.archived as string || '').trim() === 'only';

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

            const baseParams = {
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
            };
            void namedLocations; // resolved inside the RPC

            // Owner filter now applies during search too (search_companies gained
            // p_owner / p_unassigned in migration 118). Append the params ONLY when an
            // owner filter is set, so an owner-less search stays byte-identical to the
            // 11-arg call and keeps working on a pre-118 DB.
            const ownerParams = ownerFilter
                ? {
                      p_owner:      ownerFilter.mode === 'unassigned' ? null : ownerFilter.id,
                      p_unassigned: ownerFilter.mode === 'unassigned',
                  }
                : {};

            // Primary path: archive-aware RPC (migration 137) pushes the archive predicate
            // INTO the WHERE before count(*) OVER() + LIMIT/OFFSET, so pages and totals are
            // archive-correct even for ?archived=only. It also carries the owner params, so a
            // single call covers both filters.
            let ownerFilterDropped = false;
            let usedArchiveRpc = true;
            // These RPCs are SECURITY DEFINER and accept p_tenant_id, so they must
            // never be callable with the end user's Supabase token. The HTTP auth
            // layer has already resolved tenantId; execute only through service_role.
            let { data: rows, error: rpcErr } = await supabaseAdmin.rpc('search_companies_archive', {
                ...baseParams,
                ...ownerParams,
                p_archived_only: archivedOnly,
            });

            // Pre-137 DB: the _archive RPC doesn't exist yet. Fall back to the shared
            // search_companies RPC + in-page archive filter (the old behavior). This is the
            // ONLY case where the page/total can be a slight over-count for archived matches.
            if (rpcErr && isMissingFunctionError(rpcErr)) {
                log.warn({ err: rpcErr }, 'search_companies_archive missing (migration 137 pending); falling back to search_companies + in-page archive filter');
                usedArchiveRpc = false;
                ({ data: rows, error: rpcErr } = await supabaseAdmin.rpc('search_companies', { ...baseParams, ...ownerParams }));

                // Pre-118 DB: the owner-param overload doesn't exist either, so retry owner-less
                // so search still returns (owner filter temporarily no-ops, surfaced via
                // owner_filter_dropped). Any OTHER error falls through to the 500 below.
                if (rpcErr && ownerFilter && isMissingFunctionError(rpcErr)) {
                    log.warn({ err: rpcErr }, 'search_companies owner params rejected (missing function/signature); retrying owner-less (migration 118 pending)');
                    ({ data: rows, error: rpcErr } = await supabaseAdmin.rpc('search_companies', baseParams));
                    ownerFilterDropped = true;
                }
            }

            if (rpcErr) {
                log.error({ err: rpcErr }, 'search_companies RPC failed');
                throw new AppError('Failed to search companies', 500);
            }

            const list = (rows ?? []) as Array<Record<string, unknown> & { total_count: number }>;
            const total = list.length > 0 ? Number(list[0].total_count) : 0;
            let data = list.map(({ total_count: _ignore, ...rest }) => rest);
            const totalPages = Math.ceil(total / limit);

            // In-page archive filter is ONLY needed on the fallback path (the _archive RPC
            // already filtered server-side). Identify the archived rows on THIS page with a
            // lightweight id lookup and drop them (default) or keep only them (?archived=only).
            if (!usedArchiveRpc && data.length > 0) {
                const pageIds = data.map((r) => r.id as string);
                const { data: archRows, error: archErr } = await db
                    .from('companies')
                    .select('id')
                    .eq('tenant_id', tenantId)
                    .in('id', pageIds)
                    .not('archived_at', 'is', null);
                // Pre-137 DB: this fallback only runs because search_companies_archive was
                // missing — which means migration 137 hasn't landed, so archived_at doesn't
                // exist either. A missing-column error therefore means "archive feature off":
                // skip filtering (all rows stay, ?archived is a no-op) instead of 500ing. Any
                // OTHER error is a genuine fault and must surface.
                if (archErr && !isMissingColumnError(archErr, 'archived_at')) {
                    log.error({ err: archErr }, 'search_companies archive filter failed');
                    throw new AppError('Failed to search companies', 500);
                }
                if (!archErr) {
                    const archivedSet = new Set((archRows ?? []).map((r) => r.id as string));
                    data = archivedOnly
                        ? data.filter((r) => archivedSet.has(r.id as string))
                        : data.filter((r) => !archivedSet.has(r.id as string));
                }
            }

            // search_companies does NOT exclude merged-away sources, so drop any merged row
            // from THIS page with a lightweight id lookup (mirrors the archive worktree's
            // in-page post-filter). Page-scoped: `total` above (from the RPC) can slightly
            // OVER-count when merged rows matched — an accepted edge until search_companies
            // itself filters merged_into_id. NULL = a live record.
            if (data.length > 0) {
                const pageIds = data.map((r) => r.id as string);
                const { data: mergedRows, error: mErr } = await db
                    .from('companies')
                    .select('id')
                    .eq('tenant_id', tenantId)
                    .in('id', pageIds)
                    .not('merged_into_id', 'is', null);
                if (mErr) {
                    log.error({ err: mErr }, 'search_companies merged filter failed');
                    throw new AppError('Failed to search companies', 500);
                }
                const mergedSet = new Set((mergedRows ?? []).map((r) => r.id as string));
                data = data.filter((r) => !mergedSet.has(r.id as string));
            }

            // Enrich owners so the owner NAME shows and no raw UUID leaks. The owner
            // FILTER itself runs inside the RPC (migration 118); on a pre-118 DB the
            // retry above ran owner-less, so results stay owner-unfiltered until then.
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
                // Only present (true) when the owner filter had to be dropped for a pre-118
                // DB; the client shows a one-time notice and keeps the filter control usable.
                ...(ownerFilterDropped ? { owner_filter_dropped: true } : {}),
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
            .select('id, name, website, location, latitude, industry, employee_size, product_services, linkedin, company_phone, company_email, email_status, stage, company_summary, next_step, assigned_to, fit_score, lead_source, priority, qualification_status, fit_score_num, competitor_notes, objection_notes, custom_field_1, custom_field_2, custom_field_3, contact_count, created_at, updated_at, archived_at, archived_by')
            .eq('tenant_id', tenantId);

        // Archive filter: default hides archived rows; ?archived=only shows only them.
        if (archivedOnly) {
            countQuery = countQuery.not('archived_at', 'is', null);
            dataQuery = dataQuery.not('archived_at', 'is', null);
        } else {
            countQuery = countQuery.is('archived_at', null);
            dataQuery = dataQuery.is('archived_at', null);
        }
        // Hide merged-away sources (merged_into_id NOT NULL) from the default listing —
        // NULL = a live record. The detail route (GET /:id) still returns them 200.
        countQuery = countQuery.is('merged_into_id', null);
        dataQuery = dataQuery.is('merged_into_id', null);

        // (search handled via RPC in the ranked path above — no ILIKE here)

        // Qualification + tag filters (v2 Phase 6). Applied to BOTH count + data queries
        // so pagination stays correct. The tag filter pre-resolves matching company ids;
        // an empty match short-circuits to an empty page below.
        if (priorityFilter.length > 0) {
            countQuery = countQuery.in('priority', priorityFilter);
            dataQuery = dataQuery.in('priority', priorityFilter);
        }
        if (qualStatusFilter.length > 0) {
            countQuery = countQuery.in('qualification_status', qualStatusFilter);
            dataQuery = dataQuery.in('qualification_status', qualStatusFilter);
        }
        if (tags.length > 0) {
            const tagCompanyIds = await resolveTagCompanyIds(db, tenantId, tags);
            if (tagCompanyIds.length === 0) {
                res.json({
                    data: [],
                    pagination: { page, limit, total: 0, totalPages: 0, hasNext: false, hasPrev: page > 1 },
                });
                return;
            }
            countQuery = countQuery.in('id', tagCompanyIds);
            dataQuery = dataQuery.in('id', tagCompanyIds);
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

        // Tag filter (v2 Phase 6). Resolve matching company ids; an empty match uses a
        // never-matching sentinel so BOTH the pipeline + terminal queries return empty
        // (the rest of the handler tolerates zero rows). null = no tag filter applied.
        const tagFilter = (req.query.tags as string || '').split(',').filter(Boolean);
        if (tagFilter.some((t) => !UUID_RE.test(t))) {
            res.status(400).json({ error: 'Invalid tag filter' });
            return;
        }

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

        // Resolve the tag filter to a concrete id list (or a never-matching sentinel).
        let tagIdsForQuery: string[] | null = null;
        if (tagFilter.length > 0) {
            const matched = await resolveTagCompanyIds(db, tenantId, tagFilter);
            tagIdsForQuery = matched.length > 0 ? matched : ['00000000-0000-0000-0000-000000000000'];
        }

        let query = db
            .from('companies')
            .select('id, name, industry, stage, next_step, company_summary, updated_at, stage_changed_at, contact_count, assigned_to')
            .eq('tenant_id', tenantId)
            // The pipeline board never shows archived companies (no archive view here).
            .is('archived_at', null)
            .is('merged_into_id', null)
            .in('stage', pipelineStages);
        if (tagIdsForQuery) query = query.in('id', tagIdsForQuery);

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
        const activeRows = data ?? [];
        const activeIds = activeRows.map((c: any) => c.id);

        // Prefer the window/aggregate RPC (migration 119): one round-trip, no per-group
        // row cap. Called via supabaseAdmin because the RPC is service_role-only and takes
        // an explicit, server-resolved tenant, so the definer-rights read stays
        // tenant-scoped. On a pre-119 DB (or any RPC error) fall back to the chunked
        // queries, which are correct but per-chunk-capped.
        let nextTasks: PipelineSignals['nextTasks'] = {};
        let lastContacts: PipelineSignals['lastContacts'] = {};
        let signalsResolved = activeIds.length === 0; // nothing to enrich → nothing to fetch
        if (activeIds.length > 0) {
            const { data: sigRows, error: sigErr } = await supabaseAdmin.rpc('get_pipeline_signals', {
                p_tenant_id: tenantId,
                p_company_ids: activeIds,
            });
            if (sigErr) {
                // ONLY a missing-function error (pre-119 DB) justifies the chunk fallback.
                // A general DB/permission error must surface as a 500 so a real regression
                // isn't masked by silently degrading to the per-chunk-capped path.
                if (isMissingFunctionError(sigErr)) {
                    log.warn({ err: sigErr }, 'get_pipeline_signals RPC yok, chunk fallback (migration 119 pending)');
                } else {
                    log.error({ err: sigErr }, 'get_pipeline_signals RPC failed');
                    throw new AppError('Failed to fetch pipeline signals', 500);
                }
            } else {
                for (const r of (sigRows ?? []) as Array<any>) {
                    if (r.next_task_id) {
                        nextTasks[r.company_id] = {
                            id: r.next_task_id,
                            title: r.next_task_title,
                            due_at: r.next_task_due_at,
                            is_overdue: new Date(r.next_task_due_at).getTime() < Date.now(),
                        };
                    }
                    if (r.last_contact_at) lastContacts[r.company_id] = r.last_contact_at;
                }
                signalsResolved = true;
            }
        }
        if (!signalsResolved) {
            ({ nextTasks, lastContacts } = await computePipelineSignalsFallback(db, tenantId, activeIds));
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
            .is('archived_at', null)
            .is('merged_into_id', null)
            .in('stage', terminalStages)
            .order('updated_at', { ascending: false });
        if (tagIdsForQuery) terminalQuery = terminalQuery.in('id', tagIdsForQuery);

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

        // Fetch contacts for this company (archived contacts are hidden from the card list;
        // they can be restored from the People archive view).
        const { data: contacts } = await db
            .from('contacts')
            .select('*')
            .eq('company_id', id)
            .eq('tenant_id', tenantId)
            .is('archived_at', null)
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

// GET /api/companies/:id/duplicates — Possible duplicate companies (same tenant).
// Normalised (name legal-suffix strip / website domain / phone digits) matching via
// the find_duplicate_companies RPC. Read-only, capped at 5. Already-merged sources
// (internal_notes marker) are excluded by the RPC.
router.get('/:id/duplicates', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const id = String(req.params.id);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            throw new AppError('Invalid company id', 400);
        }

        // Confirm the company is in this tenant (clean 404, no cross-tenant leak).
        const { data: company, error: cErr } = await supabaseAdmin
            .from('companies')
            .select('id')
            .eq('id', id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (cErr) throw new AppError('Failed to load company', 500);
        if (!company) throw new AppError('Company not found', 404);

        const { data, error } = await supabaseAdmin.rpc('find_duplicate_companies', {
            p_tenant_id: tenantId,
            p_company_id: id,
        });
        if (error) {
            // RPC not deployed yet (pre-136): behave as "no duplicates", never 500.
            if (isMissingFunctionError(error)) { res.json({ data: [] }); return; }
            log.error({ err: error }, 'find_duplicate_companies failed');
            throw new AppError('Failed to find duplicates', 500);
        }
        res.json({ data: data || [] });
    } catch (err) {
        next(err);
    }
});

// POST /api/companies/merge — Merge a source company into a target company.
// Atomic (single merge_companies RPC / one transaction): children repoint, field
// winners apply to the target, the source is disabled WITHOUT data loss, and a
// crm_merge_log row is written. Destructive-ish → gated to the write roles.
router.post(
    '/merge',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(mergeCompaniesSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { source_id, target_id, field_winners } = req.body;

            // Both must live in this tenant before the destructive call (clean 404).
            const { data: rows, error: chkErr } = await supabaseAdmin
                .from('companies')
                .select('id')
                .eq('tenant_id', tenantId)
                .in('id', [source_id, target_id]);
            if (chkErr) throw new AppError('Failed to validate companies', 500);
            const found = new Set((rows || []).map((r) => r.id));
            if (!found.has(source_id) || !found.has(target_id)) throw new AppError('Company not found', 404);

            const { data, error } = await supabaseAdmin.rpc('merge_companies', {
                p_tenant_id: tenantId,
                p_source_id: source_id,
                p_target_id: target_id,
                p_field_winners: field_winners || {},
                p_performed_by: req.user!.id,
            });
            if (error) {
                if (error.message?.includes('already_merged')) throw new AppError('One of the records was already merged', 409);
                if (error.message?.includes('must differ')) throw new AppError('source and target must differ', 400);
                if (error.message?.includes('not found')) throw new AppError('Company not found', 404);
                log.error({ err: error }, 'merge_companies failed');
                throw new AppError('Failed to merge companies', 500);
            }

            // Counts/pipeline shifted — drop the memoised aggregates for this tenant.
            invalidateOverviewCache(tenantId);
            invalidatePipelineStatsCache(tenantId);
            res.json({ data });
        } catch (err) {
            next(err);
        }
    }
);

// GET /api/companies/:id/timeline — Unified chronological history for one company.
// Batches a FIXED set of queries (no N+1): activities (RLS-scoped) + email replies
// (admin-scoped, gated by role) + contact names + actor display names. Every source is
// mapped to a common event contract so the client can render a single stream. Email is
// omitted for roles that cannot read it (client_viewer), mirroring /email-replies gating.
router.get('/:id/timeline', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const companyId = String(req.params.id);

        if (!/^[0-9a-f-]{36}$/i.test(companyId)) {
            res.status(400).json({ error: 'Invalid company ID' });
            return;
        }

        const ROW_CAP = 250;
        const canReadEmail = ['superadmin', 'ops_agent', 'client_admin'].includes(req.user!.role);

        // Activities go through the RLS-aware client so client roles stay tenant-isolated.
        const db = dbClient(req);
        const [activitiesRes, emailsRes] = await Promise.all([
            db
                .from('activities')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('company_id', companyId)
                .order('occurred_at', { ascending: false })
                .limit(ROW_CAP),
            canReadEmail
                ? supabaseAdmin
                    .from('email_replies')
                    .select('id, sender_email, subject, reply_body, replied_at, read_status, direction, campaign_id, campaign_name, contact_id, category')
                    .eq('tenant_id', tenantId)
                    .eq('company_id', companyId)
                    // Skip unsent drafts with IS DISTINCT FROM 'draft' semantics: keep rows
                    // with no raw_payload AND rows whose raw_payload lacks a `source` key
                    // (real inbound emails), dropping only rows explicitly sourced as 'draft'.
                    // A bare `source.neq.draft` also swallows null-source rows because
                    // NULL != 'draft' is NULL, not true.
                    .or('raw_payload.is.null,raw_payload->>source.is.null,raw_payload->>source.neq.draft')
                    .order('replied_at', { ascending: false })
                    .limit(ROW_CAP)
                : Promise.resolve({ data: [], error: null }),
        ]);

        if (activitiesRes.error) {
            log.error({ err: activitiesRes.error }, 'Timeline activities error');
            throw new AppError('Failed to fetch timeline', 500);
        }
        if (emailsRes.error) {
            log.error({ err: emailsRes.error }, 'Timeline emails error');
            throw new AppError('Failed to fetch timeline', 500);
        }

        const activities = (activitiesRes.data || []) as any[];
        const emails = (emailsRes.data || []) as any[];

        // Resolve contact names (both sources) and actor display names (activities) in
        // one round-trip each — no per-row lookups.
        const contactIds = [...new Set(
            [...activities, ...emails].map((r: any) => r.contact_id).filter(Boolean)
        )];
        const contactMap: Record<string, string> = {};
        if (contactIds.length > 0) {
            const { data: contacts } = await db
                .from('contacts')
                .select('id, first_name, last_name')
                .eq('tenant_id', tenantId)
                .in('id', contactIds);
            for (const c of contacts || []) {
                contactMap[c.id] = [c.first_name, c.last_name].filter(Boolean).join(' ');
            }
        }

        const actorIds = activities.map((a: any) => a.created_by).filter(Boolean);
        const userMap = await resolveUsers(actorIds);

        const events = [
            ...activities.map((a: any) => ({
                id: `activity:${a.id}`,
                ref_id: a.id,
                source: 'activity' as const,
                kind: a.type as string,
                direction: null as null,
                occurred_at: a.occurred_at,
                actor: ownerDisplayName(userMap.get(a.created_by)),
                actor_id: a.created_by || null,
                summary: a.summary ?? null,
                detail: a.detail ?? null,
                contact_name: a.contact_id ? (contactMap[a.contact_id] || null) : null,
                outcome: a.outcome ?? null,
                visibility: a.visibility ?? null,
                campaign_name: null as string | null,
                category: null as string | null,
                read_status: null as string | null,
                subject: null as string | null,
                sender_email: null as string | null,
                is_system: a.type === 'status_change',
                // Full row so the client edit form can prefill without a second fetch.
                activity: { ...a, contact_name: a.contact_id ? (contactMap[a.contact_id] || null) : null },
            })),
            ...emails.map((r: any) => ({
                id: `email:${r.id}`,
                ref_id: r.id,
                source: 'email' as const,
                kind: 'email' as const,
                direction: (r.direction === 'OUT' ? 'OUT' : 'IN') as 'IN' | 'OUT',
                occurred_at: r.replied_at,
                actor: null as string | null,
                actor_id: null as string | null,
                summary: r.subject ?? null,
                detail: r.reply_body ?? null,
                contact_name: r.contact_id ? (contactMap[r.contact_id] || null) : null,
                outcome: null as string | null,
                visibility: null as string | null,
                campaign_name: r.campaign_name ?? null,
                category: r.category ?? null,
                read_status: r.read_status ?? null,
                subject: r.subject ?? null,
                sender_email: r.sender_email ?? null,
                is_system: false,
            })),
        ]
            .filter((e) => e.occurred_at)
            .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())
            .slice(0, ROW_CAP);

        res.json({ events });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Timeline error');
        res.status(500).json({ error: 'Failed to fetch timeline' });
    }
});

// POST /api/companies — Create new company
router.post(
    '/',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(createCompanyQualifiedSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const {
                name, website, location, industry, employee_size, product_services, linkedin, company_phone,
                company_email: rawCompanyEmail, email_status,
                stage, company_summary, internal_notes, next_step, custom_fields,
                fit_score, custom_field_1, custom_field_2, custom_field_3, assigned_to,
                lead_source, priority, qualification_status, fit_score_num, competitor_notes, objection_notes,
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
                // A company cannot be BORN into a terminal stage: closing a lead requires a
                // closing report (sonlandirma_raporu), which the create path has no way to
                // capture. Reuse the stage-transition guard's code/message so the client
                // branches identically (create in a pipeline stage, THEN move to terminal
                // with a report).
                const terminalSlugs = await getTerminalStageSlugs(tenantId);
                if (terminalSlugs.includes(stage)) {
                    throw new AppError(
                        'A closing report is required to move a company to this stage.',
                        422,
                        'closing_report_required',
                    );
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
                lead_source: lead_source || null,
                priority: priority || null,
                qualification_status: qualification_status || null,
                fit_score_num: fit_score_num ?? null,
                competitor_notes: competitor_notes || null,
                objection_notes: objection_notes || null,
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
    validateBody(updateCompanyQualifiedSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            // Verify company belongs to tenant (also fetch fields needed for auto-geocoding + owner change)
            const { data: existing } = await supabaseAdmin
                .from('companies')
                .select('id, stage, location, latitude, assigned_to')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (!existing) {
                res.status(404).json({ error: 'Company not found' });
                return;
            }

            const { name, website, location, industry, employee_size, product_services, linkedin, company_phone, company_email: rawCompanyEmail, email_status, stage, company_summary, internal_notes, next_step, custom_fields, fit_score, custom_field_1, custom_field_2, custom_field_3, assigned_to, reopen_reason, lead_source, priority, qualification_status, fit_score_num, competitor_notes, objection_notes } = req.body;

            const company_email = sanitizeEmail(rawCompanyEmail);

            // Stage change goes through the same contract as every other surface: a terminal
            // target is rejected here (the edit form opens the closing-report modal instead) and
            // reopening a closed company requires a reason. assertStageTransition throws a coded
            // 422/400; the actual write stays in the combined update below.
            const stageChanged = stage !== undefined && stage !== existing.stage;
            let stageGuard: ReturnType<typeof assertStageTransition> | null = null;
            if (stage !== undefined) {
                const stages = await getTenantStages(tenantId);
                if (stageChanged) {
                    stageGuard = assertStageTransition({
                        stages,
                        currentSlug: existing.stage,
                        targetSlug: stage,
                        hasClosingReport: false,
                        reopenReason: reopen_reason,
                    });
                } else if (!stages.some((s) => s.slug === stage)) {
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
            if (linkedin !== undefined) updateData.linkedin = linkedin;
            if (company_phone !== undefined) updateData.company_phone = company_phone;
            if (company_email !== undefined) updateData.company_email = company_email;
            if (email_status !== undefined) updateData.email_status = email_status;
            // Only write stage when it actually changes — a same-value write would bypass the
            // CAS below (clobbering a concurrent close/reopen) and wrongly reset stage_changed_at.
            if (stageChanged) {
                updateData.stage = stage;
                updateData.stage_changed_at = new Date().toISOString();
            }
            if (company_summary !== undefined) updateData.company_summary = company_summary;
            if (internal_notes !== undefined && isInternalRole(req.user!.role)) updateData.internal_notes = internal_notes;
            if (fit_score !== undefined) updateData.fit_score = fit_score;
            if (lead_source !== undefined) updateData.lead_source = lead_source;
            if (priority !== undefined) updateData.priority = priority;
            if (qualification_status !== undefined) updateData.qualification_status = qualification_status;
            if (fit_score_num !== undefined) updateData.fit_score_num = fit_score_num;
            if (competitor_notes !== undefined) updateData.competitor_notes = competitor_notes;
            if (objection_notes !== undefined) updateData.objection_notes = objection_notes;
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

            // Compare-and-swap when this PUT changes the stage: gate the write on the stage
            // we validated against (existing.stage) so a stale multi-field update can't clobber
            // a concurrent terminal close/reopen. Non-stage PUTs are NOT gated — unrelated field
            // updates must not fail on a stage race.
            let updateQuery = supabaseAdmin
                .from('companies')
                .update(updateData)
                .eq('id', id)
                .eq('tenant_id', tenantId);
            if (stageChanged) {
                updateQuery = existing.stage === null
                    ? updateQuery.is('stage', null)
                    : updateQuery.eq('stage', existing.stage);
            }
            const { data, error } = await updateQuery.select().maybeSingle();

            if (error) {
                log.error({ err: error }, 'Update company error');
                throw new AppError('Failed to update company', 500);
            }
            if (!data) {
                // 0 rows. For a stage-changing PUT this is a CAS miss (disambiguate 404 vs 409);
                // otherwise the row vanished under us — preserve the prior 500 behavior.
                if (stageChanged) {
                    const { data: fresh, error: freshErr } = await supabaseAdmin
                        .from('companies')
                        .select('stage')
                        .eq('id', id)
                        .eq('tenant_id', tenantId)
                        .maybeSingle();
                    if (freshErr) throw new AppError('Failed to update company', 500);
                    if (!fresh) throw new AppError('Company not found', 404);
                    throw new AppError('The stage changed while you were editing. Please try again.', 409, 'stage_conflict');
                }
                log.error('Update company returned no row');
                throw new AppError('Failed to update company', 500);
            }

            // Stage changed via edit form — keep statistics cache consistent + drop a timeline line.
            // Terminal targets never reach here (assertStageTransition throws above), so this is
            // always a normal move or a reopen (with the reason captured on the guard).
            if (stageChanged) {
                invalidateOverviewCache(tenantId);
                invalidatePipelineStatsCache(tenantId);
                await recordStageChangeActivity({
                    tenantId,
                    actorId: req.user!.id,
                    companyId: id as string,
                    oldSlug: existing.stage,
                    newSlug: stage,
                    reopenReason: stageGuard?.isReopen ? reopen_reason : null,
                    stages: await getTenantStages(tenantId),
                });
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

            // Reopening a closed company requires a reason (see stageTransition), which bulk cannot
            // collect — reject the whole batch if any selected company is currently terminal so a
            // reopen never slips through silently. (Undo re-targets prior non-terminal stages, so it
            // is unaffected.)
            if (terminalSlugs.length > 0) {
                const { data: currentRows, error: readErr } = await supabaseAdmin
                    .from('companies')
                    .select('id, stage')
                    .in('id', ids)
                    .eq('tenant_id', tenantId);
                if (readErr) throw new AppError('Failed to load companies', 500);
                if ((currentRows || []).some((r) => terminalSlugs.includes(r.stage as string))) {
                    res.status(422).json({ error: 'Closed companies cannot be reopened in bulk. Reopen each one individually with a reason.', code: 'reopen_reason_required' });
                    return;
                }
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

// Postgres codes for "relation/column does not exist" — used to turn a missing-migration
// error into a per-company schema_missing result instead of a whole-request 500.
const isSchemaMissing = (code?: string): boolean => code === '42P01' || code === '42703';

// POST /api/companies/bulk-update — Bulk field edit + tag add/remove (v2 Phase 8, E10).
// Edits qualification fields (priority, lead_source, qualification_status — migration 139
// columns) and/or links/unlinks tenant tags on a selection. Not atomic by design: returns
// a per-company result so one bad row (a company outside the tenant) never aborts the batch.
// The tag list is validated against the tenant up front — a foreign tag_id rejects the whole
// request (it would fail identically for every company). Writes company_tags DIRECTLY (the
// same tenant-fenced insert tags.ts uses) so this route never depends on the tags route.
router.post(
    '/bulk-update',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(bulkUpdateCompaniesSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { company_ids, priority, lead_source, qualification_status, tags_add, tags_remove } =
                req.body as {
                    company_ids: string[];
                    priority?: string;
                    lead_source?: string | null;
                    qualification_status?: string;
                    tags_add?: string[];
                    tags_remove?: string[];
                };

            // De-dupe ids (a client could send the same company twice); preserves order.
            const ids = Array.from(new Set(company_ids));

            // Validate every referenced tag belongs to this tenant. A foreign tag is a
            // whole-request error (422) — it can't apply to any company. The DB fence
            // (company_tags_tenant_consistency, migration 139) is the second layer.
            // If the tags/company_tags schema is missing (migration 139 not yet applied),
            // don't 500 — leave `schemaMissing` set so each tag op fails per-company below
            // with a stable reason_code instead of aborting the whole batch.
            const tagIds = Array.from(new Set([...(tags_add || []), ...(tags_remove || [])]));
            let schemaMissing = false;
            if (tagIds.length > 0) {
                const { data: tenantTags, error: tagErr } = await supabaseAdmin
                    .from('tags')
                    .select('id')
                    .eq('tenant_id', tenantId)
                    .in('id', tagIds);
                if (tagErr) {
                    if (isSchemaMissing((tagErr as { code?: string }).code)) {
                        schemaMissing = true;
                    } else {
                        throw new AppError('Failed to validate tags', 500);
                    }
                } else {
                    const validTagIds = new Set((tenantTags || []).map((r) => r.id as string));
                    if (tagIds.some((id) => !validTagIds.has(id))) {
                        res.status(422).json({ error: 'One or more selected tags do not belong to this workspace', code: 'foreign_tag' });
                        return;
                    }
                }
            }

            // Which of the requested companies actually live in this tenant. Anything
            // missing is reported per-company as not_found rather than silently dropped.
            const { data: rows, error: rowsErr } = await supabaseAdmin
                .from('companies')
                .select('id')
                .in('id', ids)
                .eq('tenant_id', tenantId);
            if (rowsErr) throw new AppError('Failed to load companies', 500);
            const validIds = new Set((rows || []).map((r) => r.id as string));

            // Per-company result accumulator. not_found rows are settled immediately.
            // reason carries a stable code (not_found | schema_missing | db_error) that the
            // client maps to a localized message — server messages never reach the UI raw.
            const results: Array<{ id: string; ok: boolean; reason?: string }> = [];
            for (const id of ids) {
                if (!validIds.has(id)) results.push({ id, ok: false, reason: 'not_found' });
            }
            const targets = ids.filter((id) => validIds.has(id));

            // Field patch (only the provided keys). priority/qualification_status are set;
            // lead_source may be cleared (null).
            const patch: Record<string, unknown> = {};
            if (priority !== undefined) patch.priority = priority;
            if (lead_source !== undefined) patch.lead_source = lead_source;
            if (qualification_status !== undefined) patch.qualification_status = qualification_status;
            const hasFieldPatch = Object.keys(patch).length > 0;

            // Per-company ATOMICITY: one crm_bulk_update_company RPC call per company —
            // its tag ops + field patch commit/roll back together (migration 142), so a
            // company can never end half-applied while reporting ok:false. There is NO
            // sequential fallback: without the RPC (pre-142 DB) every company fails
            // honestly with schema_missing instead of risking a half-applied row.
            // 200 companies × 1 RPC is acceptable (selection capped upstream).
            for (const id of targets) {
                if (schemaMissing) { results.push({ id, ok: false, reason: 'schema_missing' }); continue; }
                try {
                    const { error: rpcErr } = await supabaseAdmin.rpc('crm_bulk_update_company', {
                        p_tenant_id: tenantId,
                        p_company_id: id,
                        p_user_id: req.user!.id,
                        p_fields: patch,
                        p_tags_add: tags_add && tags_add.length > 0 ? tags_add : null,
                        p_tags_remove: tags_remove && tags_remove.length > 0 ? tags_remove : null,
                    });
                    if (rpcErr) {
                        const rc = (rpcErr as { code?: string }).code;
                        const msg = (rpcErr as { message?: string }).message || '';
                        if (rc === 'PGRST202' || rc === '42883') {
                            results.push({ id, ok: false, reason: 'schema_missing' });
                        } else if (msg.includes('not_found')) {
                            results.push({ id, ok: false, reason: 'not_found' });
                        } else if (msg.includes('foreign_tag')) {
                            results.push({ id, ok: false, reason: 'foreign_tag' });
                        } else {
                            throw rpcErr;
                        }
                    } else {
                        results.push({ id, ok: true });
                    }
                } catch (rowErr) {
                    const code = (rowErr as { code?: string })?.code;
                    results.push({ id, ok: false, reason: isSchemaMissing(code) ? 'schema_missing' : 'db_error' });
                }
            }

            const updated = results.filter((r) => r.ok).length;
            invalidateOverviewCache(tenantId);
            invalidatePipelineStatsCache(tenantId);
            posthog.capture({
                distinctId: req.user!.id,
                event: 'company_bulk_updated',
                properties: {
                    count: updated,
                    fields: Object.keys(patch).filter((k) => k !== 'updated_at'),
                    tags_added: tags_add?.length || 0,
                    tags_removed: tags_remove?.length || 0,
                    tenant_id: tenantId,
                },
            });
            res.json({ updated, results });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Bulk company update error');
            res.status(500).json({ error: 'Failed to bulk update companies' });
        }
    }
);

// PATCH /api/companies/:id/stage — Lightweight stage update (drag-drop / stage menu).
// Routes through the single stageTransition service: terminal targets are rejected here
// (the client opens the closing-report modal instead) and reopening a closed company
// requires reopen_reason. Normal/reopen moves also drop a status_change timeline line.
router.patch(
    '/:id/stage',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(stagePatchSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;
            const { stage, reopen_reason } = req.body as { stage: string; reopen_reason?: string | null };

            const result = await transitionCompanyStage({
                tenantId,
                userId: req.user!.id,
                companyId: id as string,
                targetStage: stage,
                reopenReason: reopen_reason,
            });

            // Terminal targets never reach here (they 422 without a closing report), so
            // the result is always a normal/reopen move.
            const data = result.kind === 'moved' ? result.company : null;
            posthog.capture({
                distinctId: req.user!.id,
                event: 'company_stage_changed',
                properties: {
                    company_id: (data as Record<string, unknown> | null)?.id,
                    new_stage: stage,
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

// POST /api/companies/:id/archive — Soft-archive a company (reversible; hides it from the
// default list / pipeline / search). This is the UI default instead of delete; the
// permanent DELETE below stays as a superadmin-only edge path.
router.post(
    '/:id/archive',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            const { data, error } = await supabaseAdmin
                .from('companies')
                .update({ archived_at: new Date().toISOString(), archived_by: req.user!.id })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select()
                .maybeSingle();

            if (error) throw new AppError('Failed to archive company', 500);
            if (!data) {
                res.status(404).json({ error: 'Company not found' });
                return;
            }

            // Archived rows drop out of pipeline + overview totals — refresh the caches.
            invalidateOverviewCache(tenantId);
            invalidatePipelineStatsCache(tenantId);
            posthog.capture({
                distinctId: req.user!.id,
                event: 'company_archived',
                properties: { company_id: id, tenant_id: tenantId },
            });
            res.json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Archive company error');
            res.status(500).json({ error: 'Failed to archive company' });
        }
    }
);

// POST /api/companies/:id/unarchive — Restore an archived company (one-tap undo).
router.post(
    '/:id/unarchive',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const { id } = req.params;

            const { data, error } = await supabaseAdmin
                .from('companies')
                .update({ archived_at: null, archived_by: null })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select()
                .maybeSingle();

            if (error) throw new AppError('Failed to restore company', 500);
            if (!data) {
                res.status(404).json({ error: 'Company not found' });
                return;
            }

            invalidateOverviewCache(tenantId);
            invalidatePipelineStatsCache(tenantId);
            posthog.capture({
                distinctId: req.user!.id,
                event: 'company_unarchived',
                properties: { company_id: id, tenant_id: tenantId },
            });
            res.json({ data });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Unarchive company error');
            res.status(500).json({ error: 'Failed to restore company' });
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
