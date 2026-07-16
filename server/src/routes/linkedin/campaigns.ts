/**
 * TG-LinkedIn Faz 4 — campaign / sequence / lead / enrollment / suppression routes
 * (mounted under /api/linkedin, behind authMiddleware). Service-role reads scoped by
 * req.tenantId; the sequence engine (worker) does the sending. Campaigns are dry_run by
 * default — activating one does NOT send until dry_run is explicitly turned off.
 */
import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod/v4';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { enqueueJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPES } from '../../lib/research/jobTypes.js';
import { dedupeKey, enrollLead, pickSenderForEnroll, suppressIdentity } from '../../lib/linkedin/sequences/enroll.js';
import { ensureRetentionLoop } from '../../lib/research/worker/handlers/linkedinRetention.js';
import { AiConfigSchema, renderStepText, parseAiConfig, validateStepAi, recordAiGenerationCogs } from '../../lib/linkedin/sequences/aiGenerate.js';
import type { PersonalizeVars } from '../../lib/linkedin/sequences/personalize.js';
import { withLlmMeter, type MeteredError } from '../../lib/research/llm/meter.js';
import { LlmError } from '../../lib/research/llm/types.js';

const log = createLogger('route:linkedin:campaigns');
const router = Router();
const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');

// ── F4: the step preview triggers a LIVE, paid LLM call, so it needs its own throttle on top of
// requireWriter — otherwise one operator could burn unbounded spend. Two layers: a per-user burst
// limiter (10/min) and a per-tenant DAILY spend cap. ────────────────────────────────────────────
const aiPreviewLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => req.user?.id ?? req.tenantId ?? 'anon',
    message: { error: 'Too many preview requests, slow down' },
});

// R4: per-tenant daily preview cap. DURABLE (Postgres) — survives a restart AND holds across
// horizontally-scaled instances, unlike the old in-memory map (each instance would have granted the
// full cap). The atomic take lives in the linkedin_ai_preview_take RPC (mig 145); the route calls it
// fail-CLOSED (an RPC error → deny, no free generation).
const PREVIEW_DAILY_CAP = Math.max(1, Number(process.env.LINKEDIN_AI_PREVIEW_DAILY_CAP) || 200);

const isUuid = (id: string) => uuidField().safeParse(id).success;

/** Verify all account ids belong to this tenant (senders can't reference another tenant's account). */
async function assertOwnedAccounts(tenantId: string, ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const { data, error } = await researchSupabaseAdmin
        .from('linkedin_accounts').select('id').eq('tenant_id', tenantId).in('id', ids);
    if (error) throw new AppError('Failed to verify accounts', 500);
    return (data ?? []).length === ids.length;
}

/**
 * Seed the per-tenant tick loop + a per-account poll loop, each only if one isn't queued.
 * KNOWN P3 (accepted): the check-then-enqueue isn't atomic, so two exactly-simultaneous
 * activations could each seed a loop. This is safe (the claim RPC keeps sends paced + non-
 * duplicated; poll is read-only), and the tick's reseedDroppedPolls uses the same guard — the
 * cost is at most a little extra background polling, not double-send.
 */
async function seedLoops(tenantId: string, senderIds: string[]): Promise<void> {
    const { data: existingTick } = await researchSupabaseAdmin
        .from('research_jobs').select('id')
        .eq('tenant_id', tenantId).eq('type', RESEARCH_JOB_TYPES.LINKEDIN_SEQUENCE_TICK)
        .in('status', ['queued', 'running']).limit(1);
    if (!existingTick || existingTick.length === 0) {
        await enqueueJob({ tenantId, type: RESEARCH_JOB_TYPES.LINKEDIN_SEQUENCE_TICK, payload: {}, maxAttempts: 1 });
    }
    // Faz 5: kick the daily PII-retention loop (self-heals + reseeds thereafter). Seed it NOW
    // (delay 0) so activation starts the compliance clock immediately.
    await ensureRetentionLoop(tenantId, 0);
    for (const accountId of senderIds) {
        const { data: existingPoll } = await researchSupabaseAdmin
            .from('research_jobs').select('id')
            .eq('tenant_id', tenantId).eq('type', RESEARCH_JOB_TYPES.LINKEDIN_POLL)
            .filter('payload->>account_id', 'eq', accountId)
            .in('status', ['queued', 'running']).limit(1);
        if (!existingPoll || existingPoll.length === 0) {
            await enqueueJob({ tenantId, type: RESEARCH_JOB_TYPES.LINKEDIN_POLL, payload: { account_id: accountId }, maxAttempts: 1 });
        }
    }
}

