/**
 * Research ADMIN routes — INTERNAL ONLY (superadmin / ops_agent).
 *
 * The margin panel (01 §3 D11): real COGS per tenant/run vs billed leads. This is the ONLY place
 * dollar figures leave the server: customer-facing routes are sanitized (lib/research/sanitize.ts)
 * and migration 068 strips the dollar-bearing columns from direct client reads. Everything here is
 * deliberately CROSS-tenant (the whole point is comparing tenants' margins), which is why the
 * whole router is gated on internal roles, not tenant scope.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { enqueueJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPES } from '../../lib/research/jobTypes.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { grantCredits } from '../../lib/research/engine/ledger.js';
import { HUNTER_PER_REQUEST_USD, costFromUsageSummary, costOfUsageBucket } from '../../lib/research/engine/pricing.js';
import type { LlmUsageSummary } from '../../lib/research/llm/meter.js';
import type { LlmRole } from '../../lib/research/llm/types.js';
import {
    LLM_ROLES,
    ROLE_PROVIDER,
    PROVIDER_LABEL,
    MODEL_CATALOG,
    isValidModelId,
    getRoleModels,
    invalidateLlmConfigCache,
} from '../../lib/research/llm/llmConfig.js';
import { effectiveCostRole } from '../../lib/research/freshRole.js';

const log = createLogger('route:research:admin');
const router = Router();

// EVERYTHING below is internal-only. client_admin/client_viewer get a 403 before any handler.
router.use(requireRole('superadmin', 'ops_agent'));

// FRESH role recheck (codex P1): the auth middleware caches role resolution for 60s, so a
// demoted operator could keep reading dollar COGS until the TTL expires. Re-verify the internal
// claim against the source of truth on EVERY request here (effectiveCostRole re-reads the
// ops_agent membership / superadmin app_metadata; verification failure fails CLOSED).
router.use(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const fresh = await effectiveCostRole(req.user, req.tenantId);
        if (fresh !== 'superadmin' && fresh !== 'ops_agent') {
            res.status(403).json({ error: 'Insufficient permissions' });
            return;
        }
        next();
    } catch (err) {
        log.error({ err }, 'fresh role recheck error');
        res.status(500).json({ error: 'Role verification failed' });
    }
});

/** Parse an optional ISO date query param; undefined when absent, null marks invalid. */
function parseDate(v: unknown): Date | null | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

// ── GET /api/research/admin/costs?from=&to= — per-tenant COGS/margin summary ─────
router.get('/costs', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const from = parseDate(req.query.from);
        const to = parseDate(req.query.to);
        if (from === null || to === null) {
            res.status(400).json({ error: 'Invalid from/to date (use ISO 8601)' });
            return;
        }
        const { data, error } = await researchSupabaseAdmin.rpc('research_admin_cost_summary', {
            p_from: from?.toISOString() ?? null,
            p_to: to?.toISOString() ?? null,
            // Per-Hunter-request USD rate (0 on the free/trial plan) — the RPC returns request
            // counts always; hunter_cost_usd is those counts × this rate. One config source (pricing.ts).
            p_hunter_usd: HUNTER_PER_REQUEST_USD,
        });
        if (error) {
            log.error({ err: error }, 'admin cost summary failed');
            throw new AppError('Failed to fetch cost summary', 500);
        }
        res.json({ data: data ?? [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'admin costs error');
        next(new AppError('Failed to fetch cost summary', 500));
    }
});

