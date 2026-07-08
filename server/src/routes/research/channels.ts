/**
 * Research channels (WP3 — Y1 channel discovery + list harvest + cell coverage).
 * A channel is a COMPANY-LIST source (association / directory / fair / chamber / cluster /
 * marketplace / editorial) discovered for one approved sub-ICP × country cell (geo_id).
 * channels:discover finds them (SearXNG $0 + cheap reading-role classification);
 * channels:harvest feeds ONE channel's member list through the shared fenced spine —
 * members validate + bill exactly like web-discovered candidates.
 * Coverage = the cell's cumulative chunk (091): N/E, angle stats, rule A+B saturation.
 * Pattern mirrors routes/research/geographies.ts + harvest.ts.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { isInternalRole } from '../../lib/roles.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { enqueueJob, ResearchJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPES } from '../../lib/research/jobTypes.js';
import { availableCredits } from '../../lib/research/engine/ledger.js';
import { sanitizeJobForRole } from '../../lib/research/sanitize.js';
import { effectiveCostRole } from '../../lib/research/freshRole.js';

const log = createLogger('route:research:channels');
const router = Router();

const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');

const discoverSchema = z.object({
    geo_id: uuidField('Invalid geography ID'),
});

// Caps stay an opaque unknown publicly (dollar-shaped knobs never surface to customer roles);
// parsed with the internal schema ONLY for internal roles — the harvest.ts convention.
const harvestSchema = z.object({
    caps: z.unknown().optional(),
});
const internalCapsSchema = z
    .object({
        maxQueries: z.number().int().min(1).max(33).optional(),
        maxFetches: z.number().int().min(1).max(200).optional(),
        maxCandidates: z.number().int().min(1).max(300).optional(),
        maxSpendUsd: z.number().min(0.01).max(25).optional(),
    })
    .optional();

const idParamSchema = z.object({ id: uuidField('Invalid channel ID') });

/** Best-effort in-flight guard (advisory, geographies.ts pattern): adopt a queued/running
 *  job for the same payload key instead of stacking a second one. */
async function findInflight(tenantId: string, type: string, payloadMatch: Record<string, string>): Promise<ResearchJob | null> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_jobs')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('type', type)
        .in('status', ['queued', 'running'])
        .contains('payload', payloadMatch)
        .limit(1)
        .maybeSingle();
    if (error) {
        log.error({ err: error, type }, 'in-flight check failed');
        throw new AppError('Failed to start job', 500);
    }
    return (data as ResearchJob | null) ?? null;
}

// ── POST /api/research/channels/discover — one discovery ROUND for a cell ─────
router.post('/discover', requireWriter, validateBody(discoverSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { geo_id } = req.body as z.infer<typeof discoverSchema>;

        // The cell must exist + be APPROVED (discovery consumes the approved spec's local
        // terms + channel seed; its output exists to be harvested, which needs approval too).
        const { data: geo, error: geoErr } = await researchSupabaseAdmin
            .from('research_geographies')
            .select('id, project_id, icp_id, status')
            .eq('id', geo_id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (geoErr) {
            log.error({ err: geoErr }, 'discover geo lookup failed');
            throw new AppError('Failed to start channel discovery', 500);
        }
        if (!geo) {
            res.status(404).json({ error: 'Geography not found' });
            return;
        }
        if (!geo.icp_id) {
            res.status(409).json({ error: 'Geography has no ICP — only sub-ICP cells support channel discovery' });
            return;
        }
        if (geo.status !== 'approved') {
            res.status(409).json({ error: 'Approve this geography before discovering channels' });
            return;
        }

        const costRole = await effectiveCostRole(req.user, req.tenantId);

        const inflight = await findInflight(tenantId, RESEARCH_JOB_TYPES.CHANNELS_DISCOVER, { geo_id });
        if (inflight) {
            // 068 rule: every job echo is role-sanitized — an adopted job may carry an internal
            // operator's caps (maxSpendUsd) in its payload.
            res.status(200).json(sanitizeJobForRole(inflight as unknown as Record<string, unknown>, costRole));
            return;
        }

        // Saturation gate (review P3): once rule A closed the cell's list discovery, more
        // customer-triggered rounds are pure unbilled COGS with no expected yield. Internal
        // roles may still force a round (e.g. after a market shift).
        if (!isInternalRole(costRole)) {
            const { data: chunk } = await researchSupabaseAdmin
                .from('research_chunks')
                .select('saturation_a')
                .eq('tenant_id', tenantId)
                .eq('geo_id', geo_id)
                .maybeSingle();
            if ((chunk as { saturation_a?: boolean } | null)?.saturation_a === true) {
                res.status(409).json({ error: 'Channel discovery for this geography is already saturated — harvest the discovered channels instead' });
                return;
            }
        }

        // Fast-fail credit gate (advisory snapshot, geographies.ts rationale): discovery is
        // cheap unbilled COGS, but a zero-credit tenant has no path to harvest what it finds.
        const available = await availableCredits(tenantId);
        if (available < 1) {
            res.status(402).json({ error: 'Insufficient research credits', available });
            return;
        }

        const job = await enqueueJob({
            tenantId,
            type: RESEARCH_JOB_TYPES.CHANNELS_DISCOVER,
            payload: { geo_id },
            projectId: (geo as { project_id: string }).project_id,
            // LLM spend, not cost-idempotent — run once; a failed round is simply re-run.
            maxAttempts: 1,
            createdBy: req.user?.id ?? null,
        });
        res.status(202).json(sanitizeJobForRole(job as unknown as Record<string, unknown>, costRole));
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'discover channels error');
        next(new AppError('Failed to start channel discovery', 500));
    }
});

