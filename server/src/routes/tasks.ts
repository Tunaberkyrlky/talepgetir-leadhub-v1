import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { resolveUsers } from '../lib/userResolver.js';
import {
    validateBody,
    createTaskSchema,
    bulkCreateTasksSchema,
    updateTaskSchema,
    completeTaskSchema,
    TASK_PRIORITIES,
    TASK_STATUSES,
} from '../lib/validation.js';

const router = Router();
const log = createLogger('route:tasks');
const writeRoles = requireRole('superadmin', 'ops_agent', 'client_admin');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TaskRelations {
    companies?: { name?: string; stage?: string } | null;
    contacts?: { first_name?: string; last_name?: string | null } | null;
    assigned_to?: string | null;
    [key: string]: unknown;
}

async function mapTaskRelations(rows: TaskRelations[]) {
    const users = await resolveUsers(rows.map((row) => row.assigned_to || '').filter(Boolean));
    return rows.map((row) => {
        const companyName = row.companies?.name || null;
        const companyStage = row.companies?.stage || null;
        const contactName = row.contacts
            ? [row.contacts.first_name, row.contacts.last_name].filter(Boolean).join(' ') || null
            : null;
        const assignedUser = row.assigned_to ? users.get(row.assigned_to) || null : null;
        const { companies: _companies, contacts: _contacts, ...task } = row;
        return {
            ...task,
            company_name: companyName,
            company_stage: companyStage,
            contact_name: contactName,
            assigned_user: assignedUser,
        };
    });
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

    if (error) throw new AppError('Failed to validate task owner', 500);
    if (!data) throw new AppError('Task owner is not an active member of this workspace', 422);
}

// A deal-scoped task (v2 Phase 5) must point at a deal in the same tenant AND the
// same company as the task. tasks.deal_id has no DB fence (shared table), so this
// app-layer check is the only guard against cross-company / cross-tenant linkage.
async function assertDealForCompany(tenantId: string, dealId: string, companyId: string) {
    const { data, error } = await supabaseAdmin
        .from('deals')
        .select('company_id')
        .eq('id', dealId)
        .eq('tenant_id', tenantId)
        .maybeSingle();

    if (error) throw new AppError('Failed to validate deal', 500);
    if (!data) throw new AppError('Deal not found in this workspace', 422);
    if (data.company_id !== companyId) throw new AppError('Deal does not belong to the selected company', 422);
}