// ── Campaigns ─────────────────────────────────────────────────────────────────
const campaignCreate = z.object({
    name: z.string().min(1).max(200),
    sender_account_ids: z.array(uuidField()).max(50).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    dry_run: z.boolean().optional(),
});

router.post('/', requireWriter, validateBody(campaignCreate), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const b = req.body as z.infer<typeof campaignCreate>;
        const senders = b.sender_account_ids ?? [];
        if (!(await assertOwnedAccounts(tenantId, senders))) { res.status(400).json({ error: 'sender_account_ids include an account not in this tenant' }); return; }
        const { data, error } = await researchSupabaseAdmin.from('linkedin_campaigns').insert({
            tenant_id: tenantId, name: b.name, sender_account_ids: senders,
            settings: b.settings ?? {}, dry_run: b.dry_run ?? true, created_by: req.user?.id ?? null,
        }).select('*').single();
        if (error) throw new AppError('Failed to create campaign', 500);
        res.status(201).json({ data });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'create campaign'); next(new AppError('Failed to create campaign', 500)); }
});

router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { data, error } = await researchSupabaseAdmin.from('linkedin_campaigns')
            .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false });
        if (error) throw new AppError('Failed to list campaigns', 500);
        res.json({ data: data ?? [] });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'list campaigns'); next(new AppError('Failed to list campaigns', 500)); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!; const id = String(req.params.id);
        if (!isUuid(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
        const { data: campaign, error } = await researchSupabaseAdmin.from('linkedin_campaigns')
            .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        if (error) throw new AppError('Failed to read campaign', 500);
        if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
        const { data: steps } = await researchSupabaseAdmin.from('linkedin_sequence_steps')
            .select('*').eq('campaign_id', id).order('step_order', { ascending: true });
        // Enrollment state rollup.
        const { data: enr } = await researchSupabaseAdmin.from('linkedin_enrollments')
            .select('state').eq('campaign_id', id);
        const counts: Record<string, number> = {};
        for (const e of enr ?? []) { const s = (e as { state: string }).state; counts[s] = (counts[s] ?? 0) + 1; }
        res.json({ campaign, steps: steps ?? [], enrollment_counts: counts });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'get campaign'); next(new AppError('Failed to read campaign', 500)); }
});

const campaignPatch = z.object({
    name: z.string().min(1).max(200).optional(),
    sender_account_ids: z.array(uuidField()).max(50).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    dry_run: z.boolean().optional(),
});
router.patch('/:id', requireWriter, validateBody(campaignPatch), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!; const id = String(req.params.id);
        if (!isUuid(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
        const b = req.body as z.infer<typeof campaignPatch>;
        const patch: Record<string, unknown> = {};
        if (b.name !== undefined) patch.name = b.name;
        if (b.settings !== undefined) patch.settings = b.settings;
        if (b.dry_run !== undefined) patch.dry_run = b.dry_run;
        if (b.sender_account_ids !== undefined) {
            if (!(await assertOwnedAccounts(tenantId, b.sender_account_ids))) { res.status(400).json({ error: 'sender_account_ids include an account not in this tenant' }); return; }
            patch.sender_account_ids = b.sender_account_ids;
        }
        if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'No updatable fields' }); return; }
        const { data, error } = await researchSupabaseAdmin.from('linkedin_campaigns')
            .update(patch).eq('id', id).eq('tenant_id', tenantId).select('*').maybeSingle();
        if (error) throw new AppError('Failed to update campaign', 500);
        if (!data) { res.status(404).json({ error: 'Campaign not found' }); return; }
        res.json({ data });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'patch campaign'); next(new AppError('Failed to update campaign', 500)); }
});

