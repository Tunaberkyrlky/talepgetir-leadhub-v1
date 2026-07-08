/**
 * channels:discover (WP3, Y1 🥇) — find EVERY reachable company-list source for one
 * APPROVED sub-ICP × country cell.
 *
 * Deterministic multilingual query templates (00 §3, seeded with the cell's local terms)
 * → SearXNG ($0) → ONE reading-role classification pass over the collected results →
 * research_channels upsert (per-cell URL dedup, 091 index). Each run is one DISCOVERY
 * ROUND; rule A (list-harvest saturation) is evaluated from the cumulative cell state and
 * persisted to the cell chunk through the fenced coverage RPC.
 *
 * NO billing coupling: discovery writes channels + advisory coverage only. Money enters
 * when a channel is HARVESTED (channels:harvest → the shared fenced spine).
 */
import type { HandlerContext } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { runLlmJson } from '../../llm/index.js';
import { withLlmMeter, type MeteredError } from '../../llm/meter.js';
import { costFromUsageSummary } from '../../engine/pricing.js';
import { searxngBaseUrl, searxngSearch } from '../../engine/searxng.js';
import { channelClassificationSchema, type ClassifiedChannel } from '../../channels/schema.js';
import { buildChannelClassificationPrompt, type ChannelSearchHit } from '../../channels/prompt.js';
import { buildChannelDiscoveryQueries } from '../../channels/discovery.js';
import { evaluateRuleA, readCellChunk, updateChunkCoverageSafe, RULE_A_NO_NEW_ROUNDS } from '../../channels/coverage.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:channels-discover');

/** Top hits kept per discovery query (the classifier needs cues, not full pages). */
const HITS_PER_QUERY = Number(process.env.RESEARCH_CHANNELS_DISCOVER_HITS_PER_QUERY ?? 6);
/** Hard bound on hits handed to the classification pass (prompt size control). */
const MAX_HITS_TOTAL = 120;

function normalizeChannelUrl(url: string): string {
    return url.trim().replace(/\/+$/, '').toLowerCase();
}

