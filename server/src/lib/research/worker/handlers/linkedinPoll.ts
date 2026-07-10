/**
 * linkedin:poll — detect invite ACCEPTS + REPLIES for one account's active enrollments (§5).
 *
 * Read-only against the account, then two state effects:
 *   - accept: an 'invited' enrollment whose lead is now a 1st-degree connection → 'accepted',
 *     scheduled after the message step's own wait_days (the §5 post-accept delay).
 *   - reply:  an active enrollment whose lead sent an incoming message → suppress + stop the
 *     whole workspace scope (§5 global stop).
 *
 * The poll loop is per-account and self-perpetuating (~3h, §2): it re-enqueues the next poll
 * whenever the account still has invited/messaged enrollments — INCLUDING when the account is
 * transiently non-ACTIVE (codex P2: otherwise a single de-activation silently kills accept AND
 * reply detection forever). The tick also re-seeds a dropped poll loop as a backstop.
 *
 * The connections/conversations voyager reads are a HOT-SURFACE that is UNVERIFIED against a
 * live account; reply detection is best-effort (unread-count heuristic) and fail-safe (a missed
 * reply keeps sending; a false reply merely stops early — the safe direction for suppression).
 */
import type { JobHandler } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { createLogger } from '../../../logger.js';
import { enqueueJob } from '../../queue.js';
import { RESEARCH_JOB_TYPES } from '../../jobTypes.js';
import { loadAccount, credsFor, resolveDispatcher, classifierForHttp, applyWriteHealth, auditAction } from '../../../linkedin/actions.js';
import { listConnections, listConversations } from '../../../linkedin/client.js';
import { markReplied, type LeadRow } from '../../../linkedin/sequences/engine.js';

const log = createLogger('research:handler:linkedin-poll');
const POLL_INTERVAL_MS = 3 * 3_600_000; // §2 inbox poll cadence ~3h
const DAY_MS = 86_400_000;

interface EnrollLead {
    id: string; state: string; lead_id: string; campaign_id: string; current_step: number;
    lead: LeadRow;
}