// ── GET /api/research/admin/runs?tenant_id=&status=&page=&limit= — harvest run history ─
// Full job rows (INCLUDING result.cost_usd / usage_raw / cost_recheck / caps) — internal eyes only.
router.get('/runs', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { tenant_id, status } = req.query;
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
        const offset = (page - 1) * limit;

        if (tenant_id && typeof tenant_id === 'string' && !uuidField().safeParse(tenant_id).success) {
            res.status(400).json({ error: 'Invalid tenant_id' });
            return;
        }
        if (status && typeof status === 'string' && !['queued', 'running', 'succeeded', 'failed', 'canceled'].includes(status)) {
            res.status(400).json({ error: 'Invalid status' });
            return;
        }

        let query = researchSupabaseAdmin
            .from('research_jobs')
            .select('*', { count: 'exact' })
            .eq('type', 'harvest:run')
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (tenant_id && typeof tenant_id === 'string') query = query.eq('tenant_id', tenant_id);
        if (status && typeof status === 'string') query = query.eq('status', status);

        const { data, error, count } = await query;
        if (error) {
            log.error({ err: error }, 'admin runs query failed');
            throw new AppError('Failed to fetch runs', 500);
        }

        // Attach tenant names for display (one lookup for the page's distinct tenants).
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        const tenantIds = [...new Set(rows.map((r) => r.tenant_id as string))];
        const nameById = new Map<string, string>();
        if (tenantIds.length > 0) {
            const { data: tenants, error: tErr } = await researchSupabaseAdmin
                .from('tenants')
                .select('id, name')
                .in('id', tenantIds);
            if (tErr) log.warn({ err: tErr }, 'tenant name lookup failed (non-fatal)');
            for (const t of tenants ?? []) nameById.set((t as { id: string }).id, (t as { name: string }).name);
        }

        res.json({
            data: rows.map((r) => ({ ...r, tenant_name: nameById.get(r.tenant_id as string) ?? null })),
            pagination: { total: count || 0, page, limit, hasNext: offset + limit < (count || 0) },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'admin runs error');
        next(new AppError('Failed to fetch runs', 500));
    }
});

// ── POST /api/research/admin/credits/grant — operator top-up (idempotent) ────────
// The only credit-granting surface. Pass idempotency_key (a stable UUID for this logical grant)
// so a timeout-retry cannot double-credit (063).
const grantSchema = z.object({
    tenant_id: uuidField('Invalid tenant ID'),
    amount: z.number().int().min(1).max(100_000),
    reason: z.string().min(1).max(200).optional(),
    // REQUIRED (codex P2): a retry after an ambiguous timeout must reuse the SAME key or it
    // double-credits — making it optional invited exactly that. The UI holds one key per logical
    // grant and rotates it only after a confirmed success.
    idempotency_key: uuidField('Invalid idempotency key'),
});

router.post('/credits/grant', validateBody(grantSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { tenant_id, amount, reason, idempotency_key } = req.body as z.infer<typeof grantSchema>;

        const { data: tenant, error: tErr } = await researchSupabaseAdmin
            .from('tenants')
            .select('id')
            .eq('id', tenant_id)
            .maybeSingle();
        if (tErr) {
            log.error({ err: tErr }, 'grant tenant lookup failed');
            throw new AppError('Failed to grant credits', 500);
        }
        if (!tenant) {
            res.status(404).json({ error: 'Tenant not found' });
            return;
        }

        // NOTE: the RPC is idempotent on the key — a duplicate submit no-ops and returns the
        // CURRENT balance. Don't echo `amount` as "granted": on a dedup nothing new was granted.
        const balance = await grantCredits(tenant_id, amount, reason ?? 'admin_grant', idempotency_key);
        log.info({ tenantId: tenant_id, amount, by: req.user?.id }, 'research credits grant settled (idempotent)');
        res.json({ tenant_id, balance });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'grant credits error');
        next(new AppError('Failed to grant credits', 500));
    }
});

// ── Tier / quota settings (no Stripe — the operator IS the billing system) ───────
// GET returns the settings row (or null → defaults apply); PUT upserts it. The financial
// chokepoint stays the RPCs (idempotent period grants + the hold/bill chain) — this is config.
const settingsSchema = z.object({
    tenant_id: uuidField('Invalid tenant ID'),
    research_tier: z.enum(['trial', 'starter', 'growth', 'scale', 'custom']),
    monthly_lead_quota: z.number().int().min(0).max(1_000_000),
    reserve_estimate: z.number().int().min(1).max(10_000).nullable().optional(),
    auto_grant: z.boolean().optional(),
});