export async function channelsDiscoverHandler({ job, heartbeat }: HandlerContext): Promise<Record<string, unknown>> {
    const geoId = typeof job.payload?.geo_id === 'string' ? job.payload.geo_id : null;
    if (!geoId) throw new Error('channels:discover requires payload.geo_id');
    const tenantId = job.tenant_id;
    const worker = job.locked_by;
    const lease = job.lease;
    if (!worker || !lease) throw new Error(`channels:discover: job ${job.id} has no running lease — refusing unfenced writes`);

    await heartbeat({ stage: 'loading' });

    // The cell must be APPROVED: discovery consumes the human-approved spec (local terms +
    // channel seed), and its output exists to be harvested — which requires approval anyway.
    const { data: geo, error: geoErr } = await researchSupabaseAdmin
        .from('research_geographies')
        .select('id, project_id, icp_id, country, status, spec')
        .eq('id', geoId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (geoErr) throw geoErr;
    if (!geo) throw new Error(`channels:discover: geography ${geoId} not found for tenant ${tenantId}`);
    if (!geo.icp_id) throw new Error(`channels:discover: geography ${geoId} has no icp_id`);
    if (geo.status !== 'approved') {
        throw new Error(`channels:discover: geography ${geoId} is '${geo.status}', not 'approved' (approve it first)`);
    }

    const { data: icp, error: icpErr } = await researchSupabaseAdmin
        .from('research_icps')
        .select('id, name, segment')
        .eq('id', geo.icp_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (icpErr) throw icpErr;
    if (!icp) throw new Error(`channels:discover: ICP ${geo.icp_id} not found for tenant ${tenantId}`);

    if (!searxngBaseUrl()) {
        // Channel discovery is BUILT on the $0 SearXNG sweep; without it every query would be
        // silent noise. Fail loud — the operator wires RESEARCH_SEARXNG_URL, not a fallback spend.
        throw new Error('channels:discover requires RESEARCH_SEARXNG_URL (SearXNG) — refusing to run without it');
    }

    // Narrow structural pick of the approved spec (the geo module owns the full contract).
    const spec = (geo.spec ?? null) as Record<string, unknown> | null;
    const strings = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [];
    const localTerms = spec ? strings(spec.local_terms) : [];
    const seedNames = spec
        ? [
              ...(Array.isArray(spec.channels) ? spec.channels : []),
              ...(Array.isArray(spec.directories) ? spec.directories : []),
          ]
              .map((c) => (c && typeof c === 'object' ? (c as { name?: unknown }).name : null))
              .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
              .slice(0, 25)
        : [];

    const sector = ((icp.segment as string | null) || (icp.name as string)).trim();
    const country = (geo.country as string).trim();
    const queries = buildChannelDiscoveryQueries(sector, country, localTerms);

    // This run = one discovery ROUND (cumulative across runs, persisted on the channel rows).
    const { data: roundRow, error: roundErr } = await researchSupabaseAdmin
        .from('research_channels')
        .select('discovery_round')
        .eq('tenant_id', tenantId)
        .eq('icp_id', geo.icp_id)
        .eq('geo_id', geoId)
        .order('discovery_round', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (roundErr) throw roundErr;
    const round = ((roundRow as { discovery_round: number } | null)?.discovery_round ?? 0) + 1;

    // ── SearXNG sweep ($0) ────────────────────────────────────────────────────
    const hits: ChannelSearchHit[] = [];
    let queriesRun = 0;
    let queriesCompleted = 0;
    for (const q of queries) {
        if (hits.length >= MAX_HITS_TOTAL) break;
        try {
            const { results, complete } = await searxngSearch(q.query, { pages: 1 });
            queriesRun++;
            // searxngSearch never throws — an outage surfaces as complete:false with empty
            // results (codex P2). Only a COMPLETED query counts toward round validity.
            if (complete) queriesCompleted++;
            for (const r of results.slice(0, HITS_PER_QUERY)) {
                // A hostile engine can return arbitrary strings: a legit URL never contains a
                // fence marker (drop it), and titles are clipped like snippets so one result
                // can't bloat the classification prompt past the context limit.
                if (r.url.includes('<<<')) continue;
                hits.push({ query: q.query, title: (r.title ?? '').slice(0, 300), url: r.url, snippet: r.content?.slice(0, 300) ?? '' });
            }
        } catch (err) {
            log.warn({ jobId: job.id, geoId, query: q.query, err: err instanceof Error ? err.message : String(err) }, 'discovery query failed — continuing');
        }
        if (queriesRun % 5 === 0) await heartbeat({ stage: 'searching', queries: queriesRun, hits: hits.length });
    }
    // Rule-A accounting only trusts a round that actually PROBED: a SearXNG outage yields few
    // COMPLETED queries (empty complete:false responses, not throws), and counting that as a
    // "no new channels" round would let two backend outages saturate the cell (review P2 +
    // codex P2). Degraded rounds still classify whatever they did collect, but neither advance
    // rounds_no_new nor assert angles-run.
    const roundValid = queriesCompleted >= Math.max(1, Math.ceil(queries.length / 2));
    await heartbeat({ stage: 'classifying', queries: queriesRun, hits: hits.length, round_degraded: !roundValid });

    // ── Classification (reading role — cheap) + persist + rule A ─────────────
    let usage: Awaited<ReturnType<typeof withLlmMeter>>['usage'] | undefined;
    try {
        const { result: outcome, usage: metered } = await withLlmMeter(async () => {
            let classified: ClassifiedChannel[] = [];
            if (hits.length > 0) {
                const { system, user } = buildChannelClassificationPrompt({ sector, country, localTerms, seedNames, hits });
                const { value } = await runLlmJson('reading', channelClassificationSchema, {
                    system,
                    messages: [{ role: 'user', content: user }],
                    effort: 'low',
                    maxTokens: 8000,
                });
                classified = value.channels;
            }

            // Only URLs that actually appeared in the sweep survive (the prompt forbids invention;
            // this enforces it) — keyed by normalized URL, same normalization as the dedup below.
            const presented = new Set(hits.map((h) => normalizeChannelUrl(h.url)));
            const grounded = classified.filter(
                (c) => presented.has(normalizeChannelUrl(c.url)) &&
                       (!c.member_list_url || presented.has(normalizeChannelUrl(c.member_list_url)))
            );

            // Per-cell URL dedup against existing rows (091 unique index is the race backstop).
            const { data: existingRows, error: exErr } = await researchSupabaseAdmin
                .from('research_channels')
                .select('url')
                .eq('tenant_id', tenantId)
                .eq('icp_id', geo.icp_id)
                .eq('geo_id', geoId);
            if (exErr) throw exErr;
            const known = new Set(
                ((existingRows ?? []) as Array<{ url: string | null }>)
                    .map((r) => (r.url ? normalizeChannelUrl(r.url) : null))
                    .filter((u): u is string => !!u)
            );

            let inserted = 0;
            const seenThisRun = new Set<string>();
            for (const c of grounded) {
                const key = normalizeChannelUrl(c.url);
                if (known.has(key) || seenThisRun.has(key)) continue;
                seenThisRun.add(key);
                const { error: insErr } = await researchSupabaseAdmin.from('research_channels').insert({
                    tenant_id: tenantId,
                    project_id: geo.project_id,
                    icp_id: geo.icp_id,
                    geo_id: geoId,
                    type: c.type,
                    name: c.name,
                    url: c.url,
                    member_list_url: c.member_list_url ?? null,
                    discovery_round: round,
                    note: c.note ?? null,
                    discovered_by_job_id: job.id,
                });
                if (insErr) {
                    if (insErr.code === '23505') continue; // concurrent round wrote it — theirs wins
                    throw insErr;
                }
                inserted++;
            }

            // Rule-A state: rounds-without-new is CONSECUTIVE (a productive round resets it),
            // and only a VALID round moves it or asserts angles-run — a degraded sweep leaves
            // both exactly as they were (the shallow coverage merge preserves absent keys).
            const prior = await readCellChunk(tenantId, geo.icp_id as string, geoId);
            const priorRoundsNoNew = prior?.discovery_rounds_no_new ?? 0;
            const roundsNoNew = roundValid ? (inserted === 0 ? priorRoundsNoNew + 1 : 0) : priorRoundsNoNew;
            const priorAnglesRun = prior?.coverage?.discovery_angles_run === true;
            const ruleA = await evaluateRuleA({
                tenantId, icpId: geo.icp_id as string, geoId,
                roundsNoNew, anglesRun: roundValid || priorAnglesRun,
            });
            await updateChunkCoverageSafe({
                tenantId, jobId: job.id, worker, lease,
                projectId: geo.project_id as string,
                icpId: geo.icp_id as string, geoId,
                channelsFound: ruleA.channelsTotal,
                channelsHarvested: ruleA.channelsTotal - ruleA.channelsPending,
                saturationA: ruleA.saturationA,
                roundsNoNew,
                coverage: {
                    ...(roundValid ? { discovery_angles_run: true } : {}),
                    discovery_last_round: round,
                    discovery_last_round_degraded: !roundValid,
                    discovery_missing_categories: ruleA.missingCategories,
                },
            });

            return {
                geo_id: geoId,
                icp_id: geo.icp_id,
                country,
                round,
                round_degraded: !roundValid,
                queries_run: queriesRun,
                queries_completed: queriesCompleted,
                queries_planned: queries.length,
                hits: hits.length,
                classified: classified.length,
                grounded: grounded.length,
                channels_new: inserted,
                channels_total: ruleA.channelsTotal,
                channels_pending: ruleA.channelsPending,
                rounds_no_new: roundsNoNew,
                rounds_no_new_required: RULE_A_NO_NEW_ROUNDS,
                missing_categories: ruleA.missingCategories,
                saturation_a: ruleA.saturationA,
            };
        });
        usage = metered;

        log.info({ jobId: job.id, ...outcome }, 'channels:discover round complete');
        return {
            ...outcome,
            usage_raw: usage,
            cost_usd: costFromUsageSummary(usage),
        };
    } catch (err) {
        const partial = (err && typeof err === 'object') ? (err as MeteredError).llmUsage : undefined;
        if (partial && partial.totalCalls > 0) {
            log.warn({ jobId: job.id, usage_raw: partial }, 'channels:discover failed after spending — partial COGS');
        }
        throw err;
    }
}