router.post('/:id/activate', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!; const id = String(req.params.id);
        if (!isUuid(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
        const { data: campaign, error } = await researchSupabaseAdmin.from('linkedin_campaigns')
            .update({ status: 'active' }).eq('id', id).eq('tenant_id', tenantId)
            .not('status', 'eq', 'archived').select('*').maybeSingle();
        if (error) throw new AppError('Failed to activate campaign', 500);
        if (!campaign) { res.status(404).json({ error: 'Campaign not found or archived' }); return; }
        await seedLoops(tenantId, (campaign as { sender_account_ids: string[] }).sender_account_ids ?? []);
        res.json({ data: campaign });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'activate campaign'); next(new AppError('Failed to activate campaign', 500)); }
});

// ── Faz 5: enrollment list for the campaign detail UI ───────────────────────────
const ENROLLMENT_STATES = ['pending', 'invited', 'accepted', 'messaged', 'replied', 'stopped', 'failed', 'completed'] as const;

/** Clamped non-negative int from a query param; `fallback` when absent/garbage. */
function intParam(v: unknown, fallback: number, max: number): number {
    const n = Number(typeof v === 'string' ? v : NaN);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(Math.floor(n), max);
}

router.get('/:id/enrollments', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!; const id = String(req.params.id);
        if (!isUuid(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
        const { data: campaign, error: cErr } = await researchSupabaseAdmin.from('linkedin_campaigns')
            .select('id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        if (cErr) throw new AppError('Failed to list enrollments', 500);
        if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }

        const limit = Math.max(1, intParam(req.query.limit, 50, 200));
        const offset = intParam(req.query.offset, 0, 100_000);
        const state = typeof req.query.state === 'string' && (ENROLLMENT_STATES as readonly string[]).includes(req.query.state)
            ? req.query.state : null;

        let q = researchSupabaseAdmin.from('linkedin_enrollments')
            .select('id, state, current_step, next_action_at, last_error, account_id, lead_id, created_at, updated_at, '
                + 'linkedin_leads!inner(first_name, last_name, company, title, public_id, profile_urn)', { count: 'exact' })
            .eq('campaign_id', id).eq('tenant_id', tenantId);
        if (state) q = q.eq('state', state);
        // Order by the IMMUTABLE created_at (not updated_at): the tick bumps updated_at on every
        // processed row, which would reshuffle offset pages under a polling client and duplicate/
        // skip rows across pages (Faz-5 review P3). created_at gives stable pagination.
        const { data, error, count } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new AppError('Failed to list enrollments', 500);
        res.json({ data: data ?? [], total: count ?? 0, limit, offset });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'list enrollments'); next(new AppError('Failed to list enrollments', 500)); }
});

// ── Faz 5: archive — terminal shelf; only from draft/paused (pause an active one first) ──
router.post('/:id/archive', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!; const id = String(req.params.id);
        if (!isUuid(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
        const { data, error } = await researchSupabaseAdmin.from('linkedin_campaigns')
            .update({ status: 'archived' }).eq('id', id).eq('tenant_id', tenantId)
            .in('status', ['draft', 'paused']).select('*').maybeSingle();
        if (error) throw new AppError('Failed to archive campaign', 500);
        if (!data) { res.status(409).json({ error: 'Campaign not found, already archived, or still active (pause it first)' }); return; }
        // Archive is terminal + irreversible: the claim RPC only advances enrollments in an ACTIVE
        // campaign, so any non-terminal enrollment left here would freeze its lead forever (blocked
        // from other campaigns by one-active-campaign, and exempt from retention purge). Stop them so
        // the leads are free to re-enroll and the purge treats them as terminal. (No suppression —
        // archiving is not an opt-out.)
        const { error: stopErr } = await researchSupabaseAdmin.from('linkedin_enrollments')
            .update({ state: 'stopped', last_error: 'campaign_archived', updated_at: new Date().toISOString() })
            .eq('campaign_id', id).eq('tenant_id', tenantId)
            .in('state', ['pending', 'invited', 'accepted', 'messaged']);
        if (stopErr) log.warn({ err: stopErr, id }, 'archive: failed to stop enrollments (non-fatal)');
        res.json({ data });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'archive campaign'); next(new AppError('Failed to archive campaign', 500)); }
});

