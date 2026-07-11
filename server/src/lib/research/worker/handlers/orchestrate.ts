/**
 * research:orchestrate (WP9) — the "Derin araştırma çalışıyor" conductor for ONE approved
 * icp × geo cell. A pure decide-and-wait loop: it enqueues the SAME jobs a human already can
 * from the advanced view (channels:discover, channels:harvest, harvest:run) one at a time and
 * polls each to a terminal state before deciding the next — every write (companies, verdicts,
 * billing, coverage) stays inside those handlers, unchanged. This job only READS state to
 * decide what to run next and reports progress for the wizard's live narration; it never
 * touches research_companies/research_chunks/billing itself.
 *
 * Scope decision (WP9 v1, 05_SONRAKI_ADIMLAR.md): ONE cell per orchestrate job — mirrors
 * channels:discover/harvest and harvest:run, which are already single-cell, and keeps this
 * job's in-flight guard identical to the existing "one harvest per ICP" route guards
 * (harvest.ts/channels.ts) instead of inventing a second, cross-cell one. The ana-akış's
 * "onaylı+kalibre hücre sırasıyla" (cell by cell) intent is satisfied at the WIZARD level —
 * step 18 (client) launches one orchestrate job per approved cell in sequence, not a hidden
 * multi-cell loop inside a single job. Y2 (customs) stays a manual "Araştır" action from the
 * Gümrük Verisi tab (step 11) — it is batch-scoped, not geo-cell-scoped, so it doesn't fit this
 * conductor's per-cell loop; a future WP can fold it in if that changes.
 *
 * Stops (job.result.stopped_by) the same way harvest:run stops — cleanly, a succeeded job:
 *   'credits_exhausted'    — availableCredits(tenant) < 1 before the next spend-adjacent enqueue
 *   'scale_target_reached' — this cell's MATCH count >= research_projects.scale_target (read
 *                            live each iteration, so raising the target mid-run takes effect
 *                            on the very next decision)
 *   'fully_covered'        — the chunk's rule A && rule B are both true and nothing is pending
 *   'time_budget'          — MAX_RUNTIME_MS elapsed (this job blocks one worker concurrency
 *                            slot for its whole run; a hard ceiling bounds that even if
 *                            saturation never closes for a very long-tail cell)
 *   'iteration_cap'        — MAX_ITERATIONS child jobs enqueued (loop-safety backstop — logged,
 *                            never silent, 00 §ethos "no silent caps")
 *   'child_failed'         — a child job failed for a reason OTHER than credit exhaustion
 *                            (surfaced so the customer can retry from the advanced view)
 */
import type { HandlerContext, JobHandler } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { enqueueJob } from '../../queue.js';
import { RESEARCH_JOB_TYPES } from '../../jobTypes.js';
import { availableCredits } from '../../engine/ledger.js';
import { readCellChunk } from '../../channels/coverage.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:orchestrate');

const MAX_ITERATIONS = Number(process.env.RESEARCH_ORCHESTRATE_MAX_ITERATIONS) || 40;
const MAX_RUNTIME_MS = Number(process.env.RESEARCH_ORCHESTRATE_MAX_RUNTIME_MS) || 25 * 60 * 1000;
const POLL_INTERVAL_MS = 4000;

type TerminalStatus = 'succeeded' | 'failed' | 'canceled' | 'timeout';

interface ChannelRow { id: string; harvest_status: string; created_at: string }

/** Poll one child job to a terminal state, heartbeating the CONDUCTOR's own progress in
 *  between (never the child's lease — that stays the child's own worker attempt).
 *
 *  `deadlineAt` is REQUIRED, not advisory: without it this loop has no exit condition of its
 *  own, and a child that never gets CLAIMED (every worker concurrency slot occupied by other
 *  conductors doing the exact same thing — a real risk this job's own design creates: it
 *  blocks one slot for its whole run, and its children are ordinary jobs claimed from the SAME
 *  pool) would poll forever, permanently pinning this conductor's slot and starving every other
 *  job type on the shared queue (P1, adversarial review). The caller's own MAX_RUNTIME_MS check
 *  only runs BETWEEN iterations of its outer loop — useless while blocked inside a single poll —
 *  so the deadline must be enforced HERE, inside the wait itself. A 'timeout' result is a
 *  graceful stop (stoppedBy='time_budget'), not a thrown error: the child may still finish later
 *  on its own; this conductor just refuses to wait past its own budget for it. */
