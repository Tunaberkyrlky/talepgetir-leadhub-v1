import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { resolveUsers } from '../lib/userResolver.js';
import {
    validateBody,
    dealCreateQualifiedSchema,
    dealUpdateQualifiedSchema,
    dealCloseQualifiedSchema,
    dealReopenSchema,
    dealContactSchema,
    DEAL_STATUSES,
} from '../lib/validation.js';

const router = Router();
const log = createLogger('route:deals');
const writeRoles = requireRole('superadmin', 'ops_agent', 'client_admin');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Deal-list SELECT projection (company + primary contact for display).
const DEAL_SELECT = '*, companies(name), contacts(first_name, last_name)';

interface DealRelations {
    companies?: { name?: string } | null;
    contacts?: { first_name?: string; last_name?: string | null } | null;
    owner?: string | null;
    [key: string]: unknown;
}

async function mapDealRelations(rows: DealRelations[]) {
    const users = await resolveUsers(rows.map((row) => row.owner || '').filter(Boolean));
    return rows.map((row) => {
        const companyName = row.companies?.name || null;
        const contactName = row.contacts
            ? [row.contacts.first_name, row.contacts.last_name].filter(Boolean).join(' ') || null
            : null;
        const ownerUser = row.owner ? users.get(row.owner) || null : null;
        const { companies: _companies, contacts: _contacts, ...deal } = row;
        return {
            ...deal,
            company_name: companyName,
            contact_name: contactName,
            owner_user: ownerUser,
        };
    });
}

// The staging `deals.stage` column is NOT NULL with a composite FK to
// pipeline_stages(tenant_id, slug), so every write must carry a valid slug. The
// API contract speaks stage_id (uuid) — this resolves it to the slug within the
// tenant, and the route persists BOTH stage_id + stage.
async function resolveStageSlug(tenantId: string, stageId: string): Promise<string> {
    const { data, error } = await supabaseAdmin
        .from('pipeline_stages')
        .select('slug')
        .eq('id', stageId)
        .eq('tenant_id', tenantId)
        .maybeSingle();

    if (error) throw new AppError('Failed to validate pipeline stage', 500);
    if (!data) throw new AppError('Pipeline stage not found in this workspace', 422);
    return data.slug as string;
}

async function assertCompanyAndContact(tenantId: string, companyId: string, contactId?: string | null) {
    const { data: company, error: companyError } = await supabaseAdmin
        .from('companies')
        .select('id')
        .eq('id', companyId)
        .eq('tenant_id', tenantId)
        .maybeSingle();

    if (companyError) throw new AppError('Failed to validate company', 500);
    if (!company) throw new AppError('Company not found', 404);

    if (!contactId) return;

    const { data: contact, error: contactError } = await supabaseAdmin
        .from('contacts')
        .select('id')
        .eq('id', contactId)
        .eq('company_id', companyId)
        .eq('tenant_id', tenantId)
        .maybeSingle();

    if (contactError) throw new AppError('Failed to validate contact', 500);
    if (!contact) throw new AppError('Contact does not belong to the selected company', 422);
}

async function assertAssignableUser(tenantId: string, userId: string | null | undefined, currentUserId: string) {
    if (!userId || userId === currentUserId) return;

    const { data, error } = await supabaseAdmin
        .from('memberships')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('user_id', userId)
        .eq('is_active', true)
        .maybeSingle();

    if (error) throw new AppError('Failed to validate deal owner', 500);
    if (!data) throw new AppError('Deal owner is not an active member of this workspace', 422);
}

// The deals stage-consistency fence (migration 133) RAISEs (Postgres code P0001)
// when a write's stage_id and stage slug name different pipeline_stages rows —
// only reachable by losing a race against a concurrent slug rename between the
// route's slug resolution and the write. Map that to a machine-coded 409 so
// clients can retry, instead of a misleading 500. Returns null for any other
// error so the caller falls back to its own generic failure.
function mapDealStageWriteError(error: { code?: string; message?: string } | null | undefined): AppError | null {
    if (error && error.code === 'P0001' && /stage/i.test(error.message || '')) {
        return new AppError('Pipeline stage changed during save, please retry', 409, 'deal_stage_conflict');
    }
    return null;
}