router.post('/:id/pause', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!; const id = String(req.params.id);
        if (!isUuid(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
        const { data, error } = await researchSupabaseAdmin.from('linkedin_campaigns')
            .update({ status: 'paused' }).eq('id', id).eq('tenant_id', tenantId).eq('status', 'active').select('*').maybeSingle();
        if (error) throw new AppError('Failed to pause campaign', 500);
        if (!data) { res.status(404).json({ error: 'Campaign not found or not active' }); return; }
        res.json({ data });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'pause campaign'); next(new AppError('Failed to pause campaign', 500)); }
});

// ── Sequence steps — replace the whole ordered list ─────────────────────────────
const stepsReplace = z.object({
    steps: z.array(z.object({
        type: z.enum(['invite', 'message', 'wait']),
        wait_days: z.number().min(0).max(90).optional(),
        template: z.string().max(8000).optional().nullable(),
        // Validated strictly below (not here) so a present-but-malformed config 400s instead of
        // silently passing an arbitrary object through to the RPC.
        ai_config: z.unknown().optional(),
    })).max(20),
});
router.put('/:id/steps', requireWriter, validateBody(stepsReplace), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!; const id = String(req.params.id);
        if (!isUuid(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
        const { data: campaign, error: cErr } = await researchSupabaseAdmin.from('linkedin_campaigns')
            .select('id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        if (cErr) throw new AppError('Failed to save steps', 500);
        if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
        const b = req.body as z.infer<typeof stepsReplace>;
        // STRICT-validate each step (F7/F8): a present-but-broken config, a malformed {ai:} token, a
        // referenced section with no prompt, or a template {ai:key} with no matching section is an
        // operator error → 400 naming the step index (never a silent degrade — that only happens
        // later at engine read-time for legacy/edge rows).
        const p_steps: Array<Record<string, unknown>> = [];
        for (let i = 0; i < b.steps.length; i++) {
            const s = b.steps[i];
            const problem = validateStepAi(s.template ?? null, s.ai_config);
            if (problem) { res.status(400).json({ error: `steps[${i}]: ${problem}` }); return; }
            // validateStepAi already proved this parses; store the normalized config (or {} when absent).
            const ai_config = (s.ai_config === undefined || s.ai_config === null) ? {} : AiConfigSchema.parse(s.ai_config);
            p_steps.push({ type: s.type, wait_days: s.wait_days ?? 0, template: s.template ?? null, ai_config });
        }
        // Atomic replace via RPC (delete+insert in one txn): a non-transactional delete-then-insert
        // let a concurrent sequence-tick read [] mid-edit and terminally 'complete' live enrollments.
        const { data: count, error } = await researchSupabaseAdmin.rpc('linkedin_replace_steps', {
            p_tenant: tenantId, p_campaign: id, p_steps,
        });
        if (error) throw new AppError('Failed to save steps', 500);
        res.json({ ok: true, count: count ?? b.steps.length });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'put steps'); next(new AppError('Failed to save steps', 500)); }
});

