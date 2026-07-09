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
import { suppressIdentity, dedupeKey, isLeadSuppressed } from './enroll.js';

const log = createLogger('linkedin:seq-engine');

const DAY_MS = 86_400_000;
const DEFAULT_ACCEPT_WAIT_DAYS = 14; // §5: wait 5–15 days for an invite to be accepted
const CAP_RETRY_MS = 6 * 3_600_000;  // reschedule a cap/weekly-skip step by ~6h (coarse backoff)
const HEALTH_RETRY_MS = 30 * 60_000; // account temporarily not-ACTIVE → retry in ~30m

export interface CampaignRow {
    id: string; tenant_id: string; status: string;
    sender_account_ids: string[]; settings: Record<string, unknown>; dry_run: boolean;
}
export interface StepRow { id: string; step_order: number; type: string; wait_days: number; template: string | null }
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
async function updateEnrollment(id: string, patch: Record<string, unknown>, guardState: string | null): Promise<void> {
    let q = researchSupabaseAdmin
        .from('linkedin_enrollments')
        .update({ ...patch, locked_by: null, locked_at: null, updated_at: new Date().toISOString() })
        .eq('id', id);
    if (guardState) q = q.eq('state', guardState);
    const { error } = await q;
    if (error) log.warn({ err: error, enrollmentId: id }, 'enrollment update failed (non-fatal)');
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
        .from('linkedin_sequence_steps').select('id, step_order, type, wait_days, template')
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
    if (await isLeadSuppressed(t, l)) {
        await suppressIdentity(t, l.dedupe_key || dedupeKey(l), 'do_not_contact', l.id);
        await updateEnrollment(enr.id, { state: 'stopped', last_error: 'suppressed' }, g);
        return 'suppressed';
    }

    const rendered = personalize(step.template ?? '', leadVars(l));
    const acceptDeadline = new Date(now + setting(c, 'accept_wait_days', DEFAULT_ACCEPT_WAIT_DAYS) * DAY_MS).toISOString();

    // DRY-RUN campaign: advance the machine, write a traceable audit row, send nothing.
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

    // Real send through the shared executor.
    let outcome;
    try {
        if (isInvite) {
            outcome = await performInvite(account, t, { profileUrn: l.profile_urn, publicId: l.public_id, note: rendered }, jobId);
        } else {
            if (!l.profile_urn) { await updateEnrollment(enr.id, { state: 'failed', last_error: 'no_recipient_urn' }, g); return 'no_recipient_urn'; }
            if (!rendered) { await updateEnrollment(enr.id, { state: 'failed', last_error: 'empty_message' }, g); return 'empty_message'; }
            outcome = await performMessage(account, t, { recipientUrn: l.profile_urn, text: rendered }, jobId);
        }
    } catch (err) {
        // Transport failure — hold + retry (do NOT advance; the network/proxy may recover).
        await updateEnrollment(enr.id, { next_action_at: new Date(now + HEALTH_RETRY_MS).toISOString(), last_error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, g);
        return 'transport_error';
    }

    if (outcome.sent) {
        if (isInvite) {
            // Persist the urn the executor resolved from a public_id, so the message step can
            // address the recipient (codex P1). next_action_at = accept deadline; poll applies
            // the message step's own wait_days when it flips invited→accepted.
            await persistResolvedUrn(t, l.id, outcome.targetUrn);
            await updateEnrollment(enr.id, { state: 'invited', current_step: enr.current_step + 1, next_action_at: acceptDeadline }, g);
        } else if (hasNext) {
            await updateEnrollment(enr.id, { state: 'messaged', current_step: enr.current_step + 1, next_action_at: new Date(now + nextWaitMs).toISOString() }, g);
        } else {
            await updateEnrollment(enr.id, { state: 'completed' }, g);
        }
        return outcome.classifier;
    }

    // Not sent. A rate/cap skip is temporary → reschedule the SAME step. An
    // already-connected invite means we can proceed to messaging. Anything else is a hard fail.
    const skip = outcome.skipped ?? outcome.classifier;
    if (skip === 'daily_cap' || skip === 'weekly_cap' || skip.startsWith('account_')) {
        await updateEnrollment(enr.id, { next_action_at: new Date(now + CAP_RETRY_MS).toISOString(), last_error: skip }, g);
        return skip;
    }
    if (isInvite && outcome.classifier === 'already_connected') {
        // Already connected → advance to the message step, honoring its own wait_days (codex P3).
        await persistResolvedUrn(t, l.id, outcome.targetUrn);
        await updateEnrollment(enr.id, { state: 'accepted', current_step: enr.current_step + 1, next_action_at: new Date(now + nextWaitMs).toISOString() }, g);
        return 'already_connected';
    }
    // restricted / challenge / session_invalid / urn_unresolved / no_target / unknown → fail.
    await updateEnrollment(enr.id, { state: 'failed', last_error: skip }, g);
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