router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
        const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '20'), 10) || 20));
        const offset = (page - 1) * limit;

        let query = supabaseAdmin
            .from('tasks')
            .select('*, companies(name, stage), contacts(first_name, last_name)', { count: 'exact' })
            .eq('tenant_id', tenantId);

        const companyId = typeof req.query.company_id === 'string' ? req.query.company_id : '';
        const contactId = typeof req.query.contact_id === 'string' ? req.query.contact_id : '';
        const dealId = typeof req.query.deal_id === 'string' ? req.query.deal_id : '';
        const assignedTo = typeof req.query.assigned_to === 'string' ? req.query.assigned_to : '';
        const createdBy = typeof req.query.created_by === 'string' ? req.query.created_by : '';
        const status = typeof req.query.status === 'string' ? req.query.status : '';
        const priority = typeof req.query.priority === 'string' ? req.query.priority : '';
        const dateFrom = typeof req.query.date_from === 'string' ? req.query.date_from : '';
        const dateTo = typeof req.query.date_to === 'string' ? req.query.date_to : '';
        const completedFrom = typeof req.query.completed_from === 'string' ? req.query.completed_from : '';
        const overdue = req.query.overdue === 'true';
        // Overdue sınırı için opsiyonel referans zaman; client tüm pencereleri tek 'now'dan türetir.
        const asOf = typeof req.query.as_of === 'string' ? req.query.as_of : '';

        if (companyId) {
            if (!UUID_RE.test(companyId)) throw new AppError('Invalid company_id', 400);
            query = query.eq('company_id', companyId);
        }
        if (contactId) {
            if (!UUID_RE.test(contactId)) throw new AppError('Invalid contact_id', 400);
            query = query.eq('contact_id', contactId);
        }
        if (dealId) {
            if (!UUID_RE.test(dealId)) throw new AppError('Invalid deal_id', 400);
            query = query.eq('deal_id', dealId);
        }
        if (assignedTo === 'me') query = query.eq('assigned_to', req.user!.id);
        else if (assignedTo) {
            if (!UUID_RE.test(assignedTo)) throw new AppError('Invalid assigned_to', 400);
            query = query.eq('assigned_to', assignedTo);
        }
        if (createdBy === 'me') query = query.eq('created_by', req.user!.id);
        else if (createdBy) {
            if (!UUID_RE.test(createdBy)) throw new AppError('Invalid created_by', 400);
            query = query.eq('created_by', createdBy);
        }
        if (status) {
            if (!TASK_STATUSES.includes(status as typeof TASK_STATUSES[number])) throw new AppError('Invalid task status', 400);
            query = query.eq('status', status);
        }
        if (priority) {
            if (!TASK_PRIORITIES.includes(priority as typeof TASK_PRIORITIES[number])) throw new AppError('Invalid task priority', 400);
            query = query.eq('priority', priority);
        }
        if (dateFrom) {
            if (Number.isNaN(Date.parse(dateFrom))) throw new AppError('Invalid date_from', 400);
            query = query.gte('due_at', dateFrom);
        }
        if (dateTo) {
            if (Number.isNaN(Date.parse(dateTo))) throw new AppError('Invalid date_to', 400);
            query = query.lte('due_at', dateTo);
        }
        if (completedFrom) {
            if (Number.isNaN(Date.parse(completedFrom))) throw new AppError('Invalid completed_from', 400);
            query = query.gte('completed_at', completedFrom);
        }
        if (asOf && Number.isNaN(Date.parse(asOf))) throw new AppError('Invalid as_of', 400);
        if (overdue) {
            // Canonicalise as_of to a normalised ISO-8601 instant before it reaches PostgREST — a
            // permissive Date.parse input (e.g. an out-of-range day) must not be forwarded raw.
            const overdueRef = asOf ? new Date(asOf).toISOString() : new Date().toISOString();
            query = query.eq('status', 'pending').lt('due_at', overdueRef);
        }

        const { data, count, error } = await query
            .order('due_at', { ascending: true })
            .range(offset, offset + limit - 1);

        if (error) {
            log.error({ err: error }, 'List tasks failed');
            throw new AppError('Failed to fetch tasks', 500);
        }

        const mapped = await mapTaskRelations((data || []) as TaskRelations[]);
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

router.post('/', writeRoles, validateBody(createTaskSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const assignedTo = req.body.assigned_to || req.user!.id;
        await assertCompanyAndContact(tenantId, req.body.company_id, req.body.contact_id);
        await assertAssignableUser(tenantId, assignedTo, req.user!.id);
        if (req.body.deal_id) await assertDealForCompany(tenantId, req.body.deal_id, req.body.company_id);

        const { data, error } = await supabaseAdmin
            .from('tasks')
            .insert({
                tenant_id: tenantId,
                company_id: req.body.company_id,
                contact_id: req.body.contact_id || null,
                deal_id: req.body.deal_id || null,
                title: req.body.title,
                detail: req.body.detail || null,
                priority: req.body.priority,
                due_at: req.body.due_at,
                assigned_to: assignedTo,
                created_by: req.user!.id,
            })
            .select('*, companies(name, stage), contacts(first_name, last_name)')
            .single();

        if (error) {
            log.error({ err: error }, 'Create task failed');
            throw new AppError('Failed to create task', 500);
        }

        const [mapped] = await mapTaskRelations([data as TaskRelations]);
        res.status(201).json({ data: mapped });
    } catch (err) {
        next(err);
    }
});