// ── Preview a step's rendered text (AI runs LIVE — this is the paid preview) ─────
// requireWriter is the cost gate. With a lead_id we render against that real lead; otherwise a
// sample persona so the operator can preview before importing leads.
const stepPreviewBody = z.object({
    step: z.object({
        type: z.enum(['invite', 'message']),
        template: z.string().max(8000).optional().nullable(),
        ai_config: z.unknown().optional(),
    }),
    lead_id: uuidField().optional(),
});
router.post('/:id/steps/preview', requireWriter, aiPreviewLimiter, validateBody(stepPreviewBody), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!; const id = String(req.params.id);
        if (!isUuid(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
        const { data: campaign, error: cErr } = await researchSupabaseAdmin.from('linkedin_campaigns')
            .select('id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        if (cErr) throw new AppError('Failed to preview step', 500);
        if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
        const b = req.body as z.infer<typeof stepPreviewBody>;

        // F7: strict-validate here too — never silently render a broken config as 'off'.
        const problem = validateStepAi(b.step.template ?? null, b.step.ai_config);
        if (problem) { res.status(400).json({ error: problem }); return; }

        // F4/R4: a preview that will actually call the LLM consumes the per-tenant daily budget via
        // the durable atomic RPC. An 'off' preview is free and never counted. Fail-CLOSED: an RPC
        // error denies (503) rather than granting a free generation.
        const willGenerate = parseAiConfig(b.step.ai_config).mode !== 'off';
        if (willGenerate) {
            const { data: took, error: takeErr } = await researchSupabaseAdmin
                .rpc('linkedin_ai_preview_take', { p_tenant: tenantId, p_cap: PREVIEW_DAILY_CAP });
            if (takeErr) {
                log.error({ err: takeErr, tenantId }, 'preview daily-cap take failed (fail-closed)');
                res.status(503).json({ error: 'AI preview temporarily unavailable, try again shortly' });
                return;
            }
            if (took !== true) {
                res.status(429).json({ error: `Daily AI preview limit reached (${PREVIEW_DAILY_CAP} per day). Try again after 00:00 UTC.` });
                return;
            }
        }

        let vars: PersonalizeVars;
        if (b.lead_id) {
            const { data: lead, error: lErr } = await researchSupabaseAdmin.from('linkedin_leads')
                .select('first_name, last_name, company, title, custom')
                .eq('id', b.lead_id).eq('tenant_id', tenantId).maybeSingle();
            if (lErr) throw new AppError('Failed to preview step', 500);
            if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
            const l = lead as { first_name: string | null; last_name: string | null; company: string | null; title: string | null; custom: Record<string, unknown> | null };
            vars = { firstName: l.first_name, lastName: l.last_name, company: l.company, title: l.title, custom: l.custom };
        } else {
            vars = { firstName: 'Ayşe', lastName: 'Yılmaz', company: 'Acme GmbH', title: 'Purchasing Manager', custom: {} };
        }

        // F5: meter the generation so the paid spend is attributed to the tenant on linkedin_actions
        // (type 'ai_generate', no account/job). recordAiGenerationCogs no-ops for an 'off' preview
        // (zero metered calls), and still records a FAILED-but-paid run via err.llmUsage.
        let out;
        try {
            const metered = await withLlmMeter(() => renderStepText({ type: b.step.type, template: b.step.template ?? null, ai_config: b.step.ai_config }, vars));
            out = metered.result;
            await recordAiGenerationCogs(metered.usage, { tenantId, accountId: null, jobId: null, surface: 'preview', status: 'ok' });
        } catch (err) {
            await recordAiGenerationCogs((err as MeteredError)?.llmUsage, { tenantId, accountId: null, jobId: null, surface: 'preview', status: 'error' });
            // A live-generation failure is an upstream provider fault, not a bug in this request —
            // surface it as 502 with a clear message so the UI can say "try again" (not a generic 500).
            if (err instanceof LlmError) { res.status(502).json({ error: `AI generation failed: ${err.message.slice(0, 250)}` }); return; }
            throw err;
        }

        const warnings: string[] = [];
        if (b.step.type === 'invite' && out.rendered.length > 300) warnings.push('invite_note_over_300');
        // A 'sections' config whose template has no {ai:...} slot means the generated sections are
        // computed but never spliced in — a likely operator mistake worth flagging.
        if (out.parts.sections && !/\{ai:[a-z][a-z0-9_]{0,29}\}/.test(b.step.template ?? '')) warnings.push('no_ai_token_in_template');

        res.json({ rendered: out.rendered, parts: out.parts, char_count: out.rendered.length, warnings });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'preview step'); next(new AppError('Failed to preview step', 500)); }
});