router.get('/settings', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { tenant_id } = req.query;
        if (!tenant_id || typeof tenant_id !== 'string' || !uuidField().safeParse(tenant_id).success) {
            res.status(400).json({ error: 'tenant_id is required' });
            return;
        }
        const { data, error } = await researchSupabaseAdmin
            .from('research_tenant_settings')
            .select('*')
            .eq('tenant_id', tenant_id)
            .maybeSingle();
        if (error) {
            log.error({ err: error }, 'settings read failed');
            throw new AppError('Failed to fetch settings', 500);
        }
        res.json({ data: data ?? null });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'settings read error');
        next(new AppError('Failed to fetch settings', 500));
    }
});

router.put('/settings', validateBody(settingsSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const body = req.body as z.infer<typeof settingsSchema>;
        const { data: tenant, error: tErr } = await researchSupabaseAdmin
            .from('tenants')
            .select('id')
            .eq('id', body.tenant_id)
            .maybeSingle();
        if (tErr) {
            log.error({ err: tErr }, 'settings tenant lookup failed');
            throw new AppError('Failed to save settings', 500);
        }
        if (!tenant) {
            res.status(404).json({ error: 'Tenant not found' });
            return;
        }
        const { data, error } = await researchSupabaseAdmin
            .from('research_tenant_settings')
            .upsert(
                {
                    tenant_id: body.tenant_id,
                    research_tier: body.research_tier,
                    monthly_lead_quota: body.monthly_lead_quota,
                    // Omitted key = PRESERVE the stored value (PostgREST upsert only touches sent
                    // columns); explicit null clears it. The UI form omits it, so a tier/quota save
                    // can't wipe a configured per-run reservation size (codex P2).
                    ...(body.reserve_estimate !== undefined ? { reserve_estimate: body.reserve_estimate } : {}),
                    auto_grant: body.auto_grant ?? true,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'tenant_id' }
            )
            .select()
            .single();
        if (error) {
            log.error({ err: error }, 'settings upsert failed');
            throw new AppError('Failed to save settings', 500);
        }
        log.info({ tenantId: body.tenant_id, tier: body.research_tier, quota: body.monthly_lead_quota, by: req.user?.id }, 'research settings saved');
        res.json({ data });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'settings save error');
        next(new AppError('Failed to save settings', 500));
    }
});

// Manual trigger for the current period's automatic grants (the worker tick also applies them —
// this is the operator's "apply now" button; idempotent per (tenant, period)).
router.post('/quota/apply-period-grants', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { data, error } = await researchSupabaseAdmin.rpc('research_apply_period_grants', {});
        if (error) {
            log.error({ err: error }, 'apply period grants failed');
            throw new AppError('Failed to apply period grants', 500);
        }
        log.info({ granted: data, by: req.user?.id }, 'period grants applied (manual)');
        res.json({ granted: (data as number) ?? 0 });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'apply period grants error');
        next(new AppError('Failed to apply period grants', 500));
    }
});

// Manual trigger for the campaign-outcome aggregate (WP5) — enqueues one feedback:aggregate
// job for the CURRENT tenant context (the worker's daily tick covers all tenants; this is the
// operator's "run now" button). Deterministic + idempotent handler, no LLM/billing.
router.post('/feedback/aggregate', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const job = await enqueueJob({
            tenantId,
            type: RESEARCH_JOB_TYPES.FEEDBACK_AGGREGATE,
            payload: {},
            createdBy: req.user?.id ?? null,
        });
        log.info({ jobId: job.id, by: req.user?.id }, 'feedback aggregate enqueued (manual)');
        res.status(202).json({ job_id: job.id });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'feedback aggregate enqueue error');
        next(new AppError('Failed to start feedback aggregate', 500));
    }
});

