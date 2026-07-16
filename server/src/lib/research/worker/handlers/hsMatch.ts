/**
 * hs:match (WP11) — propose live-validated HS candidates for approved products.
 *
 * Loads the human-approved product/service list, asks the strategy model for six-digit
 * candidates, then fail-closes every raw guess against the live UN Comtrade nomenclature.
 * Only validated physical-goods candidates reach research_hs_codes for human review.
 */
import type { HandlerContext } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { runLlmJson } from '../../llm/index.js';
import { withLlmMeter, type MeteredError } from '../../llm/meter.js';
import { costFromUsageSummary } from '../../engine/pricing.js';
import { hsMatchSchema } from '../../hs/schema.js';
import { buildHsMatchPrompt } from '../../hs/prompt.js';
import { validateHsCode } from '../../trade/comtrade.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:hs-match');

export async function hsMatchHandler({ job, heartbeat }: HandlerContext): Promise<Record<string, unknown>> {
    const projectId = job.project_id;
    if (!projectId) throw new Error('hs:match requires a project_id');
    const tenantId = job.tenant_id;

    await heartbeat({ stage: 'loading' });

    const { data: project, error: projErr } = await researchSupabaseAdmin
        .from('research_projects')
        .select('id, profile, flow_state')
        .eq('id', projectId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (projErr) throw projErr;
    if (!project) throw new Error(`research project ${projectId} not found for tenant ${tenantId}`);

    const profile = (project.profile ?? {}) as Record<string, unknown>;
    const flowState = (project.flow_state ?? {}) as Record<string, unknown>;
    // 'step4' lands in completed_gates the moment the human saves the products/services step
    // (see ResearchFlowPage.tsx), even if they explicitly cleared the list to empty. That gate
    // is the only reliable signal that profile.products is a real human decision rather than a
    // field the project simply hasn't reached yet — an empty array alone is ambiguous.
    const step4Completed = Array.isArray(flowState.completed_gates) && flowState.completed_gates.includes('step4');
    let products = Array.isArray(profile.products)
        ? profile.products.filter((p): p is string => typeof p === 'string' && !!p.trim())
        : [];
    if (products.length === 0 && !step4Completed) {
        // Fallback for a project that has not reached the human-edited step 4 yet.
        const aiDraft = profile.ai_draft && typeof profile.ai_draft === 'object' && !Array.isArray(profile.ai_draft)
            ? profile.ai_draft as Record<string, unknown>
            : null;
        products = Array.isArray(aiDraft?.products_services)
            ? aiDraft.products_services.filter((p): p is string => typeof p === 'string' && !!p.trim())
            : [];
    }
    if (products.length === 0) {
        return { candidates: 0, dropped_invalid: 0, skipped_no_products: true };
    }

    const { system, messages } = buildHsMatchPrompt({ profile, products });

    await heartbeat({ stage: 'generating' });
    // Strategy spend sits outside the harvest path but still belongs in the admin COGS trail.
    // The catch covers generation, live validation, heartbeat and persistence so any paid
    // failure retains either captured usage or the partial meter attached to the throw.
    let usage: Awaited<ReturnType<typeof withLlmMeter>>['usage'] | undefined;
    try {
        const metered = await withLlmMeter(async () =>
            runLlmJson('strategy', hsMatchSchema, {
                system,
                messages,
                effort: 'high',
                maxTokens: 6000,
            })
        );
        usage = metered.usage;
        const { value, result } = metered.result;

        const survivors: Array<{ code: string; description: string }> = [];
        let droppedInvalid = 0;
        for (const candidate of value.candidates) {
            const code = candidate.code.trim().replace(/\D/g, '');
            if (await validateHsCode(code)) survivors.push({ code, description: candidate.description });
            else droppedInvalid++;
        }
        if (droppedInvalid > 0) {
            log.warn(
                { jobId: job.id, projectId, droppedInvalid, proposed: value.candidates.length },
                'hs:match dropped invalid Comtrade HS candidates'
            );
        }
        const seenCodes = new Set<string>();
        const uniqueSurvivors = survivors.filter((candidate) => {
            if (seenCodes.has(candidate.code)) return false;
            seenCodes.add(candidate.code);
            return true;
        });

        await heartbeat({ stage: 'persisting', candidates: uniqueSurvivors.length });

        // Atomic, job-fenced persistence (research_persist_hs_candidates, migration 151): in ONE
        // transaction it locks THIS job row FOR UPDATE, replaces only the undecided AI candidate set
        // (approved/rejected human decisions are immutable), and inserts the survivors the human
        // hasn't already decided on. It serializes against a concurrent subject-change reset
        // (research_reset_derived_data's UPDATE of the same job row): if the reset canceled this job
        // mid-flight, the RPC sees status != 'running' and returns -1 without writing anything, so
        // stale old-subject candidates can never land after the HS table was cleared. THROW on -1
        // (not return) so the runner does not record a successful (zero-)result — the HS table stays
        // cleared and step 22 re-matches on the new subject. This brings hs:match to parity with the
        // already-fenced ICP/geo persist RPCs (closing the last TOCTOU the plain check-then-write had).
        const { data: insertedCount, error: persistErr } = await researchSupabaseAdmin.rpc('research_persist_hs_candidates', {
            p_tenant: tenantId,
            p_project: projectId,
            p_job: job.id,
            p_locked_by: job.locked_by,
            p_lease: job.lease,
            p_candidates: uniqueSurvivors,
        });
        if (persistErr) throw persistErr;
        if (typeof insertedCount !== 'number') {
            // The fenced RPC always returns an integer; anything else is unexpected. Throw rather
            // than fall through to a zero-success (which would let the client suppress re-matching).
            throw new Error(`hs:match persist returned non-numeric result (${JSON.stringify(insertedCount)})`);
        }
        if (insertedCount === -1) {
            throw new Error(`hs:match superseded — job ${job.id} no longer owns the running lease (subject changed / reaped); skipping stale persistence`);
        }
        const insertable = insertedCount;
        const skippedDecided = uniqueSurvivors.length - insertable;

        log.info(
            { jobId: job.id, projectId, candidates: insertable, skippedDecided, droppedInvalid, model: result.model },
            'hs:match persisted validated candidates'
        );

        return {
            project_id: projectId,
            candidates: insertable,
            skipped_already_decided: skippedDecided,
            dropped_invalid: droppedInvalid,
            proposed: value.candidates.length,
            provider: result.provider,
            model: result.model,
            usage_raw: usage,
            cost_usd: costFromUsageSummary(usage),
        };
    } catch (err) {
        const partialUsage = usage ?? ((err && typeof err === 'object') ? (err as MeteredError).llmUsage : undefined);
        if (partialUsage && partialUsage.totalCalls > 0) {
            log.warn({ jobId: job.id, usage_raw: partialUsage }, 'hs:match failed after spending — partial COGS');
        }
        throw err;
    }
}