// POST /api/tasks/bulk-create — create the SAME task once per selected company (v2 Phase 8,
// E10). The owner (single, shared) is validated once; companies are validated as a batch and
// any outside the tenant is reported per-company as not_found. Not atomic by design — the
// bulk insert covers the valid companies and returns a per-company result list.
router.post('/bulk-create', writeRoles, validateBody(bulkCreateTasksSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        // Owner contract (A2): an omitted assigned_to defaults to the caller; an explicit
        // null keeps the task unassigned. `|| req.user!.id` would wrongly reassign null → self.
        const assignedTo = req.body.assigned_to === undefined ? req.user!.id : req.body.assigned_to;
        // Shared owner is validated once for the whole batch (a bad owner is a 422 for all).
        await assertAssignableUser(tenantId, assignedTo, req.user!.id);

        // De-dupe ids so the same company can't get two identical tasks in one call.
        const ids = Array.from(new Set(req.body.company_ids as string[]));

        // Per-company isolation: validate + insert each company on its own so a company
        // deleted between selection and execution (FK violation) fails only that row instead
        // of dropping the whole batch. reason carries a stable code the client localizes.
        const results: Array<{ company_id: string; ok: boolean; reason?: string }> = [];
        let created = 0;
        for (const companyId of ids) {
            try {
                await assertCompanyAndContact(tenantId, companyId, null);
                const { error } = await supabaseAdmin.from('tasks').insert({
                    tenant_id: tenantId,
                    company_id: companyId,
                    contact_id: null,
                    deal_id: null,
                    title: req.body.title,
                    detail: req.body.detail || null,
                    priority: req.body.priority,
                    due_at: req.body.due_at,
                    assigned_to: assignedTo,
                    created_by: req.user!.id,
                });
                if (error) throw error;
                created += 1;
                results.push({ company_id: companyId, ok: true });
            } catch (rowErr) {
                if (rowErr instanceof AppError && rowErr.statusCode === 404) {
                    results.push({ company_id: companyId, ok: false, reason: 'not_found' });
                } else {
                    log.error({ err: rowErr, companyId }, 'Bulk create task row failed');
                    results.push({ company_id: companyId, ok: false, reason: 'db_error' });
                }
            }
        }

        res.status(201).json({ created, results });
    } catch (err) {
        next(err);
    }
});

router.put('/:id', writeRoles, validateBody(updateTaskSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid task id', 400);
        const tenantId = req.tenantId!;
        const { data: existing, error: existingError } = await supabaseAdmin
            .from('tasks')
            .select('id, company_id, status')
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();

        if (existingError) throw new AppError('Failed to fetch task', 500);
        if (!existing) throw new AppError('Task not found', 404);
        if (existing.status !== 'pending') throw new AppError('Only pending tasks can be edited', 409);

        if (req.body.contact_id !== undefined) {
            await assertCompanyAndContact(tenantId, existing.company_id, req.body.contact_id);
        }
        if (req.body.assigned_to !== undefined) {
            await assertAssignableUser(tenantId, req.body.assigned_to, req.user!.id);
        }
        // deal_id null = unlink (allowed); a real deal must be in this tenant + company.
        if (req.body.deal_id !== undefined && req.body.deal_id !== null) {
            await assertDealForCompany(tenantId, req.body.deal_id, existing.company_id);
        }

        const { data, error } = await supabaseAdmin
            .from('tasks')
            .update(req.body)
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .eq('status', 'pending')
            .select('*, companies(name, stage), contacts(first_name, last_name)')
            .maybeSingle();

        if (error) {
            log.error({ err: error }, 'Update task failed');
            throw new AppError('Failed to update task', 500);
        }
        // Race: status changed between the pre-SELECT and the conditional UPDATE.
        if (!data) {
            const { data: recheck, error: recheckError } = await supabaseAdmin
                .from('tasks')
                .select('status')
                .eq('id', req.params.id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (recheckError) throw new AppError('Failed to update task', 500);
            if (!recheck) throw new AppError('Task not found', 404);
            throw new AppError('Only pending tasks can be edited', 409);
        }

        const [mapped] = await mapTaskRelations([data as TaskRelations]);
        res.json({ data: mapped });
    } catch (err) {
        next(err);
    }
});