// ── Leads — create (single or bulk), upsert by dedupe_key ───────────────────────
const leadInput = z.object({
    profile_urn: z.string().max(200).optional().nullable(),
    public_id: z.string().max(200).optional().nullable(),
    first_name: z.string().max(200).optional().nullable(),
    last_name: z.string().max(200).optional().nullable(),
    company: z.string().max(300).optional().nullable(),
    title: z.string().max(300).optional().nullable(),
    source: z.string().max(60).optional().nullable(),
    custom: z.record(z.string(), z.unknown()).optional(),
});
const leadsCreate = z.object({ leads: z.array(leadInput).min(1).max(500) });

// ── Enroll leads into a campaign (rotation + suppression via RPC) ───────────────
const enrollBody = z.object({ lead_ids: z.array(uuidField()).min(1).max(500) });
router.post('/:id/enroll', requireWriter, validateBody(enrollBody), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!; const id = String(req.params.id);
        if (!isUuid(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
        const { data: campaign, error: cErr } = await researchSupabaseAdmin.from('linkedin_campaigns')
            .select('id, status, sender_account_ids').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        if (cErr) throw new AppError('Failed to enroll', 500);
        if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
        // Reject enroll into an archived campaign: archive is irreversible and its enrollments are
        // never claimed, so the leads would be frozen non-terminal forever (mirrors activate's guard).
        if ((campaign as { status: string }).status === 'archived') { res.status(409).json({ error: 'Campaign is archived' }); return; }
        const senders = (campaign as { sender_account_ids: string[] }).sender_account_ids ?? [];
        if (senders.length === 0) { res.status(400).json({ error: 'Campaign has no sender accounts' }); return; }

        const { lead_ids } = req.body as z.infer<typeof enrollBody>;
        const results: Array<{ lead_id: string; enrolled: boolean; reason: string }> = [];
        for (const leadId of lead_ids) {
            const accountId = await pickSenderForEnroll(tenantId, senders);
            if (!accountId) { results.push({ lead_id: leadId, enrolled: false, reason: 'no_sender' }); continue; }
            const r = await enrollLead(tenantId, id, leadId, accountId, new Date());
            results.push({ lead_id: leadId, enrolled: r.enrolled, reason: r.reason });
        }
        const enrolled = results.filter((r) => r.enrolled).length;
        res.status(202).json({ enrolled, total: lead_ids.length, results });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'enroll'); next(new AppError('Failed to enroll', 500)); }
});

// ── Suppression — add + list ────────────────────────────────────────────────────
const suppressBody = z.object({
    dedupe_key: z.string().min(1).max(400).optional(),
    lead_id: uuidField().optional(),
    reason: z.enum(['opted_out', 'do_not_contact', 'manual', 'connected', 'bounced']).default('do_not_contact'),
}).refine((b) => !!b.dedupe_key || !!b.lead_id, { message: 'dedupe_key or lead_id required' });

export default router;