// ── Step → role mapping for the cost breakdown (which role/model each AI step runs) ──
// harvest:run is 'mixed' (search=Gemini for discovery + reading=DeepSeek for validation);
// its true per-model split shows in the provider rollup below.
const STEP_ROLE: Record<string, LlmRole | 'mixed'> = {
    'icp:generate': 'strategy',
    'icp:revise': 'strategy',
    'geo:analyze': 'strategy',
    'offer:generate': 'strategy',
    'hs:match': 'strategy',
    'profile:crawl': 'strategy',
    'harvest:run': 'mixed',
};
const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

// ── GET /api/research/admin/cost-breakdown?from=&to=&tenant_id= ───────────────────
// Per-STEP and per-MODEL AI spend across EVERY metered job type (not just harvest+icp).
// This is where the wizard steps (profile:crawl, geo/offer/hs/icp:revise) that used to
// show $0 on the panel become visible. Dollars are recomputed from the raw meter tally
// at the CURRENT rate book (pricing.ts), so steps and providers always reconcile.
router.get('/cost-breakdown', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const from = parseDate(req.query.from);
        const to = parseDate(req.query.to);
        if (from === null || to === null) {
            res.status(400).json({ error: 'Invalid from/to date (use ISO 8601)' });
            return;
        }
        const tenantId = req.query.tenant_id;
        if (tenantId !== undefined && (typeof tenantId !== 'string' || !uuidField().safeParse(tenantId).success)) {
            res.status(400).json({ error: 'Invalid tenant_id' });
            return;
        }

        const { data, error } = await researchSupabaseAdmin.rpc('research_admin_ai_jobs', {
            p_from: from?.toISOString() ?? null,
            p_to: to?.toISOString() ?? null,
            p_tenant: typeof tenantId === 'string' ? tenantId : null,
        });
        if (error) {
            log.error({ err: error }, 'admin cost-breakdown rpc failed');
            throw new AppError('Failed to fetch cost breakdown', 500);
        }

        const roleModels = await getRoleModels();
        const stepMap = new Map<string, { runs: number; cost: number }>();
        // Keyed by `provider|model` — spend attributed to the ACTUAL model that ran (from the
        // meter's per-model tally), so switching a role's model never relabels historical spend.
        const modelMap = new Map<string, { provider: string; model: string | null; cost: number; calls: number; inTok: number; outTok: number }>();

        for (const row of (data ?? []) as Array<{ job_type: string; usage_raw: LlmUsageSummary | null }>) {
            const usage = row.usage_raw;
            if (!usage || typeof usage !== 'object' || !usage.byProvider) continue;
            const breakdown = costFromUsageSummary(usage);
            const s = stepMap.get(row.job_type) ?? { runs: 0, cost: 0 };
            s.runs += 1;
            s.cost += breakdown.totalUsd;
            stepMap.set(row.job_type, s);
            for (const [prov, u] of Object.entries(usage.byProvider)) {
                const models = u.models && Object.keys(u.models).length > 0 ? Object.entries(u.models) : null;
                if (models) {
                    for (const [model, mu] of models) {
                        const key = `${prov}|${model}`;
                        const b = modelMap.get(key) ?? { provider: prov, model, cost: 0, calls: 0, inTok: 0, outTok: 0 };
                        b.cost += costOfUsageBucket(prov, mu);
                        b.calls += mu.calls ?? 0;
                        b.inTok += mu.inputTokens ?? 0;
                        b.outTok += mu.outputTokens ?? 0;
                        modelMap.set(key, b);
                    }
                } else {
                    // Legacy job metered before per-model tracking (068+ jobs may predate it): the
                    // model is unknown, so attribute the whole provider bucket with model = null.
                    const key = `${prov}|`;
                    const b = modelMap.get(key) ?? { provider: prov, model: null, cost: 0, calls: 0, inTok: 0, outTok: 0 };
                    b.cost += breakdown.byProvider[prov] ?? 0;
                    b.calls += u.calls ?? 0;
                    b.inTok += u.inputTokens ?? 0;
                    b.outTok += u.outputTokens ?? 0;
                    modelMap.set(key, b);
                }
            }
        }

        const steps = [...stepMap.entries()]
            .map(([job_type, v]) => {
                const role = STEP_ROLE[job_type] ?? null;
                const model = role && role !== 'mixed' ? roleModels[role].model : null;
                return { job_type, role, model, runs: v.runs, total_usd: round6(v.cost) };
            })
            .sort((a, b) => b.total_usd - a.total_usd);

        const providers = [...modelMap.values()]
            .map((v) => ({
                provider: v.provider,
                label: PROVIDER_LABEL[v.provider] ?? v.provider,
                model: v.model,
                cost_usd: round6(v.cost),
                calls: v.calls,
                input_tokens: v.inTok,
                output_tokens: v.outTok,
            }))
            .sort((a, b) => b.cost_usd - a.cost_usd);

        res.json({
            data: {
                steps,
                providers,
                roleModels,
                totals: {
                    ai_usd: round6(providers.reduce((s, p) => s + p.cost_usd, 0)),
                    runs: steps.reduce((s, x) => s + x.runs, 0),
                },
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'admin cost-breakdown error');
        next(new AppError('Failed to fetch cost breakdown', 500));
    }
});

