/**
 * WP3 — cell coverage: rule-A evaluation + the fenced chunk-coverage writer (091).
 *
 * research_chunks holds ONE cumulative row per (icp × geo) cell. Rule A (list-harvest
 * saturation, 00 §3): all discovery angles have run AND the last 2 discovery rounds found
 * no new channel AND the canonical categories are closed AND every discovered channel is
 * harvested-or-unreachable. Rule B (open-web saturation) is computed by the Y3 source and
 * persisted by the harvest handler. fully_covered = A && B — both rules say "done".
 *
 * Everything here is ADVISORY analytics — no billing coupling. The RPC is lease-fenced
 * (063 pattern) like every other worker writer.
 */
import { researchSupabaseAdmin } from '../supabase.js';
import { createLogger } from '../../logger.js';

const log = createLogger('research:channels:coverage');

/** Categories that must be represented before rule A can close (the pragmatic core of
 *  00 §3's canonical list — customs rides Y2 and maps rides the maps source, so they are
 *  not required from open-web channel discovery). */
const REQUIRED_CATEGORIES = ['association', 'directory', 'fair'] as const;

/** Consecutive no-new-channel rounds required (00 §3: "son 2 keşif turunda yeni kanal yok"). */
export const RULE_A_NO_NEW_ROUNDS = 2;

export interface RuleAState {
    saturationA: boolean;
    channelsTotal: number;
    channelsPending: number;
    categoriesClosed: boolean;
    missingCategories: string[];
}

/** Evaluate rule A for a cell from the channels table + the chunk's round counter.
 *  `anglesRun` = at least one full discovery round has executed (persisted in coverage). */
export async function evaluateRuleA(args: {
    tenantId: string;
    icpId: string;
    geoId: string;
    roundsNoNew: number;
    anglesRun: boolean;
}): Promise<RuleAState> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_channels')
        .select('type, harvest_status')
        .eq('tenant_id', args.tenantId)
        .eq('icp_id', args.icpId)
        .eq('geo_id', args.geoId);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ type: string; harvest_status: string }>;
    const types = new Set(rows.map((r) => r.type));
    const missing = REQUIRED_CATEGORIES.filter((c) => !types.has(c));
    const pending = rows.filter((r) => r.harvest_status === 'pending').length;
    const saturationA =
        args.anglesRun &&
        args.roundsNoNew >= RULE_A_NO_NEW_ROUNDS &&
        missing.length === 0 &&
        rows.length > 0 &&
        pending === 0;
    return {
        saturationA,
        channelsTotal: rows.length,
        channelsPending: pending,
        categoriesClosed: missing.length === 0,
        missingCategories: missing,
    };
}

export interface ChunkRow {
    id: string;
    angle_stats: Record<string, number>;
    queries_total: number;
    found_count: number;
    estimate: number | null;
    channels_found: number;
    channels_harvested: number;
    saturation_a: boolean;
    saturation_b: boolean;
    fully_covered: boolean;
    discovery_rounds_no_new: number;
    last_two_new_domains: number | null;
    coverage: Record<string, unknown>;
    status: string;
}

/** Read the cumulative cell chunk (null when the cell has never run). */
export async function readCellChunk(tenantId: string, icpId: string, geoId: string): Promise<ChunkRow | null> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_chunks')
        .select('id, angle_stats, queries_total, found_count, estimate, channels_found, channels_harvested, saturation_a, saturation_b, fully_covered, discovery_rounds_no_new, last_two_new_domains, coverage, status')
        .eq('tenant_id', tenantId)
        .eq('icp_id', icpId)
        .eq('geo_id', geoId)
        .maybeSingle();
    if (error) throw error;
    return (data as ChunkRow | null) ?? null;
}

export interface CoverageUpdate {
    tenantId: string;
    jobId: string;
    worker: string;
    lease: string;
    projectId: string | null;
    icpId: string;
    geoId: string;
    angleDelta?: Record<string, number>;
    queriesDelta?: number;
    lastTwoNewDomains?: number;
    foundCount?: number;
    estimate?: number;
    channelsFound?: number;
    channelsHarvested?: number;
    saturationA?: boolean;
    saturationB?: boolean;
    roundsNoNew?: number;
    coverage?: Record<string, unknown>;
}

/** Write cumulative coverage through the fenced RPC (091). Omitted fields are left as-is. */
export async function updateChunkCoverage(u: CoverageUpdate): Promise<void> {
    const { error } = await researchSupabaseAdmin.rpc('research_update_chunk_coverage', {
        p_tenant: u.tenantId,
        p_job_id: u.jobId,
        p_worker: u.worker,
        p_lease: u.lease,
        p_project: u.projectId,
        p_icp: u.icpId,
        p_geo: u.geoId,
        p_angle_delta: u.angleDelta ?? null,
        p_queries_delta: u.queriesDelta ?? 0,
        p_last_two_new_domains: u.lastTwoNewDomains ?? null,
        p_found_count: u.foundCount ?? null,
        p_estimate: u.estimate ?? null,
        p_channels_found: u.channelsFound ?? null,
        p_channels_harvested: u.channelsHarvested ?? null,
        p_saturation_a: u.saturationA ?? null,
        p_saturation_b: u.saturationB ?? null,
        // fully_covered is computed INSIDE the RPC (093) as post-COALESCE A && B — a caller-side
        // computation from a minutes-old prior read could persist an inconsistent pair.
        p_rounds_no_new: u.roundsNoNew ?? null,
        p_coverage: u.coverage ?? null,
    });
    if (error) throw error;
}

/** Best-effort coverage write: advisory analytics must never fail the run that earned them. */
export async function updateChunkCoverageSafe(u: CoverageUpdate): Promise<boolean> {
    try {
        await updateChunkCoverage(u);
        return true;
    } catch (err) {
        log.warn({ err, icpId: u.icpId, geoId: u.geoId, jobId: u.jobId }, 'chunk coverage update failed (advisory — run result unaffected)');
        return false;
    }
}