// ── GET /api/research/channels?geo_id= — the cell's channel table ─────────────
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { geo_id } = req.query;
        if (!geo_id || typeof geo_id !== 'string' || !uuidField().safeParse(geo_id).success) {
            res.status(400).json({ error: 'geo_id is required' });
            return;
        }
        const { data, error } = await researchSupabaseAdmin
            .from('research_channels')
            .select('id, type, name, url, member_list_url, discovery_round, harvest_status, harvested_at, companies_found, harvest_error, note, created_at')
            .eq('tenant_id', tenantId)
            .eq('geo_id', geo_id)
            .order('created_at', { ascending: true });
        if (error) {
            log.error({ err: error }, 'list channels failed');
            throw new AppError('Failed to fetch channels', 500);
        }
        res.json({ data: data || [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'list channels error');
        next(new AppError('Failed to fetch channels', 500));
    }
});

// ── GET /api/research/channels/coverage?geo_id= — cumulative cell coverage ────
router.get('/coverage', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { geo_id } = req.query;
        if (!geo_id || typeof geo_id !== 'string' || !uuidField().safeParse(geo_id).success) {
            res.status(400).json({ error: 'geo_id is required' });
            return;
        }
        // The chunk carries no dollar fields (091) — safe for every role as-is.
        const { data: chunk, error: chunkErr } = await researchSupabaseAdmin
            .from('research_chunks')
            .select('found_count, estimate, queries_total, angle_stats, last_two_new_domains, channels_found, channels_harvested, saturation_a, saturation_b, fully_covered, discovery_rounds_no_new, coverage, status, updated_at')
            .eq('tenant_id', tenantId)
            .eq('geo_id', geo_id)
            .maybeSingle();
        if (chunkErr) {
            log.error({ err: chunkErr }, 'coverage chunk read failed');
            throw new AppError('Failed to fetch coverage', 500);
        }
        res.json({ data: chunk ?? null });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'coverage error');
        next(new AppError('Failed to fetch coverage', 500));
    }
});

