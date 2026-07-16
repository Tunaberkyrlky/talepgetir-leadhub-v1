/**
 * TG-LinkedIn Faz 4 — the sequence STATE MACHINE (§5).
 *
 * `processEnrollment` executes the CURRENT step of one claimed enrollment and advances it.
 * Steps are ordered (invite / message / wait); the lifecycle state tracks acceptance:
 *
 *   pending ──invite──▶ invited ──(poll: accepted)──▶ accepted ──message──▶ messaged ──▶ …
 *                          │                                                     │
 *                    (accept deadline,                                    (last step)
 *                     no accept) ──▶ completed                         ──▶ completed
 *
 *   any state ──(poll: reply / opt-out)──▶ replied|stopped  (handled by poll + suppression)
 *
 * The real send goes through the shared executor (performInvite/performMessage) so caps,
 * refund and health transitions are identical to the manual single-send path. A dry_run
 * campaign advances the machine + writes a `dry_run` audit row but sends NOTHING.
 *
 * Rate/health skips do NOT advance the step — they reschedule it (the account will recover or
 * the cap will reset). A hard health/data failure fails the enrollment (no infinite retry).
 */
import { researchSupabaseAdmin } from '../../research/supabase.js';
import { createLogger } from '../../logger.js';
import { loadAccount, auditAction, type LinkedInAccountRow } from '../actions.js';
import { performInvite, performMessage } from '../executor.js';
import { personalize } from './personalize.js';
import { parseAiConfig, renderStepText, aiConfigHash, recordAiGenerationCogs } from './aiGenerate.js';
import { withLlmMeter, type MeteredError } from '../../research/llm/meter.js';
import { suppressIdentity, dedupeKey, isLeadSuppressed } from './enroll.js';

const log = createLogger('linkedin:seq-engine');

const DAY_MS = 86_400_000;
const DEFAULT_ACCEPT_WAIT_DAYS = 14; // §5: wait 5–15 days for an invite to be accepted
const CAP_RETRY_MS = 6 * 3_600_000;  // reschedule a cap/weekly-skip step by ~6h (coarse backoff)
const HEALTH_RETRY_MS = 30 * 60_000; // account temporarily not-ACTIVE → retry in ~30m
const AI_GEN_MAX_ATTEMPTS = 8;       // F3: after this many failed generations, fail the lead (no infinite retry)

export interface CampaignRow {
    id: string; tenant_id: string; status: string;
    sender_account_ids: string[]; settings: Record<string, unknown>; dry_run: boolean;
}
export interface StepRow { id: string; step_order: number; type: string; wait_days: number; template: string | null; ai_config: unknown }
export interface LeadRow {
    id: string; profile_urn: string | null; public_id: string | null;
    first_name: string | null; last_name: string | null; company: string | null; title: string | null;
    custom: Record<string, unknown> | null; dedupe_key: string;
}
export interface EnrollmentRow {
    id: string; tenant_id: string; campaign_id: string; lead_id: string; account_id: string | null;
    current_step: number; state: string; next_action_at: string;
}

function setting(c: CampaignRow, key: string, dflt: number): number {
    const v = c.settings?.[key];
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : dflt;
}

/**
 * Update an enrollment and RELEASE the claim lease. OPTIMISTIC-CONCURRENCY guard (codex P2):
 * the tick works from a claim-time snapshot (enr.state) while poll (accept) and suppress (stop)
 * touch the SAME row on separate handlers that the lease does NOT serialize against. So a
 * state-changing write is guarded by `.eq('state', guardState)` — if poll flipped invited→
 * accepted or suppress set stopped/replied since the claim, the tick's write no-ops instead of
 * resurrecting a stopped lead or clobbering a real acceptance. Pass guardState=null only for a
 * pure lease-release (which must always clear the lock regardless of the current state).
 */