async function pollJobToTerminal(
    jobId: string,
    tenantId: string,
    deadlineAt: number,
    onTick: (row: { status: string; progress: Record<string, unknown> | null }) => Promise<void>,
): Promise<{ status: TerminalStatus; error: string | null }> {
    for (;;) {
        const { data, error } = await researchSupabaseAdmin
            .from('research_jobs')
            .select('status, progress, error')
            .eq('id', jobId)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error(`orchestrate: child job ${jobId} vanished`);
        const status = (data as { status: string }).status;
        if (status === 'succeeded' || status === 'failed' || status === 'canceled') {
            return { status: status as TerminalStatus, error: (data as { error: string | null }).error };
        }
        if (Date.now() >= deadlineAt) {
            return { status: 'timeout', error: null };
        }
        await onTick({ status, progress: (data as { progress: Record<string, unknown> | null }).progress });
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

/** Mirrors harvest.ts/channels.ts's own "one harvest per ICP across ANY harvest type" guard —
 *  this handler enqueues those SAME job types directly (bypassing the routes), so it must
 *  respect the identical invariant: two live runs of the same ICP race the (company, icp,
 *  ruleset) verdict between two valid leases. A hit means a concurrent customer action (or a
 *  prior attempt's still-running child) already owns a harvest slot for this ICP — the caller
 *  adopts it (waits on it) instead of enqueueing a second one, same as the routes' adopt path. */
async function findInflightHarvest(tenantId: string, icpId: string): Promise<{ id: string } | null> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_jobs')
        .select('id')
        .eq('tenant_id', tenantId)
        .in('type', [
            RESEARCH_JOB_TYPES.HARVEST_RUN,
            RESEARCH_JOB_TYPES.MAPS_HARVEST,
            RESEARCH_JOB_TYPES.TRADE_HARVEST,
            RESEARCH_JOB_TYPES.CHANNELS_HARVEST,
        ])
        .in('status', ['queued', 'running'])
        .contains('payload', { icp_id: icpId })
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return (data as { id: string } | null) ?? null;
}

async function findInflightDiscover(tenantId: string, geoId: string): Promise<{ id: string } | null> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_jobs')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('type', RESEARCH_JOB_TYPES.CHANNELS_DISCOVER)
        .in('status', ['queued', 'running'])
        .contains('payload', { geo_id: geoId })
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return (data as { id: string } | null) ?? null;
}