export const linkedinPollHandler: JobHandler = async ({ job, heartbeat }) => {
    const tenantId = job.tenant_id;
    const p = (job.payload ?? {}) as Record<string, unknown>;
    const accountId = typeof p.account_id === 'string' ? p.account_id : null;
    if (!accountId) throw new Error('linkedin:poll requires payload.account_id');

    await heartbeat({ stage: 'poll', account_id: accountId });

    // Re-enqueue the next poll while the account still has enrollments awaiting an event —
    // called on EVERY exit path (including non-ACTIVE) so the loop survives a transient outage.
    const reschedulePoll = async (): Promise<boolean> => {
        const { count } = await researchSupabaseAdmin
            .from('linkedin_enrollments').select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId).eq('account_id', accountId)
            .in('state', ['invited', 'messaged']);
        if ((count ?? 0) === 0) return false;
        await enqueueJob({
            tenantId, type: RESEARCH_JOB_TYPES.LINKEDIN_POLL,
            payload: { account_id: accountId }, maxAttempts: 1,
            scheduledAt: new Date(Date.now() + POLL_INTERVAL_MS),
        });
        return true;
    };

    const account = await loadAccount(tenantId, accountId);
    if (!account) throw new Error(`linkedin:poll: account ${accountId} not found for tenant ${tenantId}`);
    if (account.status !== 'ACTIVE') {
        const rescheduled = await reschedulePoll(); // keep the loop alive for recovery
        return { account_id: accountId, skipped: `account_${account.status}`, rescheduled };
    }

    // Active enrollments on this account awaiting an event, with their lead identity + step cursor.
    const { data: rows, error } = await researchSupabaseAdmin
        .from('linkedin_enrollments')
        .select('id, state, lead_id, campaign_id, current_step, linkedin_leads!inner(id, profile_urn, public_id, first_name, last_name, company, title, custom, dedupe_key)')
        .eq('tenant_id', tenantId).eq('account_id', accountId)
        .in('state', ['invited', 'accepted', 'messaged']);
    if (error) throw error;
    const enrollments: EnrollLead[] = (rows ?? []).map((r) => {
        const rr = r as Record<string, unknown>;
        return {
            id: rr.id as string, state: rr.state as string, lead_id: rr.lead_id as string,
            campaign_id: rr.campaign_id as string, current_step: rr.current_step as number,
            lead: rr.linkedin_leads as LeadRow,
        };
    });

    let creds, dispatcher;
    try {
        creds = credsFor(account);
    } catch (err) {
        await auditAction({ tenantId, accountId, type: 'poll', status: 'error', classifier: 'transport_error', error: err instanceof Error ? err.message : String(err), jobId: job.id });
        throw err;
    }
    // Fail-closed egress: poll through the account's OWN dedicated IP, never the rotating gateway
    // (codex P1.1) — a poll from a second IP is itself an account-correlation signal.
    const gate = await resolveDispatcher(tenantId, account, 'send');
    if (!gate.ok) {
        const rescheduled = await reschedulePoll(); // keep the loop alive for recovery
        return { account_id: accountId, skipped: gate.reason, rescheduled };
    }
    dispatcher = gate.dispatcher;

    let accepted = 0, replied = 0;

    // Lazy per-campaign step cache (to look up the message step's wait_days on accept).
    const stepCache = new Map<string, { step_order: number; wait_days: number }[]>();
    const stepsFor = async (campaignId: string) => {
        const cached = stepCache.get(campaignId);
        if (cached) return cached;
        const { data } = await researchSupabaseAdmin
            .from('linkedin_sequence_steps').select('step_order, wait_days')
            .eq('campaign_id', campaignId).order('step_order', { ascending: true });
        const steps = (data ?? []) as { step_order: number; wait_days: number }[];
        stepCache.set(campaignId, steps);
        return steps;
    };

    // ── Accept detection ──────────────────────────────────────────────────────────
    const invited = enrollments.filter((e) => e.state === 'invited' && e.lead.profile_urn);
    if (invited.length > 0) {
        const conn = await listConnections(creds, dispatcher);
        if (!conn.ok) {
            const hc = classifierForHttp(conn.httpStatus);
            if (hc) await applyWriteHealth(tenantId, account, hc);
        } else {
            for (const e of invited) {
                if (e.lead.profile_urn && conn.urns.has(e.lead.profile_urn)) {
                    const steps = await stepsFor(e.campaign_id);
                    const waitDays = steps[e.current_step]?.wait_days ?? 0; // current_step = the message step
                    const nextAt = new Date(Date.now() + Math.max(0, waitDays) * DAY_MS).toISOString();
                    // Guard on state='invited': a concurrent tick no-accept write then loses (P2).
                    await researchSupabaseAdmin.from('linkedin_enrollments')
                        .update({ state: 'accepted', next_action_at: nextAt, updated_at: new Date().toISOString() })
                        .eq('id', e.id).eq('state', 'invited');
                    accepted++;
                }
            }
        }
    }

    // ── Reply detection (conservative; UNVERIFIED hot-surface) ──────────────────────
    if (enrollments.length > 0 && account.status === 'ACTIVE') {
        const conv = await listConversations(creds, dispatcher, account.member_urn);
        if (!conv.ok) {
            const hc = classifierForHttp(conv.httpStatus);
            if (hc) await applyWriteHealth(tenantId, account, hc);
        } else {
            const incoming = new Set<string>();
            for (const cv of conv.conversations) {
                if (cv.incoming) for (const u of cv.participantUrns) incoming.add(u);
            }
            const seen = new Set<string>();
            for (const e of enrollments) {
                const urn = e.lead.profile_urn;
                if (urn && incoming.has(urn) && !seen.has(e.lead_id)) {
                    seen.add(e.lead_id);
                    await markReplied(tenantId, e.lead);
                    replied++;
                }
            }
        }
    }

    await auditAction({ tenantId, accountId, type: 'poll', status: 'ok', classifier: `accepted:${accepted} replied:${replied}`, jobId: job.id });
    const rescheduled = await reschedulePoll();
    log.info({ jobId: job.id, accountId, accepted, replied, rescheduled }, 'linkedin:poll complete');
    return { account_id: accountId, accepted, replied, rescheduled };
};