async function updateEnrollment(
    id: string, patch: Record<string, unknown>, guardState: string | null, ownerJobId?: string,
): Promise<number> {
    let q = researchSupabaseAdmin
        .from('linkedin_enrollments')
        .update({ ...patch, locked_by: null, locked_at: null, updated_at: new Date().toISOString() })
        .eq('id', id);
    if (guardState) q = q.eq('state', guardState);
    // R2 (ownership fencing): on the AI path an expired lease may have been re-claimed by a NEWER
    // worker mid-tick. Passing ownerJobId adds `.eq('locked_by', jobId)` so this write only lands if
    // WE still own the lease; the caller inspects the matched-row count and bails (lease_lost) on 0.
    if (ownerJobId) q = q.eq('locked_by', ownerJobId);
    const { data, error } = await q.select('id');
    if (error) { log.warn({ err: error, enrollmentId: id }, 'enrollment update failed (non-fatal)'); return 0; }
    return (data ?? []).length;
}

/**
 * F3: the AI-generation FAILURE path. Persists the incremented attempt count in ai_render_cache and
 * either reschedules (transient — a provider outage / fixable prompt may recover) or, once attempts
 * reach the cap, terminally fails the enrollment ('ai_generate_failed_permanent') so a permanently
 * broken step can't retry (and keep re-paying) forever. Releases the lease via updateEnrollment and
 * is guarded by g (optimistic concurrency — a state change since the claim no-ops it).
 */
async function failOrRetryGeneration(
    enrollmentId: string, step: number, configHash: string, attempts: number,
    lastError: string, now: number, guardState: string, jobId: string,
): Promise<string> {
    const cache = { step, config_hash: configHash, attempts };
    // R2: this write happens AFTER generation started, so fence it by locked_by=jobId — a newer
    // worker that re-claimed an expired lease must not have its attempt count / state clobbered.
    if (attempts >= AI_GEN_MAX_ATTEMPTS) {
        const n = await updateEnrollment(enrollmentId, { state: 'failed', last_error: 'ai_generate_failed_permanent', ai_render_cache: cache }, guardState, jobId);
        return n === 0 ? 'lease_lost' : 'ai_generate_failed_permanent';
    }
    const n = await updateEnrollment(enrollmentId, {
        ai_render_cache: cache, last_error: lastError,
        next_action_at: new Date(now + HEALTH_RETRY_MS).toISOString(),
    }, guardState, jobId);
    return n === 0 ? 'lease_lost' : 'ai_generate_failed';
}

/** Persist a urn resolved from a public_id back onto the lead so the later message step (which
 *  needs profile_urn) can address the recipient (codex P1: without this, invite→message breaks
 *  for public-id-only leads). Best-effort; only sets it when the lead had no urn yet. */
async function persistResolvedUrn(tenantId: string, leadId: string, urn: string | null | undefined): Promise<void> {
    if (!urn) return;
    const { error } = await researchSupabaseAdmin
        .from('linkedin_leads').update({ profile_urn: urn, updated_at: new Date().toISOString() })
        .eq('id', leadId).eq('tenant_id', tenantId).is('profile_urn', null);
    if (error) log.warn({ err: error, leadId }, 'persist resolved urn failed (non-fatal)');
}

function leadVars(lead: LeadRow) {
    return { firstName: lead.first_name, lastName: lead.last_name, company: lead.company, title: lead.title, custom: lead.custom };
}

/**
 * Process ONE claimed enrollment. Loads its campaign/steps/lead/account fresh (state may have
 * changed since the claim), runs the current step, and advances. Never throws for a per-lead
 * failure — it records the failure on the enrollment and releases the lease so the tick loop
 * continues with the others. Returns a short outcome tag for the tick's rollup.
 */