router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
        const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '20'), 10) || 20));
        const offset = (page - 1) * limit;

        let query = supabaseAdmin
            .from('deals')
            .select(DEAL_SELECT, { count: 'exact' })
            .eq('tenant_id', tenantId);

        const status = typeof req.query.status === 'string' ? req.query.status : '';
        const stageId = typeof req.query.stage_id === 'string' ? req.query.stage_id : '';
        const owner = typeof req.query.owner === 'string' ? req.query.owner : '';
        const companyId = typeof req.query.company_id === 'string' ? req.query.company_id : '';
        const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 200) : '';

        if (status) {
            if (!DEAL_STATUSES.includes(status as typeof DEAL_STATUSES[number])) throw new AppError('Invalid deal status', 400);
            query = query.eq('status', status);
        }
        if (stageId) {
            if (!UUID_RE.test(stageId)) throw new AppError('Invalid stage_id', 400);
            query = query.eq('stage_id', stageId);
        }
        if (owner === 'me') query = query.eq('owner', req.user!.id);
        else if (owner === 'unassigned') query = query.is('owner', null);
        else if (owner) {
            if (!UUID_RE.test(owner)) throw new AppError('Invalid owner', 400);
            query = query.eq('owner', owner);
        }
        if (companyId) {
            if (!UUID_RE.test(companyId)) throw new AppError('Invalid company_id', 400);
            query = query.eq('company_id', companyId);
        }
        if (search) {
            // Escape LIKE wildcards so the term is matched literally.
            const escaped = search.replace(/[\\%_]/g, (m) => `\\${m}`);
            query = query.ilike('title', `%${escaped}%`);
        }

        const { data, count, error } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            log.error({ err: error }, 'List deals failed');
            throw new AppError('Failed to fetch deals', 500);
        }

        const mapped = await mapDealRelations((data || []) as DealRelations[]);
        const total = count || 0;
        res.json({
            data: mapped,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasNext: offset + mapped.length < total,
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        next(err);
    }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid deal id', 400);
        const tenantId = req.tenantId!;

        const { data, error } = await supabaseAdmin
            .from('deals')
            .select(DEAL_SELECT)
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();

        if (error) throw new AppError('Failed to fetch deal', 500);
        if (!data) throw new AppError('Deal not found', 404);

        const [mapped] = await mapDealRelations([data as DealRelations]);

        // Related contacts (roles) with display info.
        const { data: dcRows, error: dcError } = await supabaseAdmin
            .from('deal_contacts')
            .select('id, contact_id, role, created_at, contacts(first_name, last_name, email, title)')
            .eq('tenant_id', tenantId)
            .eq('deal_id', req.params.id)
            .order('created_at', { ascending: true });

        if (dcError) throw new AppError('Failed to fetch deal contacts', 500);

        const contacts = (dcRows || []).map((row) => {
            const c = row.contacts as { first_name?: string; last_name?: string | null; email?: string | null; title?: string | null } | null;
            const name = c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || null : null;
            return {
                id: row.id,
                contact_id: row.contact_id,
                role: row.role,
                created_at: row.created_at,
                contact_name: name,
                contact_email: c?.email || null,
                contact_title: c?.title || null,
            };
        });

        // Open (pending) task count for this deal.
        const { count: openTaskCount, error: taskError } = await supabaseAdmin
            .from('tasks')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .eq('deal_id', req.params.id)
            .eq('status', 'pending');

        if (taskError) throw new AppError('Failed to count deal tasks', 500);

        res.json({ data: { ...mapped, contacts, open_task_count: openTaskCount || 0 } });
    } catch (err) {
        next(err);
    }
});

router.post('/', writeRoles, validateBody(dealCreateQualifiedSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        // Owner (A2) contract: field omitted -> creator, explicit null -> unassigned queue.
        const owner = req.body.owner === undefined ? req.user!.id : req.body.owner;

        await assertCompanyAndContact(tenantId, req.body.company_id, req.body.contact_id);
        await assertAssignableUser(tenantId, owner, req.user!.id);
        const stageSlug = await resolveStageSlug(tenantId, req.body.stage_id);

        const { data, error } = await supabaseAdmin
            .from('deals')
            .insert({
                tenant_id: tenantId,
                company_id: req.body.company_id,
                contact_id: req.body.contact_id || null,
                title: req.body.title,
                description: req.body.description || null,
                amount: req.body.amount ?? null,
                currency: req.body.currency,
                stage_id: req.body.stage_id,
                stage: stageSlug,
                expected_close: req.body.expected_close || null,
                lead_source: req.body.lead_source || null,
                priority: req.body.priority || null,
                owner,
                created_by: req.user!.id,
            })
            .select(DEAL_SELECT)
            .single();

        if (error) {
            const mapped = mapDealStageWriteError(error);
            if (mapped) throw mapped;
            log.error({ err: error }, 'Create deal failed');
            throw new AppError('Failed to create deal', 500);
        }

        const [mapped] = await mapDealRelations([data as DealRelations]);
        res.status(201).json({ data: mapped });
    } catch (err) {
        next(err);
    }
});