// ── POST /api/research/channels/:id/harvest — feed ONE channel into the spine ─
router.post('/:id/harvest', requireWriter, validateBody(harvestSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const parsed = idParamSchema.safeParse(req.params);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid channel ID' });
            return;
        }
        const tenantId = req.tenantId!;
        const { caps: rawCaps } = req.body as z.infer<typeof harvestSchema>;

        const { data: channel, error: chErr } = await researchSupabaseAdmin
            .from('research_channels')
            .select('id, project_id, icp_id, geo_id, url, member_list_url, harvest_status, harvested_at')
            .eq('id', parsed.data.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (chErr) {
            log.error({ err: chErr }, 'harvest channel lookup failed');
            throw new AppError('Failed to start channel harvest', 500);
        }
        if (!channel) {
            res.status(404).json({ error: 'Channel not found' });
            return;
        }
        if (!channel.icp_id || !channel.geo_id) {
            res.status(409).json({ error: 'Channel has no cell identity — only cell-discovered channels are harvestable' });
            return;
        }
        if (!channel.url && !channel.member_list_url) {
            res.status(409).json({ error: 'Channel has no URL to harvest' });
            return;
        }

        // Harvest admission mirrors harvest.ts: approved ICP + approved cell (the worker
        // re-checks both — this just fails fast with a friendly message).
        const { data: geo } = await researchSupabaseAdmin
            .from('research_geographies')
            .select('id, status')
            .eq('id', channel.geo_id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (!geo || geo.status !== 'approved') {
            res.status(409).json({ error: 'Approve this geography before harvesting its channels' });
            return;
        }

        const costRole = await effectiveCostRole(req.user, req.tenantId);

        // Re-harvest gate (review P3): a channel harvested to completion within the last day is
        // pure repeat extraction spend — dedup would skip its members anyway. Internal roles may
        // force; partial ('pending' with a stop note) and 'unreachable' channels always retry.
        if (!isInternalRole(costRole) && channel.harvest_status === 'harvested' && channel.harvested_at) {
            const ageMs = Date.now() - new Date(channel.harvested_at as string).getTime();
            if (ageMs < 24 * 3600 * 1000) {
                res.status(409).json({ error: 'This channel was harvested in the last 24 hours — its members are already in your registry' });
                return;
            }
        }

        const inflight = await findInflight(tenantId, RESEARCH_JOB_TYPES.CHANNELS_HARVEST, { channel_id: parsed.data.id });
        if (inflight) {
            // 068 rule: every job echo is role-sanitized (an adopted internal run's payload caps).
            res.status(200).json(sanitizeJobForRole(inflight as unknown as Record<string, unknown>, costRole));
            return;
        }

        // ONE in-flight harvest per ICP across ANY harvest type (harvest.ts guard, codex P1):
        // two live same-ICP runs make the (company, icp, ruleset) verdict a last-writer-wins race
        // between valid leases — an unbilled match persisted by run A can be overwritten by run B
        // between A's persist and A's bill. The reciprocal lists in harvest.ts/trade.ts now
        // include CHANNELS_HARVEST too.
        const { data: icpInflight, error: icpInfErr } = await researchSupabaseAdmin
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
            .contains('payload', { icp_id: channel.icp_id })
            .limit(1)
            .maybeSingle();
        if (icpInfErr) {
            log.error({ err: icpInfErr }, 'channel harvest icp in-flight check failed');
            throw new AppError('Failed to start channel harvest', 500);
        }
        if (icpInflight) {
            res.status(409).json({
                error: 'A harvest for this ICP is already queued or running',
                job_id: (icpInflight as { id: string }).id,
            });
            return;
        }

        // Harvest BILLS matches — same credit gate as a normal harvest run.
        const available = await availableCredits(tenantId);
        if (available < 1) {
            res.status(402).json({ error: 'Insufficient research credits', available });
            return;
        }

        // Internal roles may size a sanctioned larger run; client-role caps are silently dropped.
        // Gate on the FRESH role (codex P2): a demoted internal user's cached req.user.role could
        // otherwise keep submitting dollar-shaped caps until the auth cache expires.
        let caps: z.infer<typeof internalCapsSchema>;
        if (rawCaps !== undefined && isInternalRole(costRole)) {
            const parsedCaps = internalCapsSchema.safeParse(rawCaps);
            if (!parsedCaps.success) {
                res.status(400).json({ error: 'Invalid caps' });
                return;
            }
            caps = parsedCaps.data;
        }

        const job = await enqueueJob({
            tenantId,
            type: RESEARCH_JOB_TYPES.CHANNELS_HARVEST,
            // icp/geo come from the CHANNEL row (server-authoritative) — the worker re-verifies
            // the payload against the channel's cell before running.
            payload: { channel_id: parsed.data.id, icp_id: channel.icp_id, geo_id: channel.geo_id, ...(caps ? { caps } : {}) },
            projectId: (channel as { project_id: string }).project_id,
            // Bills money through the fenced spine — never auto-retry a partial spend.
            maxAttempts: 1,
            createdBy: req.user?.id ?? null,
        });
        res.status(202).json(sanitizeJobForRole(job as unknown as Record<string, unknown>, costRole));
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'harvest channel error');
        next(new AppError('Failed to start channel harvest', 500));
    }
});

export default router;
