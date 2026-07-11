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
        .select('id, profile')
        .eq('id', projectId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (projErr) throw projErr;
    if (!project) throw new Error(`research project ${projectId} not found for tenant ${tenantId}`);

    const profile = (project.profile ?? {}) as Record<string, unknown>;
    let products = Array.isArray(profile.products)
        ? profile.products.filter((p): p is string => typeof p === 'string' && !!p.trim())
        : [];
    if (products.length === 0) {
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

        // No lease/fence columns exist here: re-runs idempotently replace only the undecided
        // AI set; approved/rejected human decisions are immutable input and are never touched.
        const { error: deleteErr } = await researchSupabaseAdmin
            .from('research_hs_codes')
            .delete()
            .eq('tenant_id', tenantId)
            .eq('project_id', projectId)
            .eq('source', 'ai')
            .eq('status', 'candidate');
        if (deleteErr) throw deleteErr;

        // A code the human already decided on (approved or rejected, any source) must never get
        // a fresh 'candidate' row alongside it — that would let the same code be approved/rejected
        // twice. Only insert survivors the project doesn't already have a decided row for.
        const { data: decidedRows, error: decidedErr } = await researchSupabaseAdmin
            .from('research_hs_codes')
            .select('code')
            .eq('tenant_id', tenantId)
            .eq('project_id', projectId)
            .in('status', ['approved', 'rejected']);
        if (decidedErr) throw decidedErr;
        const decidedCodes = new Set((decidedRows ?? []).map((row) => row.code));
        const insertable = uniqueSurvivors.filter((candidate) => !decidedCodes.has(candidate.code));
        const skippedDecided = uniqueSurvivors.length - insertable.length;

        if (insertable.length > 0) {
            const { error: insertErr } = await researchSupabaseAdmin
                .from('research_hs_codes')
                .insert(insertable.map((candidate) => ({
                    tenant_id: tenantId,
                    project_id: projectId,
                    code: candidate.code,
                    description: candidate.description,
                    status: 'candidate',
                    source: 'ai',
                })));
            if (insertErr) throw insertErr;
        }

        log.info(
            { jobId: job.id, projectId, candidates: insertable.length, skippedDecided, droppedInvalid, model: result.model },
            'hs:match persisted validated candidates'
        );

        return {
            project_id: projectId,
            candidates: insertable.length,
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
