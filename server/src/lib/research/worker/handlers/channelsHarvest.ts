/**
 * channels:harvest (WP3, Y1 🥇) — harvest ONE discovered channel's member list into the
 * SHARED fenced candidate spine.
 *
 * channelListSource fetches the member/exhibitor list page and reading-role-extracts member
 * companies; runHarvest then does everything money-adjacent exactly as any other source:
 * canonical dedup → suppression → fetch → validate → fenced verdict → once-ever MATCH billing
 * under the run's hold. Companies carry source_path='Y1' + channel_id (092) provenance.
 *
 * This handler owns the CHANNEL bookkeeping around the run: harvest_status
 * (harvested/unreachable), harvested_at, companies_found, harvest_error — plus the cell
 * chunk's channels_harvested / rule-A re-evaluation through the fenced coverage RPC.
 */
import type { HandlerContext, JobHandler } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { runHarvest } from './harvestRun.js';
import { channelListSource, type ChannelHarvestOutcome, type ChannelSourceRow } from '../../engine/sources.js';
import { evaluateRuleA, readCellChunk, updateChunkCoverageSafe } from '../../channels/coverage.js';
import { sanitizeJobError } from '../../sanitize.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:channels-harvest');

interface ChannelRow extends ChannelSourceRow {
    project_id: string;
    icp_id: string | null;
    geo_id: string | null;
    harvest_status: string;
}

export const channelsHarvestHandler: JobHandler = async (ctx) => {
    const { job, heartbeat } = ctx;
    const tenantId = job.tenant_id;
    const channelId = typeof job.payload?.channel_id === 'string' ? job.payload.channel_id : null;
    if (!channelId) throw new Error('channels:harvest requires payload.channel_id');
    const worker = job.locked_by;
    const lease = job.lease;
    if (!worker || !lease) throw new Error(`channels:harvest: job ${job.id} has no running lease — refusing unfenced writes`);

    await heartbeat({ stage: 'loading', channel_id: channelId });

    const { data: channel, error: chErr } = await researchSupabaseAdmin
        .from('research_channels')
        .select('id, project_id, icp_id, geo_id, name, url, member_list_url, harvest_status')
        .eq('id', channelId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (chErr) throw chErr;
    if (!channel) throw new Error(`channels:harvest: channel ${channelId} not found for tenant ${tenantId}`);
    const ch = channel as ChannelRow;
    if (!ch.icp_id || !ch.geo_id) {
        throw new Error(`channels:harvest: channel ${channelId} has no cell identity (icp_id/geo_id) — only cell-discovered channels are harvestable`);
    }
    // The payload's icp/geo (what runHarvest keys billing + admission on) must be the
    // CHANNEL's cell — a divergent payload would validate members against the wrong ICP.
    if (job.payload?.icp_id !== ch.icp_id || job.payload?.geo_id !== ch.geo_id) {
        throw new Error(`channels:harvest: payload icp/geo does not match channel ${channelId}'s cell`);
    }

    // Reachability outcome is reported by the source mid-run; captured here for bookkeeping.
    let outcome: ChannelHarvestOutcome = { status: 'unreachable', error: 'harvest did not run', membersExtracted: 0, notAList: false };
    const source = channelListSource(ch, (o) => { outcome = o; });

    let summary: Record<string, unknown>;
    try {
        summary = await runHarvest(ctx, source);
    } catch (err) {
        // Record why the harvest attempt died on the channel row (status stays as-is so the
        // channel remains visibly un-harvested); best-effort — never mask the original error.
        // SANITIZED: harvest_error is read by customer roles (channels list/tooltip), and a raw
        // worker error can carry provider billing/quota dollar strings — same leak class the
        // jobs.error sanitizer closes. This handler is the ONLY writer of harvest_error, so
        // customer-safety is enforced at the single write point.
        try {
            await researchSupabaseAdmin
                .from('research_channels')
                .update({ harvest_job_id: job.id, harvest_error: sanitizeJobError(err instanceof Error ? err.message : String(err)) })
                .eq('id', channelId)
                .eq('tenant_id', tenantId);
        } catch (updErr) {
            log.warn({ err: updErr, channelId }, 'channel harvest_error write failed');
        }
        throw err;
    }

    // ── Channel bookkeeping (after a SUCCESSFUL run) ─────────────────────────
    // 'harvested' is a PROMISE: every extracted member went through the spine. A capped or
    // reservation-exhausted run is a graceful stop with stopped_by set — its remaining members
    // never got a verdict, so the channel STAYS 'pending' with the stop reason recorded; a
    // re-harvest resumes cheaply (dedup skips already-scored members). 'unreachable' still
    // counts as a completed attempt for rule A (00 §3: harvested OR unreachable) — the flag
    // is the operator's re-try signal. outcome.error / the partial note below are our OWN
    // customer-safe strings (never raw provider text).
    const stoppedBy = typeof summary.stopped_by === 'string' ? summary.stopped_by : null;
    const complete = stoppedBy == null;
    const status = outcome.status === 'unreachable' ? 'unreachable' : complete ? 'harvested' : 'pending';
    const { error: updErr } = await researchSupabaseAdmin
        .from('research_channels')
        .update({
            harvest_status: status,
            harvested_at: new Date().toISOString(),
            harvest_job_id: job.id,
            companies_found: outcome.membersExtracted,
            harvest_error: outcome.status === 'unreachable'
                ? outcome.error
                : complete
                    ? null
                    : `partial: stopped by ${stoppedBy} — re-harvest to continue (already-scored members are skipped)`,
            note: outcome.notAList ? 'extractor: page is not a company list' : undefined,
        })
        .eq('id', channelId)
        .eq('tenant_id', tenantId);
    if (updErr) log.warn({ err: updErr, channelId }, 'channel bookkeeping update failed (advisory)');

    // ── Cell coverage: channels_harvested + rule-A re-evaluation ─────────────
    try {
        const prior = await readCellChunk(tenantId, ch.icp_id, ch.geo_id);
        const ruleA = await evaluateRuleA({
            tenantId, icpId: ch.icp_id, geoId: ch.geo_id,
            roundsNoNew: prior?.discovery_rounds_no_new ?? 0,
            anglesRun: prior?.coverage?.discovery_angles_run === true,
        });
        await updateChunkCoverageSafe({
            tenantId, jobId: job.id, worker, lease,
            projectId: ch.project_id,
            icpId: ch.icp_id, geoId: ch.geo_id,
            channelsFound: ruleA.channelsTotal,
            channelsHarvested: ruleA.channelsTotal - ruleA.channelsPending,
            saturationA: ruleA.saturationA,
        });
    } catch (err) {
        log.warn({ err, channelId }, 'post-harvest coverage update failed (advisory)');
    }

    log.info({ jobId: job.id, channelId, status, stoppedBy, members: outcome.membersExtracted }, 'channels:harvest complete');
    return {
        ...summary,
        channel_id: channelId,
        channel_status: status,
        channel_members_extracted: outcome.membersExtracted,
        channel_not_a_list: outcome.notAList,
    };
};
