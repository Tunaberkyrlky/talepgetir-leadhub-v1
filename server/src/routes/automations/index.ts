/**
 * Automation run inspector (v3 Phase 5 acceptance: "the user sees WHY a run is waiting").
 * Read-only. Mirrors routes/assets/index.ts: supabaseAdmin + explicit req.tenantId! filter
 * on every query (RLS is defense-in-depth; supabaseAdmin bypasses it), AppError, createLogger.
 *
 * GET /runs      — the tenant's automation runs (paginated), with the automation name.
 * GET /runs/:id  — one run + its action ledger + its messages + a derived "why waiting"
 *                  (current node, its type, and whether it is running / waiting-until /
 *                  stopped / completed / failed).
 *
 * No writes here — the runtime is the only writer, and it is flag-gated OFF this round.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../../lib/supabase.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';

const router = Router();
const log = createLogger('route:automations');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_STATUSES = new Set(['running', 'waiting', 'paused', 'completed', 'stopped', 'failed']);

interface GraphNodeShape {
    type: string;
    config?: Record<string, unknown>;
    next?: string;
}
interface GraphShape {
    entry: string;
    nodes: Record<string, GraphNodeShape>;
}

/**
 * Derive a human-oriented "why is this run here" summary from the run row + its pinned
 * node. The state string is machine-stable (the client localizes it); the fields carry
 * the node + timing so the inspector can render "waiting at <node> until <wake_at>".
 */
function deriveWhyWaiting(
    run: { status: string; current_node_key: string | null; wake_at: string | null; stop_reason: string | null; goal_reached: boolean },
    node: GraphNodeShape | null,
): { state: string; current_node_key: string | null; current_node_type: string | null; wake_at: string | null; stop_reason: string | null } {
    const base = {
        current_node_key: run.current_node_key,
        current_node_type: node?.type ?? null,
        wake_at: run.wake_at,
        stop_reason: run.stop_reason,
    };
    switch (run.status) {
        case 'waiting':
            return { state: 'waiting_until', ...base };
        case 'running':
            return { state: 'ready_to_step', ...base };
        case 'paused':
            return { state: 'paused', ...base };
        case 'stopped':
            return { state: 'stopped', ...base };
        case 'failed':
            return { state: 'failed', ...base };
        case 'completed':
            return { state: run.goal_reached ? 'completed_goal_reached' : 'completed', ...base };
        default:
            return { state: run.status, ...base };
    }
}

// ── GET /runs — the tenant's automation runs (paginated, newest first) ───────────
router.get('/runs', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
        const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '25'), 10) || 25));
        const offset = (page - 1) * limit;
        const statusFilter = typeof req.query.status === 'string' && RUN_STATUSES.has(req.query.status)
            ? req.query.status
            : null;

        let query = supabaseAdmin
            .from('automation_runs')
            .select(
                'id, automation_id, version, status, current_node_key, wake_at, goal_reached, ' +
                'stop_reason, lead_id, company_id, started_at, completed_at, created_at, automations(name, key)',
                { count: 'exact' },
            )
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (statusFilter) query = query.eq('status', statusFilter);

        const { data, count, error } = await query;
        if (error) {
            log.error({ err: error }, 'List automation runs failed');
            throw new AppError('Failed to fetch automation runs', 500);
        }

        const mapped = ((data || []) as unknown as Record<string, unknown>[]).map((row) => {
            const automation = (row.automations || null) as { name?: string; key?: string } | null;
            return {
                id: row.id as string,
                automation_id: row.automation_id as string,
                automation_name: automation?.name ?? null,
                automation_key: automation?.key ?? null,
                version: (row.version as number) ?? null,
                status: row.status as string,
                current_node_key: (row.current_node_key as string | null) ?? null,
                wake_at: (row.wake_at as string | null) ?? null,
                goal_reached: !!row.goal_reached,
                stop_reason: (row.stop_reason as string | null) ?? null,
                lead_id: (row.lead_id as string | null) ?? null,
                company_id: (row.company_id as string | null) ?? null,
                started_at: (row.started_at as string | null) ?? null,
                completed_at: (row.completed_at as string | null) ?? null,
                created_at: row.created_at as string,
            };
        });
        const total = count || 0;
        res.json({
            data: mapped,
            pagination: {
                page, limit, total,
                totalPages: Math.ceil(total / limit),
                hasNext: offset + mapped.length < total,
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /runs/:id — one run + action ledger + messages + "why waiting" ────────────
router.get('/runs/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid run id', 400);
        const tenantId = req.tenantId!;

        const { data: runData, error: runErr } = await supabaseAdmin
            .from('automation_runs')
            .select(
                'id, automation_id, version, status, current_node_key, wake_at, goal_reached, ' +
                'stop_reason, context, lead_id, company_id, trigger_event_id, started_at, ' +
                'completed_at, created_at, updated_at, automations(name, key)',
            )
            .eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle();
        if (runErr) throw new AppError('Failed to fetch run', 500);
        if (!runData) throw new AppError('Run not found', 404);
        const run = runData as unknown as Record<string, unknown>;

        // Resolve the current node's type from the pinned, immutable graph (best-effort —
        // a missing snapshot just leaves current_node_type null in the summary).
        let currentNode: GraphNodeShape | null = null;
        if (run.current_node_key) {
            const { data: ver, error: verErr } = await supabaseAdmin
                .from('automation_versions')
                .select('graph')
                .eq('tenant_id', tenantId)
                .eq('automation_id', run.automation_id as string)
                .eq('version', run.version as number)
                .maybeSingle();
            if (verErr) throw new AppError('Failed to fetch run version', 500);
            const graph = (ver?.graph as GraphShape | undefined) ?? undefined;
            currentNode = graph?.nodes?.[run.current_node_key as string] ?? null;
        }

        // Action ledger (chronological — the run's step history).
        const { data: actions, error: actErr } = await supabaseAdmin
            .from('automation_actions')
            .select('id, node_key, node_type, status, provider_request_id, retry_reason, output, started_at, completed_at, created_at')
            .eq('run_id', req.params.id).eq('tenant_id', tenantId)
            .order('created_at', { ascending: true });
        if (actErr) throw new AppError('Failed to fetch run actions', 500);

        // Messages produced by this run (newest first).
        const { data: messages, error: msgErr } = await supabaseAdmin
            .from('messages')
            .select('id, channel, direction, provider, provider_message_id, template_key, subject, delivery_state, error_reason, automation_action_id, sent_at, created_at')
            .eq('automation_run_id', req.params.id).eq('tenant_id', tenantId)
            .order('created_at', { ascending: false });
        if (msgErr) throw new AppError('Failed to fetch run messages', 500);

        const automation = (run.automations || null) as { name?: string; key?: string } | null;
        const { automations: _drop, ...runFields } = run;
        res.json({
            data: {
                run: {
                    ...runFields,
                    automation_name: automation?.name ?? null,
                    automation_key: automation?.key ?? null,
                },
                why_waiting: deriveWhyWaiting(
                    {
                        status: run.status as string,
                        current_node_key: (run.current_node_key as string | null) ?? null,
                        wake_at: (run.wake_at as string | null) ?? null,
                        stop_reason: (run.stop_reason as string | null) ?? null,
                        goal_reached: !!run.goal_reached,
                    },
                    currentNode,
                ),
                actions: actions || [],
                messages: messages || [],
            },
        });
    } catch (err) {
        next(err);
    }
});

export default router;