router.post('/:id/complete', writeRoles, validateBody(completeTaskSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid task id', 400);
        const tenantId = req.tenantId!;
        const { data: existing, error: existingError } = await supabaseAdmin
            .from('tasks')
            .select('status')
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();

        if (existingError) throw new AppError('Failed to fetch task', 500);
        if (!existing) throw new AppError('Task not found', 404);
        if (existing.status !== 'pending') throw new AppError('Only pending tasks can be completed', 409);

        const { data, error } = await supabaseAdmin.rpc('complete_crm_task', {
            p_tenant_id: tenantId,
            p_task_id: req.params.id,
            p_completed_by: req.user!.id,
            p_create_activity: req.body.create_activity,
            p_result_summary: req.body.result_summary || null,
            p_result_detail: req.body.result_detail || null,
        });

        if (error) {
            // Race: the task was completed/cancelled between the pre-SELECT and the RPC.
            if (error.message?.includes('Pending task not found')) {
                const { data: recheck, error: recheckError } = await supabaseAdmin
                    .from('tasks')
                    .select('status')
                    .eq('id', req.params.id)
                    .eq('tenant_id', tenantId)
                    .maybeSingle();
                if (recheckError) throw new AppError('Failed to complete task', 500);
                if (!recheck) throw new AppError('Task not found', 404);
                throw new AppError('Only pending tasks can be completed', 409);
            }
            log.error({ err: error }, 'Complete task failed');
            throw new AppError('Failed to complete task', 500);
        }

        res.json({ data });
    } catch (err) {
        next(err);
    }
});

router.post('/:id/cancel', writeRoles, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid task id', 400);
        const tenantId = req.tenantId!;
        const { data: existing, error: existingError } = await supabaseAdmin
            .from('tasks')
            .select('status')
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();

        if (existingError) throw new AppError('Failed to fetch task', 500);
        if (!existing) throw new AppError('Task not found', 404);
        if (existing.status !== 'pending') throw new AppError('Only pending tasks can be cancelled', 409);

        const { data, error } = await supabaseAdmin
            .from('tasks')
            .update({ status: 'cancelled', completed_at: null, completed_by: null })
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .eq('status', 'pending')
            .select()
            .maybeSingle();

        if (error) throw new AppError('Failed to cancel task', 500);
        // Race: status changed between the pre-SELECT and the conditional UPDATE.
        if (!data) {
            const { data: recheck, error: recheckError } = await supabaseAdmin
                .from('tasks')
                .select('status')
                .eq('id', req.params.id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (recheckError) throw new AppError('Failed to cancel task', 500);
            if (!recheck) throw new AppError('Task not found', 404);
            throw new AppError('Only pending tasks can be cancelled', 409);
        }
        res.json({ data });
    } catch (err) {
        next(err);
    }
});

router.post('/:id/reopen', writeRoles, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid task id', 400);
        const tenantId = req.tenantId!;
        const { data: existing, error: existingError } = await supabaseAdmin
            .from('tasks')
            .select('status')
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();

        if (existingError) throw new AppError('Failed to fetch task', 500);
        if (!existing) throw new AppError('Task not found', 404);
        if (existing.status === 'pending') throw new AppError('Only completed or cancelled tasks can be reopened', 409);

        const { data, error } = await supabaseAdmin
            .from('tasks')
            .update({ status: 'pending', completed_at: null, completed_by: null })
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .in('status', ['completed', 'cancelled'])
            .select()
            .maybeSingle();

        if (error) throw new AppError('Failed to reopen task', 500);
        // Race: status changed between the pre-SELECT and the conditional UPDATE.
        if (!data) {
            const { data: recheck, error: recheckError } = await supabaseAdmin
                .from('tasks')
                .select('status')
                .eq('id', req.params.id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (recheckError) throw new AppError('Failed to reopen task', 500);
            if (!recheck) throw new AppError('Task not found', 404);
            throw new AppError('Only completed or cancelled tasks can be reopened', 409);
        }
        res.json({ data });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', writeRoles, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid task id', 400);
        const { data, error } = await supabaseAdmin
            .from('tasks')
            .delete()
            .eq('id', req.params.id)
            .eq('tenant_id', req.tenantId!)
            .select('id')
            .maybeSingle();

        if (error) throw new AppError('Failed to delete task', 500);
        if (!data) throw new AppError('Task not found', 404);
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

export default router;