router.put('/:id', writeRoles, validateBody(dealUpdateQualifiedSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid deal id', 400);
        const tenantId = req.tenantId!;

        const { data: existing, error: existingError } = await supabaseAdmin
            .from('deals')
            .select('id, company_id')
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();

        if (existingError) throw new AppError('Failed to fetch deal', 500);
        if (!existing) throw new AppError('Deal not found', 404);

        // Build the patch from provided fields only. status is NOT editable here.
        const updates: Record<string, unknown> = {};
        if (req.body.contact_id !== undefined) {
            await assertCompanyAndContact(tenantId, existing.company_id, req.body.contact_id);
            updates.contact_id = req.body.contact_id;
        }
        if (req.body.stage_id !== undefined) {
            updates.stage = await resolveStageSlug(tenantId, req.body.stage_id);
            updates.stage_id = req.body.stage_id;
        }
        if (req.body.owner !== undefined) {
            await assertAssignableUser(tenantId, req.body.owner, req.user!.id);
            updates.owner = req.body.owner;
        }
        if (req.body.title !== undefined) updates.title = req.body.title;
        if (req.body.description !== undefined) updates.description = req.body.description;
        if (req.body.amount !== undefined) updates.amount = req.body.amount;
        if (req.body.currency !== undefined) updates.currency = req.body.currency;
        if (req.body.expected_close !== undefined) updates.expected_close = req.body.expected_close;
        if (req.body.lead_source !== undefined) updates.lead_source = req.body.lead_source;
        if (req.body.priority !== undefined) updates.priority = req.body.priority;

        if (Object.keys(updates).length === 0) throw new AppError('At least one field must be provided', 400);

        const { data, error } = await supabaseAdmin
            .from('deals')
            .update(updates)
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .select(DEAL_SELECT)
            .maybeSingle();

        if (error) {
            const mapped = mapDealStageWriteError(error);
            if (mapped) throw mapped;
            log.error({ err: error }, 'Update deal failed');
            throw new AppError('Failed to update deal', 500);
        }
        if (!data) throw new AppError('Deal not found', 404);

        const [mapped] = await mapDealRelations([data as DealRelations]);
        res.json({ data: mapped });
    } catch (err) {
        next(err);
    }
});

router.post('/:id/close', writeRoles, validateBody(dealCloseQualifiedSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid deal id', 400);
        const tenantId = req.tenantId!;

        const { data: existing, error: existingError } = await supabaseAdmin
            .from('deals')
            .select('status')
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();

        if (existingError) throw new AppError('Failed to fetch deal', 500);
        if (!existing) throw new AppError('Deal not found', 404);
        if (existing.status !== 'open') throw new AppError('Only open deals can be closed', 409);

        const isLost = req.body.status === 'lost';
        const { data, error } = await supabaseAdmin
            .from('deals')
            .update({
                status: req.body.status,
                closed_at: new Date().toISOString(),
                // Free-text reason + standardized code both persist when lost; cleared on won.
                loss_reason: isLost ? (req.body.loss_reason?.trim() || null) : null,
                loss_reason_code: isLost ? (req.body.loss_reason_code || null) : null,
            })
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .eq('status', 'open')
            .select(DEAL_SELECT)
            .maybeSingle();

        if (error) {
            log.error({ err: error }, 'Close deal failed');
            throw new AppError('Failed to close deal', 500);
        }
        // Race: status changed between the pre-SELECT and the conditional UPDATE.
        if (!data) {
            const { data: recheck, error: recheckError } = await supabaseAdmin
                .from('deals')
                .select('status')
                .eq('id', req.params.id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (recheckError) throw new AppError('Failed to close deal', 500);
            if (!recheck) throw new AppError('Deal not found', 404);
            throw new AppError('Only open deals can be closed', 409);
        }

        const [mapped] = await mapDealRelations([data as DealRelations]);
        res.json({ data: mapped });
    } catch (err) {
        next(err);
    }
});

