/**
 * icp:generate (B5) — ICP Master generation.
 *
 * Loads the project profile (+ approved HS codes + top markets), asks the strategy
 * model (Opus) for several ICP drafts, and persists each into research_icps as a
 * draft: the structured columns hold the editable final the customer will score/refine,
 * while ai_draft freezes the raw model output for eval (how much the human changed it).
 */
import type { HandlerContext } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { runLlmJson } from '../../llm/index.js';
import { withLlmMeter, type MeteredError } from '../../llm/meter.js';
import { costFromUsageSummary } from '../../engine/pricing.js';
import { icpGenerationSchema } from '../../icp/schema.js';
import { buildIcpPrompt } from '../../icp/prompt.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:icp-generate');

export async function icpGenerateHandler({ job, heartbeat }: HandlerContext): Promise<Record<string, unknown>> {
    const projectId = job.project_id;
    if (!projectId) throw new Error('icp:generate requires a project_id');
    const tenantId = job.tenant_id;
    const count = typeof job.payload?.count === 'number' ? job.payload.count : undefined;

    await heartbeat({ stage: 'loading' });

    const { data: project, error: projErr } = await researchSupabaseAdmin
        .from('research_projects')
        .select('id, profile')
        .eq('id', projectId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (projErr) throw projErr;
    if (!project) throw new Error(`research project ${projectId} not found for tenant ${tenantId}`);

    // Optional context — generation works from the profile alone; HS codes / markets refine it.
    // A real query ERROR (not just empty results) means partial context, so fail → the queue
    // retries rather than silently producing a degraded result.
    const { data: hsCodes, error: hsErr } = await researchSupabaseAdmin
        .from('research_hs_codes')
        .select('code, description')
        .eq('project_id', projectId)
        .eq('tenant_id', tenantId)
        .eq('status', 'approved');
    if (hsErr) throw hsErr;

    const { data: markets, error: mErr } = await researchSupabaseAdmin
        .from('research_markets')
        .select('country, import_value, growth_pct')
        .eq('project_id', projectId)
        .eq('tenant_id', tenantId)
        .order('rank', { ascending: true })
        .limit(15);
    if (mErr) throw mErr;

    const { system, messages } = buildIcpPrompt({
        profile: (project.profile ?? {}) as Record<string, unknown>,
        hsCodes: hsCodes ?? undefined,
        markets: markets ?? undefined,
        count,
    });

    await heartbeat({ stage: 'generating' });
    // Metered (1b: the ICP-setup cost line). Opus is NOT in the harvest path, so this is the only
    // place its spend occurs — record raw usage + a dollar estimate in the job result so the admin
    // margin panel can surface per-tenant setup COGS alongside harvest COGS. The catch covers the
    // WHOLE paid section (LLM call + heartbeat + draft persistence — codex): any failure after the
    // spend warn-logs the tally (either the captured one, or the partial withLlmMeter attached to
    // the throw), so a failed-but-paid attempt never disappears from calibration. Durable
    // persistence of failed-run COGS stays a documented roadmap item (05 §1b(3)).
    let usage: Awaited<ReturnType<typeof withLlmMeter>>['usage'] | undefined;
    try {
        const metered = await withLlmMeter(async () =>
            runLlmJson('strategy', icpGenerationSchema, {
                system,
                messages,
                effort: 'high',
                maxTokens: 16000,
            })
        );
        usage = metered.usage;
        const { value, result } = metered.result;

        await heartbeat({ stage: 'persisting', icps: value.icps.length });

        // Fenced, atomic persistence (063 #7): research_persist_icp_drafts clears this job's prior
        // drafts and inserts the current set in ONE transaction, gated on (job, locked_by, lease) —
        // so a reaped, stale attempt whose lease no longer matches can neither double-insert nor
        // clobber the live attempt's rows. ai_draft freezes the raw model output (eval signal); the
        // structured columns are the editable final. The RPC assigns draft_index by array order.
        const { data: ids, error: persistErr } = await researchSupabaseAdmin.rpc('research_persist_icp_drafts', {
            p_tenant: tenantId,
            p_project_id: projectId,
            p_job_id: job.id,
            p_worker: job.locked_by,
            p_lease: job.lease,
            p_drafts: value.icps,
        });
        if (persistErr) throw persistErr;
        const icpIds = (ids as string[] | null) ?? [];

        log.info(
            { jobId: job.id, projectId, count: icpIds.length, model: result.model },
            'icp:generate persisted drafts'
        );

        return {
            icp_ids: icpIds,
            count: icpIds.length,
            provider: result.provider,
            model: result.model,
            // COGS trail (admin-only downstream: 068 hides result from client reads; the API
            // sanitizer strips usage_raw/cost_usd for non-internal roles).
            usage_raw: usage,
            cost_usd: costFromUsageSummary(usage),
        };
    } catch (err) {
        const partialUsage = usage ?? ((err && typeof err === 'object') ? (err as MeteredError).llmUsage : undefined);
        if (partialUsage && partialUsage.totalCalls > 0) {
            log.warn({ jobId: job.id, usage_raw: partialUsage }, 'icp:generate failed after spending — partial COGS');
        }
        throw err;
    }
}
