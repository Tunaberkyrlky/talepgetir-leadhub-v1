/**
 * Shared free-text AI-revise service (Z1) — draft-only, zero persistence.
 *
 * POST /api/research/revise/draft: rewrite ONE whitelisted text field of an ICP / offer / project
 * from a customer's free-text instruction, returning ONLY the draft. The client persists an applied
 * draft through the EXISTING PATCH endpoints (/research/icps/:id, /offers/:id, /projects/:id) — this
 * route NEVER writes. COGS is metered like icp:revise (house Opus spend, surfaced only on the admin
 * margin panel) and does NOT decrement customer credits (no ledger/hold, no research_jobs row).
 */
import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod/v4';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { runLlmJson } from '../../lib/research/llm/index.js';
import { withLlmMeter, type MeteredError } from '../../lib/research/llm/meter.js';
import { costFromUsageSummary } from '../../lib/research/engine/pricing.js';
import { logSearch } from '../../lib/research/engine/ledger.js';
import { buildRevisePrompt } from '../../lib/research/reviseAny/prompt.js';
import { reviseDraftSchema } from '../../lib/research/reviseAny/schema.js';

const log = createLogger('route:research:revise');
const router = Router();

const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');

// Abuse guard tier 1 (cheap, first line): each /draft is a house-paid Opus call that does NOT touch
// the customer credit/quota system (no ledger/hold), so nothing else caps its spend. This per-(tenant,
// user) limiter smooths a single caller's burst — deliberately INDEPENDENT of credits. Keyed on
// identity (not IP) so it survives NAT/proxy and can't be evaded by rotating IPs; requireWriter runs
// first, so req.tenantId/req.user are always populated by the time we key here. It is NOT the real
// brake: MemoryStore is process-local (resets every deploy/restart), per-USER (not tenant-wide), and
// 12/min sustained for hours is effectively unbounded HOUSE spend — see the persistent daily cap below.
const draftLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    limit: 12, // interactive rewriting fits comfortably; a runaway loop hits the wall fast
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => `${req.tenantId ?? 'no-tenant'}:${req.user?.id ?? 'no-user'}`,
    message: { error: 'Too many rewrite requests, please slow down and try again shortly' },
});

// Abuse guard tier 2 (persistent, load-bearing): a durable per-TENANT ceiling on house Opus spend
// over a rolling 24h window, backed by the SAME append-only COGS sink every successful draft already
// writes (research_search_log, engine='opus-revise'). This is the brake tier 1 can't be: it survives
// restarts (it's in the DB, not memory), aggregates across all of a tenant's users, and can't be
// out-waited. Still fully INDEPENDENT of the customer credit/quota/hold system — purely a house-spend
// safety fuse. 200/day is generous for interactive rewriting yet caps a runaway loop's dollar damage.
const DAILY_TENANT_CAP = 200;

// Per-entity field WHITELIST (load-bearing security): `field` is client-supplied, so reading an
// arbitrary column would let a caller exfiltrate any column through the echoed draft. Only these
// (entity, field) pairs are ever read/rewritten — every field below is a confirmed free-text field
// on its table (updateIcpSchema / offers updateSchema / updateProjectSchema). Membership is tested
// with hasOwnProperty (never `in`), so a prototype key like "__proto__"/"toString" can't sneak past.
//   • `columns`      — real top-level text columns, read via .select(field).
//   • `profileFields`— free-text keys living INSIDE the profile JSONB column (a fixed enumeration,
//                      NEVER an arbitrary JSONB path): read via .select('profile'), then this one
//                      sub-key is picked. The client persists an applied draft into the same profile
//                      key through the existing PATCH /research/projects/:id (wholesale JSONB replace).
// The number on each field is its REAL PATCH-endpoint maxLength — mirrored into both the draft
// re-validation schema and the prompt so an Apply-able draft is always Save-able (no post-Apply 400).
// what_they_do has no dedicated char cap (only the 20 KB whole-profile cap), so 2000 is a sane bound.
const ENTITY_FIELDS: Record<
    'icp' | 'offer' | 'project',
    { table: string; columns: Record<string, number>; profileFields: Record<string, number> }