// ── Leads + suppression get their own small router (mounted beside campaigns) ────
export const leadsRouter = Router();
leadsRouter.post('/leads', requireWriter, validateBody(leadsCreate), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { leads } = req.body as z.infer<typeof leadsCreate>;
        // Dedupe the batch by dedupe_key FIRST (last write wins): Postgres ON CONFLICT rejects a
        // single statement that touches the same conflict target twice, which would 500 the whole
        // batch on an in-request duplicate identity (codex P2). Keep one row per key.
        const byKey = new Map<string, Record<string, unknown>>();
        for (const l of leads) {
            byKey.set(dedupeKey(l), {
                tenant_id: tenantId, profile_urn: l.profile_urn ?? null, public_id: l.public_id ?? null,
                first_name: l.first_name ?? null, last_name: l.last_name ?? null,
                company: l.company ?? null, title: l.title ?? null, source: l.source ?? 'manual',
                custom: l.custom ?? {}, created_by: req.user?.id ?? null,
                dedupe_key: dedupeKey(l),
            });
        }
        const keys = [...byKey.keys()];
        // Return the EXISTING row for a known identity untouched — an identity-only re-import (the
        // AddLeadsModal default, bare profile URLs) must NOT null out prior enrichment. So insert
        // only the keys we don't already have (ON CONFLICT DO NOTHING guards a concurrent insert).
        // (Faz-5 review P2: upsert-all was overwriting name/company.)
        const { data: existing, error: exErr } = await researchSupabaseAdmin.from('linkedin_leads')
            .select('dedupe_key').eq('tenant_id', tenantId).in('dedupe_key', keys);
        if (exErr) throw new AppError('Failed to create leads', 500);
        const existingKeys = new Set((existing ?? []).map((r) => (r as { dedupe_key: string }).dedupe_key));
        const toInsert = keys.filter((k) => !existingKeys.has(k)).map((k) => byKey.get(k)!);
        if (toInsert.length > 0) {
            const { error } = await researchSupabaseAdmin.from('linkedin_leads')
                .upsert(toInsert, { onConflict: 'tenant_id,dedupe_key', ignoreDuplicates: true });
            if (error) throw new AppError('Failed to create leads', 500);
        }
        // Final read of ALL requested keys — reflects committed rows regardless of who inserted
        // them, so a row raced-in by a concurrent request (ON CONFLICT DO NOTHING returns nothing
        // for it) is still returned to this caller and its id is available to the chained enroll
        // (Faz-5 fix-review P3: assembling existing∪inserted dropped the raced key).
        const { data, error: readErr } = await researchSupabaseAdmin.from('linkedin_leads')
            .select('id, dedupe_key, public_id, profile_urn').eq('tenant_id', tenantId).in('dedupe_key', keys);
        if (readErr) throw new AppError('Failed to create leads', 500);
        res.status(201).json({ data: data ?? [], count: (data ?? []).length });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'create leads'); next(new AppError('Failed to create leads', 500)); }
});

leadsRouter.get('/suppression', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { data, error } = await researchSupabaseAdmin.from('linkedin_suppression')
            .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(500);
        if (error) throw new AppError('Failed to list suppression', 500);
        res.json({ data: data ?? [] });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'list suppression'); next(new AppError('Failed to list suppression', 500)); }
});

// ── Faz 5: lead list (search + pagination) for the campaign builder ─────────────
leadsRouter.get('/leads', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const limit = Math.max(1, intParam(req.query.limit, 50, 200));
        const offset = intParam(req.query.offset, 0, 100_000);
        // PostgREST .or() is comma/paren-delimited — strip those + wildcards from the needle.
        const rawQ = typeof req.query.q === 'string' ? req.query.q : '';
        const needle = rawQ.replace(/[,()%*]/g, ' ').trim().slice(0, 80);

        let q = researchSupabaseAdmin.from('linkedin_leads')
            .select('id, first_name, last_name, company, title, public_id, profile_urn, source, dedupe_key, created_at', { count: 'exact' })
            .eq('tenant_id', tenantId);
        if (needle) {
            q = q.or(`first_name.ilike.%${needle}%,last_name.ilike.%${needle}%,company.ilike.%${needle}%,public_id.ilike.%${needle}%`);
        }
        const { data, error, count } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new AppError('Failed to list leads', 500);
        res.json({ data: data ?? [], total: count ?? 0, limit, offset });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'list leads'); next(new AppError('Failed to list leads', 500)); }
});