router.post('/:id/reopen', writeRoles, validateBody(dealReopenSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid deal id', 400);
        const tenantId = req.tenantId!;

        const { data: existing, error: existingError } = await supabaseAdmin
            .from('deals')
            .select('status')
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();

        if (existingError) throw new AppError('Failed to fetch deal', 500);
        if (!existing) throw new AppError('Deal not found', 404);
        if (existing.status === 'open') throw new AppError('Only won or lost deals can be reopened', 409);

        const { data, error } = await supabaseAdmin
            .from('deals')
            .update({ status: 'open', closed_at: null, loss_reason: null, loss_reason_code: null })
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .in('status', ['won', 'lost'])
            .select(DEAL_SELECT)
            .maybeSingle();

        if (error) {
            log.error({ err: error }, 'Reopen deal failed');
            throw new AppError('Failed to reopen deal', 500);
        }
        // Race: status changed between the pre-SELECT and the conditional UPDATE.
        if (!data) {
            const { data: recheck, error: recheckError } = await supabaseAdmin
                .from('deals')
                .select('status')
                .eq('id', req.params.id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (recheckError) throw new AppError('Failed to reopen deal', 500);
            if (!recheck) throw new AppError('Deal not found', 404);
            throw new AppError('Only won or lost deals can be reopened', 409);
        }

        if (req.body.reason) log.info({ dealId: req.params.id, reason: req.body.reason }, 'Deal reopened');
        const [mapped] = await mapDealRelations([data as DealRelations]);
        res.json({ data: mapped });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', writeRoles, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid deal id', 400);
        // deal_contacts CASCADE with the deal; tasks.deal_id is SET NULL (migration 133).
        const { data, error } = await supabaseAdmin
            .from('deals')
            .delete()
            .eq('id', req.params.id)
            .eq('tenant_id', req.tenantId!)
            .select('id')
            .maybeSingle();

        if (error) throw new AppError('Failed to delete deal', 500);
        if (!data) throw new AppError('Deal not found', 404);
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

// ── deal_contacts sub-routes ────────────────────────────────────────────────
router.post('/:id/contacts', writeRoles, validateBody(dealContactSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid deal id', 400);
        const tenantId = req.tenantId!;

        const { data: deal, error: dealError } = await supabaseAdmin
            .from('deals')
            .select('id, company_id')
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (dealError) throw new AppError('Failed to fetch deal', 500);
        if (!deal) throw new AppError('Deal not found', 404);

        // The contact must belong to the deal's OWN company (mirrors the DB fence).
        const { data: contact, error: contactError } = await supabaseAdmin
            .from('contacts')
            .select('id')
            .eq('id', req.body.contact_id)
            .eq('tenant_id', tenantId)
            .eq('company_id', deal.company_id)
            .maybeSingle();
        if (contactError) throw new AppError('Failed to validate contact', 500);
        if (!contact) throw new AppError('Contact does not belong to the deal\'s company', 422);

        const { data, error } = await supabaseAdmin
            .from('deal_contacts')
            .insert({
                tenant_id: tenantId,
                deal_id: req.params.id,
                contact_id: req.body.contact_id,
                role: req.body.role || null,
            })
            .select('id, contact_id, role, created_at')
            .single();

        if (error) {
            if (error.code === '23505') throw new AppError('Contact is already linked to this deal', 409);
            log.error({ err: error }, 'Add deal contact failed');
            throw new AppError('Failed to add deal contact', 500);
        }

        res.status(201).json({ data });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id/contacts/:contactId', writeRoles, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid deal id', 400);
        if (!UUID_RE.test(req.params.contactId as string)) throw new AppError('Invalid contact id', 400);
        const tenantId = req.tenantId!;

        const { data, error } = await supabaseAdmin
            .from('deal_contacts')
            .delete()
            .eq('tenant_id', tenantId)
            .eq('deal_id', req.params.id)
            .eq('contact_id', req.params.contactId)
            .select('id')
            .maybeSingle();

        if (error) throw new AppError('Failed to remove deal contact', 500);
        if (!data) throw new AppError('Deal contact not found', 404);
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

export default router;