> = {
    icp: { table: 'research_icps', columns: { name: 200, segment: 2000, note: 4000 }, profileFields: {} },
    offer: { table: 'research_offers', columns: { pain_hypothesis: 400, value_prop: 500 }, profileFields: {} },
    project: { table: 'research_projects', columns: { name: 200 }, profileFields: { what_they_do: 2000 } },
};

const has = (o: Record<string, number>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

const bodySchema = z.object({
    entity: z.enum(['icp', 'offer', 'project']),
    id: uuidField('Invalid id'),
    field: z.string().min(1).max(64),
    instruction: z.string().min(1).max(2000),
    // The UNSAVED on-screen draft the user is editing. When present it is what the model rewrites —
    // the server no longer silently rewrites the STALE saved DB value. Optional for back-compat; the
    // DB read still runs for existence/tenant/whitelist validation, it just no longer feeds the prompt.
    currentValue: z.string().max(8000).optional(),
});

// ── POST /api/research/revise/draft — rewrite one field, return the draft only ─
router.post('/draft', requireWriter, draftLimiter, validateBody(bodySchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Declared out here so the catch can still log partial COGS if the LLM call spent then threw.
    let usage: Awaited<ReturnType<typeof withLlmMeter>>['usage'] | undefined;
    let cogsPersisted = false;
    const tenantId = req.tenantId!;
    // Persist house COGS to the pure-COGS ledger (research_search_log) so it surfaces in the admin
    // margin panel's search_cost_usd line — same append-only sink search spend uses, and the ONLY
    // admin-visible cost table this route can write to (no research_jobs row exists here by design).
    // Never touches billing/ledger/holds; non-fatal (a logging failure must not fail the draft).
    const persistCogs = async (u: NonNullable<typeof usage>, entity: string, field: string): Promise<void> => {
        if (cogsPersisted) return;
        cogsPersisted = true;
        const cost = costFromUsageSummary(u).totalUsd;
        if (!(cost > 0)) return;
        await logSearch({
            tenantId,
            engine: 'opus-revise',
            query: `revise:${entity}.${field}`, // synthetic marker — never the untrusted instruction
            resultCount: 0,
            cacheHit: false,
            costUsd: cost,
        });
    };
    // Persistent tenant-wide daily brake — checked BEFORE any expensive work (entity read + Opus call).
    // Counts THIS route's own append-only COGS rows over a rolling 24h window (the (tenant_id,
    // created_at) index makes it a cheap covering scan). Fails CLOSED: if the count can't be verified
    // we refuse rather than let unbounded house spend slip through — a brake that silently disables
    // itself on a transient error is no brake, and the entity read below would fail on the same outage
    // anyway, so denying here is no new functional regression. Independent of customer credits/holds.
    const assertUnderDailyCap = async (tid: string): Promise<void> => {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count, error } = await researchSupabaseAdmin
            .from('research_search_log')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tid)
            .eq('engine', 'opus-revise')
            .gte('created_at', since);
        if (error) {
            log.error({ err: error }, 'ai-revise daily-cap check failed');
            throw new AppError('Rewrite temporarily unavailable, please try again shortly', 503);
        }
        if ((count ?? 0) >= DAILY_TENANT_CAP) {
            log.warn({ tenantId: tid, count, cap: DAILY_TENANT_CAP }, 'ai-revise daily tenant cap reached');
            throw new AppError('Daily rewrite limit reached for your workspace, please try again tomorrow', 429);
        }
    };

    try {
        // House-spend fuse first: refuse before the entity read or the Opus call once this tenant has
        // crossed its rolling-24h ceiling. Throws AppError (429/503) → handled by the catch's AppError branch.
        await assertUnderDailyCap(tenantId);

        const { entity, id, field, instruction, currentValue: clientValue } = req.body as z.infer<typeof bodySchema>;

        const spec = ENTITY_FIELDS[entity];
        const isColumn = !!spec && has(spec.columns, field);
        const isProfileField = !!spec && has(spec.profileFields, field);
        if (!spec || (!isColumn && !isProfileField)) {
            res.status(400).json({ error: 'Field is not editable for this entity' });
            return;
        }
        const maxLen = isColumn ? spec.columns[field] : spec.profileFields[field];

        // Tenant-scoped read (service-role client — scoping is mandatory). Top-level columns select
        // the column directly; a profile sub-field selects the whole profile JSONB, then picks the
        // ONE whitelisted key from it (never an arbitrary path — same exfiltration guard as columns).
        const selectCol = isProfileField ? 'profile' : field;
        const { data: row, error: readErr } = await researchSupabaseAdmin
            .from(spec.table)
            .select(selectCol)
            .eq('id', id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (readErr) {
            log.error({ err: readErr }, 'ai-revise field read failed');
            throw new AppError('Failed to generate draft', 500);
        }
        if (!row) {
            res.status(404).json({ error: 'Not found' });
            return;
        }

        // Empty is allowed — the instruction can seed fresh content.
        let rawValue: unknown;
        if (isProfileField) {
            const profile = (row as unknown as Record<string, unknown>).profile;
            rawValue = profile && typeof profile === 'object' && !Array.isArray(profile)
                ? (profile as Record<string, unknown>)[field]
                : undefined;
        } else {
            rawValue = (row as unknown as Record<string, unknown>)[field];
        }
        const dbValue = String(rawValue ?? '');
        // The DB read above is the SECURITY gate (row exists + belongs to tenant + field whitelisted).
        // What the model actually rewrites is the client's UNSAVED on-screen draft when it sent one —
        // otherwise the server would rewrite the stale saved value and silently drop the user's edits.
        const promptValue = clientValue !== undefined ? clientValue : dbValue;
        const { system, messages } = buildRevisePrompt({ entityLabel: entity, fieldLabel: field, currentValue: promptValue, instruction, maxLen });

        // Metered like icp:revise: house Opus spend recorded for the admin margin panel, but there
        // is NO research_jobs row and NO ledger/hold — this must NOT decrement customer quota.
        const metered = await withLlmMeter(async () =>
            runLlmJson('strategy', reviseDraftSchema(maxLen), { system, messages, effort: 'medium', maxTokens: 2000 })
        );
        usage = metered.usage;
        log.info({ entity, field, usage_raw: usage, cost_usd: costFromUsageSummary(usage) }, 'ai-revise COGS');
        // admin-visible COGS (search_cost_usd) — non-fatal: a logging hiccup must not fail a good draft.
        try {
            await persistCogs(usage, entity, field);
        } catch (persistErr) {
            log.warn({ err: persistErr }, 'ai-revise COGS persist failed (non-fatal)');
        }

        // Return ONLY the draft — usage/cost dollars stay in server logs (never echoed to the client).
        res.json({ draft: metered.result.value.draft });
    } catch (err) {
        const partialUsage = usage ?? ((err && typeof err === 'object') ? (err as MeteredError).llmUsage : undefined);
        if (partialUsage && partialUsage.totalCalls > 0) {
            log.warn({ usage_raw: partialUsage }, 'ai-revise failed after spending — partial COGS');
            // Persist the partial spend too — the admin panel should see money that left the building
            // even when the call ultimately failed. Best-effort; a persist failure must not mask err.
            try {
                const b = req.body as Partial<z.infer<typeof bodySchema>>;
                await persistCogs(partialUsage, String(b.entity ?? 'unknown'), String(b.field ?? 'unknown'));
            } catch (persistErr) {
                log.warn({ err: persistErr }, 'ai-revise partial COGS persist failed (non-fatal)');
            }
        }
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'ai-revise error');
        next(new AppError('Failed to generate draft', 500));
    }
});

export default router;