// ── GET /api/research/admin/llm-config — current per-role model + editable catalog ──
router.get('/llm-config', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const roleModels = await getRoleModels();
        res.json({
            data: {
                roles: LLM_ROLES.map((role) => ({
                    role,
                    provider: ROLE_PROVIDER[role],
                    provider_label: PROVIDER_LABEL[ROLE_PROVIDER[role]] ?? ROLE_PROVIDER[role],
                    model: roleModels[role].model,
                    source: roleModels[role].source,
                    catalog: MODEL_CATALOG[role],
                })),
            },
        });
    } catch (err) {
        log.error({ err }, 'llm-config read error');
        next(new AppError('Failed to fetch LLM config', 500));
    }
});

// ── PUT /api/research/admin/llm-config — set (or reset) a role's model override ──────
// model: a model id (validated shape; the operator owns correctness of a custom id, same
// as the env override already was). Send model=null / '' to CLEAR the override → the role
// reverts to its env default. Provider is never editable here.
const llmConfigSchema = z.object({
    role: z.enum(['strategy', 'search', 'reading']),
    model: z.string().max(120).nullable(),
});

router.put('/llm-config', validateBody(llmConfigSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { role, model } = req.body as z.infer<typeof llmConfigSchema>;
        const trimmed = model?.trim() ?? '';

        if (trimmed === '') {
            // Clear the override → env default resumes.
            const { error } = await researchSupabaseAdmin.from('research_llm_config').delete().eq('role', role);
            if (error) {
                log.error({ err: error }, 'llm-config delete failed');
                throw new AppError('Failed to reset model', 500);
            }
        } else {
            if (!isValidModelId(trimmed)) {
                res.status(400).json({ error: 'Invalid model id' });
                return;
            }
            const { error } = await researchSupabaseAdmin
                .from('research_llm_config')
                .upsert(
                    { role, model: trimmed, updated_at: new Date().toISOString(), updated_by: req.user?.id ?? null },
                    { onConflict: 'role' }
                );
            if (error) {
                log.error({ err: error }, 'llm-config upsert failed');
                throw new AppError('Failed to save model', 500);
            }
        }

        // Take effect immediately (bypass the router's 30s config cache).
        invalidateLlmConfigCache();
        log.info({ role, model: trimmed || '(default)', by: req.user?.id }, 'research llm model config saved');

        const roleModels = await getRoleModels();
        res.json({ data: { role, model: roleModels[role].model, source: roleModels[role].source } });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'llm-config save error');
        next(new AppError('Failed to save LLM config', 500));
    }
});

export default router;