export async function processEnrollment(enr: EnrollmentRow, jobId: string): Promise<string> {
    const t = enr.tenant_id;
    const now = Date.now();

    // Every state-changing write below is guarded by g=enr.state (optimistic concurrency —
    // see updateEnrollment): if poll/suppress changed the row since the claim, the tick no-ops.
    const g = enr.state;

    // R4-review (batch-TTL): the tick claims up to ~20 enrollments under ONE ~120s lease and
    // processes them SEQUENTIALLY. A slow item early in the batch (an AI generation can take
    // seconds–minutes) can burn the whole TTL before a LATER item even starts — an overlapping
    // tick then re-claims that item, and without this check both workers would proceed (duplicate
    // send on the non-AI path; double-paid generation on the AI path, whose ownership was only
    // verified post-generation). So BEFORE any other work: atomically verify we still own the
    // lease AND re-up its TTL, fenced by locked_by=jobId + state. 0 rows ⇒ another tick owns it
    // (or the state moved) → return 'lease_lost' immediately, touching nothing. Each item thus
    // starts with a fresh 120s window regardless of how long earlier batch items took. The
    // post-generation renewal further below stays — it guards the long in-item generation window.
    const { data: startRenew, error: startRenewErr } = await researchSupabaseAdmin
        .from('linkedin_enrollments')
        .update({ locked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', enr.id).eq('locked_by', jobId).eq('state', g)
        .select('id');
    if (startRenewErr || !startRenew || startRenew.length === 0) return 'lease_lost';

    // Re-load the campaign: if it paused/archived since the claim, release + leave for later.
    const { data: campaign } = await researchSupabaseAdmin
        .from('linkedin_campaigns').select('id, tenant_id, status, sender_account_ids, settings, dry_run')
        .eq('id', enr.campaign_id).eq('tenant_id', t).maybeSingle();
    if (!campaign || (campaign as CampaignRow).status !== 'active') {
        await updateEnrollment(enr.id, {}, null); // pure lease release (always clear the lock)
        return 'campaign_inactive';
    }
    const c = campaign as CampaignRow;

    // Account must still be present + ACTIVE (claim filtered it, but re-check after the lease TTL).
    if (!enr.account_id) { await updateEnrollment(enr.id, { state: 'failed', last_error: 'no_account' }, g); return 'no_account'; }
    const account: LinkedInAccountRow | null = await loadAccount(t, enr.account_id);
    if (!account) { await updateEnrollment(enr.id, { state: 'failed', last_error: 'account_missing' }, g); return 'account_missing'; }
    if (account.status !== 'ACTIVE') {
        // Not a failure — the account may recover (re-auth). Hold the step and retry later.
        await updateEnrollment(enr.id, { next_action_at: new Date(now + HEALTH_RETRY_MS).toISOString() }, g);
        return 'account_not_active';
    }

    // Load lead + ordered steps.
    const { data: lead } = await researchSupabaseAdmin
        .from('linkedin_leads')
        .select('id, profile_urn, public_id, first_name, last_name, company, title, custom, dedupe_key')
        .eq('id', enr.lead_id).eq('tenant_id', t).maybeSingle();
    if (!lead) { await updateEnrollment(enr.id, { state: 'failed', last_error: 'lead_missing' }, g); return 'lead_missing'; }
    const l = lead as LeadRow;

    const { data: stepRows } = await researchSupabaseAdmin
        .from('linkedin_sequence_steps').select('id, step_order, type, wait_days, template, ai_config')
        .eq('campaign_id', c.id).order('step_order', { ascending: true });
    const steps = (stepRows ?? []) as StepRow[];

    // An 'invited' enrollment that reached its accept deadline without poll flipping it to
    // 'accepted' → the invite was not accepted in the window. End the sequence (§5 branch). The
    // g='invited' guard means a poll accept that raced this write WINS (no dropped acceptance).
    if (enr.state === 'invited') {
        await updateEnrollment(enr.id, { state: 'completed', last_error: 'no_accept' }, g);
        return 'no_accept';
    }

    const step = steps[enr.current_step];
    if (!step) { await updateEnrollment(enr.id, { state: 'completed' }, g); return 'completed'; }
    const hasNext = enr.current_step + 1 < steps.length;
    const nextWaitMs = hasNext ? Math.max(0, steps[enr.current_step + 1].wait_days) * DAY_MS : 0;

    // ── wait step: pause by its OWN wait_days, then advance (codex P3: an explicit wait must
    //    contribute a delay). Reaching it means its pre-delay already elapsed, so on advance we
    //    schedule the next step after the next step's wait_days. ──────────────────────────────
    if (step.type === 'wait') {
        if (!hasNext) { await updateEnrollment(enr.id, { state: 'completed' }, g); return 'completed'; }
        await updateEnrollment(enr.id, { current_step: enr.current_step + 1, next_action_at: new Date(now + nextWaitMs).toISOString() }, g);
        return 'waited';
    }

    // ── invite / message step ─────────────────────────────────────────────────────
    const isInvite = step.type === 'invite';

    // Send-time suppression re-check across ALL of the lead's derivable identity keys: the enroll
    // RPC only checked the lead's stored key, but the same person may have been opted out under a
    // different identifier (Faz-5 review). Stop the whole workspace scope before any send/advance.
    // R1 (fail-CLOSED): a lookup FAULT (isLeadSuppressed throws) leaves suppression UNKNOWN → do NOT
    // send, release the lease + reschedule so a DB blip can't message a suppressed lead.
    let suppressedPre: boolean;
    try {
        suppressedPre = await isLeadSuppressed(t, l);
    } catch {
        await updateEnrollment(enr.id, { next_action_at: new Date(now + HEALTH_RETRY_MS).toISOString(), last_error: 'suppression_check_failed' }, g);
        return 'suppression_check_failed';
    }
    if (suppressedPre) {
        await suppressIdentity(t, l.dedupe_key || dedupeKey(l), 'do_not_contact', l.id);
        await updateEnrollment(enr.id, { state: 'stopped', last_error: 'suppressed' }, g);
        return 'suppressed';
    }

    const acceptDeadline = new Date(now + setting(c, 'accept_wait_days', DEFAULT_ACCEPT_WAIT_DAYS) * DAY_MS).toISOString();

    // DRY-RUN campaign: advance the machine, write a traceable audit row, send nothing. Kept
    // LLM-FREE on purpose — a dry-run tick must not incur per-send generation cost, so the render
    // (AI or plain) is computed only on the real-send path below.
    if (c.dry_run) {
        await auditAction({ tenantId: t, accountId: account.id, type: isInvite ? 'invite' : 'message', status: 'skipped', classifier: 'dry_run', jobId });
        if (isInvite) {
            await updateEnrollment(enr.id, { state: 'invited', current_step: enr.current_step + 1, next_action_at: acceptDeadline }, g);
        } else if (hasNext) {
            await updateEnrollment(enr.id, { state: 'messaged', current_step: enr.current_step + 1, next_action_at: new Date(now + nextWaitMs).toISOString() }, g);
        } else {
            await updateEnrollment(enr.id, { state: 'completed' }, g);
        }
        return 'dry_run';
    }

    // F3: a message step with no resolvable recipient can NEVER be addressed — fail it terminally
    // BEFORE any (paid) generation, so we never pay for text that can't be sent. (An invite can
    // still resolve a urn from public_id at send time, so this only gates message steps.)
    if (!isInvite && !l.profile_urn) {
        await updateEnrollment(enr.id, { state: 'failed', last_error: 'no_recipient_urn' }, g);
        return 'no_recipient_urn';
    }

    // Render the send text NOW (real-send path only). Plain template → personalize (race window is
    // sub-millisecond; unchanged from before). An AI step generates at send-time, which can take
    // seconds–minutes and thus WIDENS every pre-send race — handled below (F1/F2/F3/F5).
    let rendered: string;
    const usedAi = parseAiConfig(step.ai_config).mode !== 'off';
    if (usedAi) {
        const configHash = aiConfigHash(step.type, step.template, step.ai_config);

        // F3: read the enrollment's render cache (the claimed-row snapshot doesn't carry it).
        // R3-review: a read ERROR is NOT a cache miss — treating it as one would trigger a fresh
        // PAID regeneration despite a possibly-valid cached render. Fail closed: fenced reschedule
        // without generating; a real empty cache (no error, no row/field) proceeds to generate.
        const { data: cacheRow, error: cacheErr } = await researchSupabaseAdmin
            .from('linkedin_enrollments').select('ai_render_cache')
            .eq('id', enr.id).eq('tenant_id', t).maybeSingle();
        if (cacheErr) {
            const n = await updateEnrollment(enr.id, { next_action_at: new Date(now + HEALTH_RETRY_MS).toISOString(), last_error: 'ai_cache_read_failed' }, g, jobId);
            return n === 0 ? 'lease_lost' : 'ai_cache_read_failed';
        }
        const cache = ((cacheRow as { ai_render_cache?: Record<string, unknown> } | null)?.ai_render_cache ?? {}) as
            { step?: number; config_hash?: string; rendered?: string; parts?: unknown; attempts?: number };
        const cacheHit = cache.step === enr.current_step && cache.config_hash === configHash;

        if (cacheHit && typeof cache.rendered === 'string' && cache.rendered) {
            // F3: reuse already-paid text — a retry after a cap/lease/transport skip is FREE.
            rendered = cache.rendered;
        } else {
            // Fresh generation, metered so the spend is attributed to the tenant (F5) — including a
            // failure that still cost money (err.llmUsage). `attempts` only carries over while the
            // step + config are unchanged, so an operator edit resets the retry budget.
            const priorAttempts = cacheHit && typeof cache.attempts === 'number' ? cache.attempts : 0;
            let out: Awaited<ReturnType<typeof renderStepText>>;
            let meteredUsage;
            try {
                const metered = await withLlmMeter(() => renderStepText(step, leadVars(l)));
                out = metered.result;
                meteredUsage = metered.usage;
            } catch (err) {
                await recordAiGenerationCogs((err as MeteredError)?.llmUsage, { tenantId: t, accountId: account.id, jobId, leadId: l.id, surface: 'sequence', status: 'error' });
                const msg = err instanceof Error ? err.message : String(err);
                return failOrRetryGeneration(enr.id, enr.current_step, configHash, priorAttempts + 1, `ai_generate_failed: ${msg.slice(0, 200)}`, now, g, jobId);
            }
            rendered = out.rendered;
            if (!rendered) {
                // Residual guard: generateAiText now THROWS LlmError on an empty model output (the
                // paid-empty case routes through the catch above with COGS status 'error'), so
                // reaching here means the render was empty WITHOUT a paid call (e.g. a sections-mode
                // template with no {ai:} token and no static text). recordAiGenerationCogs no-ops on
                // zero metered calls; status 'error' keeps any pathological paid case honest (R6).
                await recordAiGenerationCogs(meteredUsage, { tenantId: t, accountId: account.id, jobId, leadId: l.id, surface: 'sequence', status: 'error' });
                return failOrRetryGeneration(enr.id, enr.current_step, configHash, priorAttempts + 1, 'ai_generate_failed: empty', now, g, jobId);
            }
            // Non-empty paid render — attribute the spend to the tenant as a successful COGS row (F5).
            await recordAiGenerationCogs(meteredUsage, { tenantId: t, accountId: account.id, jobId, leadId: l.id, surface: 'sequence', status: 'ok' });
            // F3: persist the paid render (attempts reset) BEFORE the send, so a send-time skip/crash
            // reuses it next tick instead of regenerating. R2: fenced by locked_by=jobId (AND state=g)
            // — if a newer worker re-claimed an expired lease mid-generation, 0 rows match ⇒ we no
            // longer own it → abandon as lease_lost WITHOUT persisting or sending.
            const { data: cachedRows } = await researchSupabaseAdmin.from('linkedin_enrollments')
                .update({ ai_render_cache: { step: enr.current_step, config_hash: configHash, rendered, parts: out.parts, attempts: 0 }, updated_at: new Date().toISOString() })
                .eq('id', enr.id).eq('state', g).eq('locked_by', jobId)
                .select('id');
            if (!cachedRows || cachedRows.length === 0) return 'lease_lost';
        }

        // Generation widened the window: the campaign/suppression/lease checks done above are now
        // stale. Re-verify lease → campaign → suppression BEFORE sending so a lease we lost, a
        // campaign that paused / flipped to dry_run, or a lead suppressed DURING generation cannot
        // produce a duplicate or unwanted send (F1/F2). (The plain path skips this — its window is
        // sub-millisecond and pre-existing.)
        //
        // (a) Atomically renew the lease. 0 rows ⇒ another worker owns it or the state changed since
        //     the claim → abandon WITHOUT sending and WITHOUT touching the row.
        const { data: renew } = await researchSupabaseAdmin
            .from('linkedin_enrollments')
            .update({ locked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', enr.id).eq('locked_by', jobId).eq('state', g)
            .select('id');
        if (!renew || renew.length === 0) return 'lease_lost';

        // (b) Campaign must STILL be active and NOT have flipped to dry_run since the claim.
        const { data: freshCampaign } = await researchSupabaseAdmin
            .from('linkedin_campaigns').select('status, dry_run').eq('id', c.id).eq('tenant_id', t).maybeSingle();
        const fc = freshCampaign as { status: string; dry_run: boolean } | null;
        if (!fc || fc.status !== 'active' || fc.dry_run !== c.dry_run) {
            // paused/archived or turned dry_run mid-generation → release lease + reschedule, no send.
            // R2: fenced — post-generation, a newer worker may own the row now.
            const n = await updateEnrollment(enr.id, { next_action_at: new Date(now + HEALTH_RETRY_MS).toISOString() }, g, jobId);
            return n === 0 ? 'lease_lost' : 'campaign_changed';
        }

        // (c) Suppression may have landed during generation — stop the whole scope before any send.
        // R1 (fail-CLOSED): a lookup FAULT here leaves suppression UNKNOWN → do NOT send; release the
        // lease + reschedule so a DB blip during the widened window can't message a suppressed lead.
        let suppressedPost: boolean;
        try {
            suppressedPost = await isLeadSuppressed(t, l);
        } catch {
            // R2: fenced — post-generation, a newer worker may own the row now.
            const n = await updateEnrollment(enr.id, { next_action_at: new Date(now + HEALTH_RETRY_MS).toISOString(), last_error: 'suppression_check_failed' }, g, jobId);
            return n === 0 ? 'lease_lost' : 'suppression_check_failed';
        }
        if (suppressedPost) {
            // suppressIdentity runs regardless of lease ownership — the lead IS suppressed and the
            // RPC is idempotent + workspace-scoped; only the enrollment write is fenced (R2).
            await suppressIdentity(t, l.dedupe_key || dedupeKey(l), 'do_not_contact', l.id);
            const n = await updateEnrollment(enr.id, { state: 'stopped', last_error: 'suppressed' }, g, jobId);
            return n === 0 ? 'lease_lost' : 'suppressed';
        }
    } else {
        rendered = personalize(step.template ?? '', leadVars(l));
    }

    // R2: on the AI path fence EVERY post-generation write below by locked_by=jobId — the generation
    // widened the window, so a NEWER worker may have re-claimed an expired lease. A fenced write that
    // matches 0 rows means we no longer own the enrollment → return 'lease_lost' silently (no further
    // writes). The non-AI path passes undefined → unchanged immediate-after-claim behavior.
    const fence = usedAi ? jobId : undefined;

    // Real send through the shared executor.
    let outcome;
    try {
        if (isInvite) {
            outcome = await performInvite(account, t, { profileUrn: l.profile_urn, publicId: l.public_id, note: rendered }, jobId);
        } else {
            // profile_urn is guaranteed non-null here (checked before generation above).
            if (!rendered) { await updateEnrollment(enr.id, { state: 'failed', last_error: 'empty_message' }, g); return 'empty_message'; }
            outcome = await performMessage(account, t, { recipientUrn: l.profile_urn!, text: rendered }, jobId);
        }
    } catch (err) {
        // Transport failure — hold + retry (do NOT advance; the network/proxy may recover).
        const n = await updateEnrollment(enr.id, { next_action_at: new Date(now + HEALTH_RETRY_MS).toISOString(), last_error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, g, fence);
        if (fence && n === 0) return 'lease_lost';
        return 'transport_error';
    }

    if (outcome.sent) {
        if (isInvite) {
            // Persist the urn the executor resolved from a public_id, so the message step can
            // address the recipient (codex P1). next_action_at = accept deadline; poll applies
            // the message step's own wait_days when it flips invited→accepted.
            await persistResolvedUrn(t, l.id, outcome.targetUrn);
            const n = await updateEnrollment(enr.id, { state: 'invited', current_step: enr.current_step + 1, next_action_at: acceptDeadline }, g, fence);
            if (fence && n === 0) return 'lease_lost';
        } else if (hasNext) {
            const n = await updateEnrollment(enr.id, { state: 'messaged', current_step: enr.current_step + 1, next_action_at: new Date(now + nextWaitMs).toISOString() }, g, fence);
            if (fence && n === 0) return 'lease_lost';
        } else {
            const n = await updateEnrollment(enr.id, { state: 'completed' }, g, fence);
            if (fence && n === 0) return 'lease_lost';
        }
        return outcome.classifier;
    }

    // Not sent. A rate/cap skip is temporary → reschedule the SAME step. An
    // already-connected invite means we can proceed to messaging. Anything else is a hard fail.
    // A `lease_*` skip (109 send-lease gate: lease_held / lease_error / lease_mismatch /
    // lease_<acquire-reason>) is ALSO temporary — an in-flight lease self-clears within the short
    // TTL, a transient DB error retries, and a proxy-health/revalidation denial self-corrects once
    // the proxy is revalidated or replaced (same fail-SAFE reschedule as account_* / caps). Hard-
    // failing the enrollment here would lose the lead over a self-clearing condition.
    const skip = outcome.skipped ?? outcome.classifier;
    if (skip === 'daily_cap' || skip === 'weekly_cap' || skip.startsWith('account_') || skip.startsWith('lease_')) {
        const n = await updateEnrollment(enr.id, { next_action_at: new Date(now + CAP_RETRY_MS).toISOString(), last_error: skip }, g, fence);
        if (fence && n === 0) return 'lease_lost';
        return skip;
    }
    if (isInvite && outcome.classifier === 'already_connected') {
        // Already connected → advance to the message step, honoring its own wait_days (codex P3).
        await persistResolvedUrn(t, l.id, outcome.targetUrn);
        const n = await updateEnrollment(enr.id, { state: 'accepted', current_step: enr.current_step + 1, next_action_at: new Date(now + nextWaitMs).toISOString() }, g, fence);
        if (fence && n === 0) return 'lease_lost';
        return 'already_connected';
    }
    // restricted / challenge / session_invalid / urn_unresolved / no_target / unknown → fail.
    const n = await updateEnrollment(enr.id, { state: 'failed', last_error: skip }, g, fence);
    if (fence && n === 0) return 'lease_lost';
    return skip;
}

/**
 * Detect a reply/opt-out for one enrollment's lead and stop+suppress the whole workspace scope.
 * Called by the poll handler with a matched incoming conversation. Idempotent via the RPC.
 */
export async function markReplied(tenantId: string, lead: LeadRow): Promise<void> {
    const key = lead.dedupe_key || dedupeKey(lead);
    await suppressIdentity(tenantId, key, 'replied', lead.id);
    log.info({ tenantId, leadId: lead.id }, 'linkedin poll: reply detected → suppressed + stopped');
}