export const orchestrateHandler: JobHandler = async ({ job, heartbeat }: HandlerContext) => {
    const tenantId = job.tenant_id;
    const icpId = typeof job.payload?.icp_id === 'string' ? job.payload.icp_id : null;
    const geoId = typeof job.payload?.geo_id === 'string' ? job.payload.geo_id : null;
    if (!icpId || !geoId) throw new Error('research:orchestrate requires payload.icp_id and payload.geo_id');

    const { data: icp, error: icpErr } = await researchSupabaseAdmin
        .from('research_icps')
        .select('id, project_id, status')
        .eq('id', icpId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (icpErr) throw icpErr;
    if (!icp) throw new Error(`research:orchestrate: ICP ${icpId} not found for tenant ${tenantId}`);
    if ((icp as { status: string }).status !== 'approved') {
        throw new Error(`research:orchestrate: ICP ${icpId} is '${(icp as { status: string }).status}', not 'approved'`);
    }
    const projectId = (icp as { project_id: string }).project_id;

    const { data: geo, error: geoErr } = await researchSupabaseAdmin
        .from('research_geographies')
        .select('id, icp_id, status')
        .eq('id', geoId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (geoErr) throw geoErr;
    if (!geo || (geo as { icp_id: string | null }).icp_id !== icpId) {
        throw new Error(`research:orchestrate: geography ${geoId} does not belong to ICP ${icpId}`);
    }
    if ((geo as { status: string }).status !== 'approved') {
        throw new Error(`research:orchestrate: geography ${geoId} is '${(geo as { status: string }).status}', not 'approved'`);
    }

    let channelsDiscovered = 0;
    let channelsHarvested = 0;
    let y3Rounds = 0;
    let iterations = 0;
    const startedAt = Date.now();

    const readScaleTarget = async (): Promise<number | null> => {
        const { data, error } = await researchSupabaseAdmin
            .from('research_projects')
            .select('scale_target')
            .eq('id', projectId)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (error) throw error;
        return (data as { scale_target: number | null } | null)?.scale_target ?? null;
    };

    // Rollup count, scoped to THIS icp+geo — safe here (unlike a cross-ICP context) because
    // every child this conductor enqueues runs under the SAME icp_id, so the rollup's status
    // can't go stale from a DIFFERENT ICP re-scoring the same company mid-run (the cross-ICP
    // staleness this codebase otherwise guards against — harvest.ts's verdict-aware companies
    // read — doesn't apply within one ICP's own conductor loop).
    // P1 fix (adversarial review): excludes suppressed companies — without this, a customer who
    // suppressed 2 of 10 matches would see the conductor immediately report scale_target_reached
    // at "10" while their own results screen (which already filters suppressed rows) shows only
    // 8, a visible contradiction between "done" and what they can actually see.
    const currentMatchCount = async (): Promise<number> => {
        const { count, error } = await researchSupabaseAdmin
            .from('research_companies')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .eq('icp_id', icpId)
            .eq('geo_id', geoId)
            .eq('status', 'match')
            .eq('suppressed', false);
        if (error) throw error;
        return count ?? 0;
    };

    const oldestPendingChannel = async (): Promise<ChannelRow | null> => {
        const { data, error } = await researchSupabaseAdmin
            .from('research_channels')
            .select('id, harvest_status, created_at')
            .eq('tenant_id', tenantId)
            .eq('icp_id', icpId)
            .eq('geo_id', geoId)
            .eq('harvest_status', 'pending')
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();
        if (error) throw error;
        return (data as ChannelRow | null) ?? null;
    };

    let stoppedBy: string | null = null;
    while (!stoppedBy) {
        if (Date.now() - startedAt > MAX_RUNTIME_MS) { stoppedBy = 'time_budget'; break; }
        if (iterations >= MAX_ITERATIONS) { stoppedBy = 'iteration_cap'; break; }

        const [available, scaleTarget, matches, chunk, pendingChannel] = await Promise.all([
            availableCredits(tenantId),
            readScaleTarget(),
            currentMatchCount(),
            readCellChunk(tenantId, icpId, geoId),
            oldestPendingChannel(),
        ]);

        await heartbeat({
            stage: 'deciding',
            channels_discovered: channelsDiscovered,
            channels_harvested: channelsHarvested,
            y3_rounds: y3Rounds,
            matches,
            scale_target: scaleTarget,
            available_credits: available,
            fully_covered: chunk?.fully_covered ?? false,
        });

        if (scaleTarget != null && matches >= scaleTarget) { stoppedBy = 'scale_target_reached'; break; }
        if (available < 1) { stoppedBy = 'credits_exhausted'; break; }

        const saturationA = chunk?.saturation_a ?? false;
        const saturationB = chunk?.saturation_b ?? false;
        const fullyCovered = chunk?.fully_covered ?? false;

        let nextType: string;
        let payload: Record<string, unknown>;
        let stage: string;
        // P1 fix (adversarial review): scale_target was only ever re-checked BETWEEN children —
        // a single channels:harvest/harvest:run child runs under its OWN default caps (up to 40
        // candidates), so a target of "1 more" could still let one child bill several matches
        // before the conductor got a chance to notice the target was exceeded, contradicting the
        // wizard's own "at most N credits" copy. Capping maxCandidates to the REMAINING headroom
        // bounds it correctly: each candidate yields at most one verdict, and only a match bills,
        // so at most `remaining` NEW matches can result from any one child's candidate loop (the
        // shared cap tracker inside harvestRun.ts also gates its cross-ICP re-score pass, so the
        // combined candidate budget — not just the primary pass — respects this same ceiling).
        const remainingBudget = scaleTarget != null ? Math.max(1, scaleTarget - matches) : undefined;
        const harvestCaps = remainingBudget != null ? { maxCandidates: remainingBudget } : undefined;

        if (pendingChannel) {
            nextType = RESEARCH_JOB_TYPES.CHANNELS_HARVEST;
            payload = { channel_id: pendingChannel.id, icp_id: icpId, geo_id: geoId, ...(harvestCaps ? { caps: harvestCaps } : {}) };
            stage = 'harvesting_channel';
        } else if (!saturationA) {
            nextType = RESEARCH_JOB_TYPES.CHANNELS_DISCOVER;
            payload = { geo_id: geoId };
            stage = 'discovering_channels';
        } else if (!saturationB) {
            nextType = RESEARCH_JOB_TYPES.HARVEST_RUN;
            payload = { icp_id: icpId, geo_id: geoId, source: 'web', ...(harvestCaps ? { caps: harvestCaps } : {}) };
            stage = 'harvesting_web';
        } else if (fullyCovered) {
            stoppedBy = 'fully_covered';
            break;
        } else {
            // Rule A just closed and rule B is already saturated on paper, yet the chunk's
            // fully_covered flag hasn't caught up (it is recomputed inside the coverage RPC on
            // the NEXT write, not retroactively) — one more Y3 round is a safe default; the
            // next loop iteration re-reads the real chunk state and will see fully_covered.
            nextType = RESEARCH_JOB_TYPES.HARVEST_RUN;
            payload = { icp_id: icpId, geo_id: geoId, source: 'web', ...(harvestCaps ? { caps: harvestCaps } : {}) };
            stage = 'harvesting_web';
        }

        let childId: string;
        if (nextType === RESEARCH_JOB_TYPES.CHANNELS_DISCOVER) {
            const inflight = await findInflightDiscover(tenantId, geoId);
            childId = inflight ? inflight.id : (await enqueueJob({ tenantId, projectId, type: nextType, payload, maxAttempts: 1 })).id;
        } else {
            const inflight = await findInflightHarvest(tenantId, icpId);
            childId = inflight ? inflight.id : (await enqueueJob({ tenantId, projectId, type: nextType, payload, maxAttempts: 1 })).id;
        }

        iterations++;
        const { status, error: childError } = await pollJobToTerminal(childId, tenantId, startedAt + MAX_RUNTIME_MS, async ({ status: s, progress }) => {
            await heartbeat({ stage, child_job_id: childId, child_type: nextType, child_status: s, child_progress: progress ?? undefined });
        });

        if (status === 'timeout') {
            // The deadline hit while WAITING on a child (not between iterations) — the outer
            // loop's own MAX_RUNTIME_MS check at the top never gets a chance to fire in this
            // case (adversarial review P1: an unbounded poll here would starve the worker's
            // whole concurrency pool if every slot were held by a conductor doing the same
            // thing).
            stoppedBy = 'time_budget';
            // P1 fix (adversarial review, round 2): a child that never got CLAIMED (every slot
            // busy — the exact scenario this timeout exists for) is still sitting 'queued' when
            // we give up on it. Left alone, it would eventually get claimed once ANY slot frees
            // (not necessarily one of ours) and spend credits AFTER this job has already reported
            // "stopped" to the wizard — invisible spend the customer never sees reflected on
            // screen. Best-effort cancel ONLY if still queued (never touch a job that's already
            // RUNNING — it may have already committed holds/partial spend the cancel path doesn't
            // unwind, so pulling the rug there would be worse than leaving it to finish).
            try {
                await researchSupabaseAdmin
                    .from('research_jobs')
                    .update({ status: 'canceled', finished_at: new Date().toISOString() })
                    .eq('id', childId)
                    .eq('tenant_id', tenantId)
                    .eq('status', 'queued');
            } catch (cancelErr) {
                log.warn({ err: cancelErr, childId }, 'orchestrate: best-effort child cancel on timeout failed');
            }
            log.warn({ jobId: job.id, childId, childType: nextType }, 'orchestrate: timed out waiting for a child job — stopping cleanly');
            break;
        }
        if (status === 'failed') {
            const exhausted = typeof childError === 'string' && /insufficient research credits|RESERVATION_EXHAUSTED/i.test(childError);
            if (exhausted) { stoppedBy = 'credits_exhausted'; break; }
            stoppedBy = 'child_failed';
            log.warn({ jobId: job.id, childId, childType: nextType, childError }, 'orchestrate: child job failed — stopping cleanly');
            break;
        }
        if (nextType === RESEARCH_JOB_TYPES.CHANNELS_DISCOVER) channelsDiscovered++;
        else if (nextType === RESEARCH_JOB_TYPES.CHANNELS_HARVEST) channelsHarvested++;
        else if (nextType === RESEARCH_JOB_TYPES.HARVEST_RUN) y3Rounds++;
    }

    const finalMatches = await currentMatchCount();
    log.info(
        { jobId: job.id, icpId, geoId, stoppedBy, channelsDiscovered, channelsHarvested, y3Rounds, matches: finalMatches, iterations },
        'research:orchestrate complete'
    );
    return {
        icp_id: icpId,
        geo_id: geoId,
        stopped_by: stoppedBy,
        iterations,
        channels_discovered: channelsDiscovered,
        channels_harvested: channelsHarvested,
        y3_rounds: y3Rounds,
        matches: finalMatches,
    };
};