// ── Faz 5: unified inbox v2 — who replied, where, from which sender ─────────────
// Reply CONTENT is not stored (the poll's reply signal is a conversation-level heuristic and
// scraped DMs would be more PII than we want at rest) — the row deep-links to the profile.
leadsRouter.get('/inbox', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { data, error } = await researchSupabaseAdmin.from('linkedin_enrollments')
            .select('id, state, updated_at, campaign_id, account_id, '
                + 'linkedin_leads!inner(first_name, last_name, company, title, public_id, profile_urn), '
                + 'linkedin_campaigns!inner(name), linkedin_accounts(name, public_id)')
            .eq('tenant_id', tenantId).eq('state', 'replied')
            .order('updated_at', { ascending: false }).limit(100);
        if (error) throw new AppError('Failed to list inbox', 500);
        res.json({ data: data ?? [] });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'list inbox'); next(new AppError('Failed to list inbox', 500)); }
});

// ── Faz 5: remove a suppression row — MANUAL entries only ───────────────────────
// Compliance guard: opted_out/replied stay forever (a person's stop request can't be undone by
// an operator click); connected/bounced are system facts. Only operator-added rows are removable.
leadsRouter.delete('/suppression/:id', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!; const id = String(req.params.id);
        if (!isUuid(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
        const { data: row, error: rErr } = await researchSupabaseAdmin.from('linkedin_suppression')
            .select('id, reason').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        if (rErr) throw new AppError('Failed to remove suppression', 500);
        if (!row) { res.status(404).json({ error: 'Suppression entry not found' }); return; }
        if (!['manual', 'do_not_contact'].includes((row as { reason: string }).reason)) {
            res.status(403).json({ error: 'Only manual/do_not_contact entries can be removed' }); return;
        }
        const { error } = await researchSupabaseAdmin.from('linkedin_suppression')
            .delete().eq('id', id).eq('tenant_id', tenantId);
        if (error) throw new AppError('Failed to remove suppression', 500);
        res.json({ ok: true });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'delete suppression'); next(new AppError('Failed to remove suppression', 500)); }
});

// ── Faz 5: manual retention run (internal ops only; the loop normally self-drives) ──
const retentionBody = z.object({ retention_days: z.number().int().min(30).max(365).optional() });
leadsRouter.post('/retention/run', requireRole('superadmin', 'ops_agent'), validateBody(retentionBody), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const b = req.body as z.infer<typeof retentionBody>;
        const job = await enqueueJob({
            tenantId, type: RESEARCH_JOB_TYPES.LINKEDIN_RETENTION,
            payload: b.retention_days ? { retention_days: b.retention_days } : {},
            maxAttempts: 1, createdBy: req.user?.id ?? null,
        });
        res.status(202).json({ id: (job as { id: string }).id, type: RESEARCH_JOB_TYPES.LINKEDIN_RETENTION });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'retention run'); next(new AppError('Failed to enqueue retention', 500)); }
});

leadsRouter.post('/suppression', requireWriter, validateBody(suppressBody), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const b = req.body as z.infer<typeof suppressBody>;
        let key = b.dedupe_key ?? null;
        let leadId = b.lead_id ?? null;
        if (!key && leadId) {
            const { data: lead } = await researchSupabaseAdmin.from('linkedin_leads')
                .select('dedupe_key').eq('id', leadId).eq('tenant_id', tenantId).maybeSingle();
            if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
            key = (lead as { dedupe_key: string }).dedupe_key;
        }
        if (!key) { res.status(400).json({ error: 'dedupe_key or a valid lead_id required' }); return; }
        // A retention-anonymized lead carries a 'purged:<id>' key — suppressing THAT would record a
        // meaningless identity-free row and leave the real person re-contactable (the purge frees
        // the original identity). Reject so the operator re-imports + suppresses the real identity.
        if (key.startsWith('purged:')) { res.status(409).json({ error: 'Lead PII was purged; suppress by profile id/URN instead' }); return; }
        const r = await suppressIdentity(tenantId, key, b.reason, leadId);
        res.status(201).json({ data: r });
    } catch (err) { if (err instanceof AppError) return next(err); log.error({ err }, 'add suppression'); next(new AppError('Failed to add suppression', 500)); }
});
