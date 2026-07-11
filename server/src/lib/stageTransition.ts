import { supabaseAdmin } from './supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from './logger.js';
import { lookupCoordinates } from './geocoder.js';
import { getTenantStages, type TenantStage } from '../routes/settings.js';
import { invalidateOverviewCache, invalidatePipelineStatsCache } from '../routes/statistics.js';

const log = createLogger('lib:stageTransition');

// Single source of truth for every company stage change. All surfaces
// (drag-drop PATCH, edit-form PUT, bulk, closing-report) share these rules:
//   • moving INTO a terminal stage requires a closing report  → 422 closing_report_required
//   • moving OUT of a terminal stage (reopen) requires a reason → 422 reopen_reason_required
//   • normal + reopen moves write a `status_change` timeline line (mirrors recordOwnerChanges)
//   • terminal moves delegate to the atomic close_company RPC (writes the sonlandirma_raporu)

export interface ClosingReportInput {
    outcome: string;
    summary: string;
    detail?: string | null;
    visibility: string;
    occurred_at?: string | null;
}

export type StageTransitionResult =
    | { kind: 'closed'; activity: unknown }
    | { kind: 'moved'; company: Record<string, unknown> };

/** Resolve a slug → { stage_type, display_name } via the cached tenant stages. */
function stageLabel(stages: TenantStage[], slug: string | null): string {
    if (!slug) return '—';
    return stages.find((s) => s.slug === slug)?.display_name || slug;
}

/**
 * Records a stage change on a company's timeline as a system `status_change` activity
 * (the type is intentionally reused — no new activity type). Best-effort: a failure here
 * must not undo the stage update itself, so the caller ignores the result. Kept internal
 * visibility as an ops audit line, matching recordOwnerChanges.
 */
export async function recordStageChangeActivity(params: {
    tenantId: string;
    actorId: string;
    companyId: string;
    oldSlug: string | null;
    newSlug: string;
    reopenReason?: string | null;
    stages: TenantStage[];
}): Promise<void> {
    const { tenantId, actorId, companyId, oldSlug, newSlug, reopenReason, stages } = params;
    try {
        const oldLabel = stageLabel(stages, oldSlug);
        const newLabel = stageLabel(stages, newSlug);
        const summary = reopenReason
            ? `Kayıt yeniden açıldı: ${oldLabel} → ${newLabel} · Neden: ${reopenReason}`
            : `Aşama değişikliği: ${oldLabel} → ${newLabel}`;
        const { error } = await supabaseAdmin.from('activities').insert({
            tenant_id: tenantId,
            company_id: companyId,
            type: 'status_change',
            summary,
            detail: reopenReason || null,
            visibility: 'internal',
            occurred_at: new Date().toISOString(),
            created_by: actorId,
        });
        if (error) log.warn({ err: error }, 'Record stage change activity failed');
    } catch (err) {
        log.warn({ err }, 'Record stage change activity failed');
    }
}

export interface StageTransitionGuard {
    stages: TenantStage[];
    currentType: string | null;
    targetType: string;
    isTerminalTarget: boolean;
    isReopen: boolean;
}

/**
 * Validates a proposed transition and throws a coded 422 when a closing report or
 * reopen reason is missing. Shared by the PUT edit-form path (which owns its own
 * multi-field update) and by transitionCompanyStage below. Returns the classification
 * so the caller can decide what to persist.
 */
export function assertStageTransition(params: {
    stages: TenantStage[];
    currentSlug: string | null;
    targetSlug: string;
    hasClosingReport: boolean;
    reopenReason?: string | null;
}): StageTransitionGuard {
    const { stages, currentSlug, targetSlug, hasClosingReport } = params;
    const reopenReason = params.reopenReason?.trim() || null;

    const target = stages.find((s) => s.slug === targetSlug);
    if (!target) throw new AppError('The selected pipeline stage is not valid', 400);

    const currentType = stages.find((s) => s.slug === currentSlug)?.stage_type ?? null;
    const targetType = target.stage_type;
    const isTerminalTarget = targetType === 'terminal';
    const isReopen = currentType === 'terminal' && targetType !== 'terminal';

    if (isTerminalTarget && !hasClosingReport) {
        throw new AppError(
            'A closing report is required to move a company to this stage.',
            422,
            'closing_report_required',
        );
    }
    if (isReopen && !reopenReason) {
        throw new AppError(
            'A reason is required to reopen a closed company.',
            422,
            'reopen_reason_required',
        );
    }

    return { stages, currentType, targetType, isTerminalTarget, isReopen };
}

/** Auto-geocode when a company enters a pipeline stage and has a location but no coords yet. */
function pipelineGeocode(
    targetType: string,
    location: string | null,
    latitude: number | null,
): { latitude?: number; longitude?: number; country?: string | null } {
    if (targetType !== 'pipeline' && targetType !== 'terminal') return {};
    if (!location || latitude != null) return {};
    const coords = lookupCoordinates(location);
    if (!coords) return {};
    return { latitude: coords.lat, longitude: coords.lng, country: coords.country };
}

/**
 * The single entry point for a single-company stage change. Loads the current stage,
 * enforces the closing-report / reopen-reason contract, persists the move and its
 * timeline entry (or delegates a terminal move to close_company), and busts the
 * statistics caches. Callers: PATCH /companies/:id/stage and the closing-report route.
 */
export async function transitionCompanyStage(params: {
    tenantId: string;
    userId: string;
    companyId: string;
    targetStage: string;
    closingReport?: ClosingReportInput;
    reopenReason?: string | null;
}): Promise<StageTransitionResult> {
    const { tenantId, userId, companyId, targetStage, closingReport } = params;
    const reopenReason = params.reopenReason?.trim() || null;

    const stages = await getTenantStages(tenantId);

    const { data: current, error: fetchErr } = await supabaseAdmin
        .from('companies')
        .select('id, stage, location, latitude')
        .eq('id', companyId)
        .eq('tenant_id', tenantId)
        .single();

    if (fetchErr || !current) throw new AppError('Company not found', 404);

    const guard = assertStageTransition({
        stages,
        currentSlug: current.stage,
        targetSlug: targetStage,
        hasClosingReport: !!closingReport,
        reopenReason,
    });

    // Terminal move → atomic close_company RPC (fetch+lock, insert sonlandirma_raporu,
    // update stage, insert audit — all in one transaction). Never duplicated here.
    if (guard.isTerminalTarget) {
        const { data: activity, error } = await supabaseAdmin.rpc('close_company', {
            p_tenant_id: tenantId,
            p_company_id: companyId,
            p_outcome: closingReport!.outcome,
            p_summary: closingReport!.summary,
            p_detail: closingReport!.detail || null,
            p_visibility: closingReport!.visibility,
            p_occurred_at: closingReport!.occurred_at || null,
            p_created_by: userId,
        });
        if (error) {
            if (error.message?.includes('Company not found')) throw new AppError('Company not found', 404);
            log.error({ err: error }, 'close_company RPC error');
            throw new AppError('Failed to create closing report', 500);
        }
        invalidateOverviewCache(tenantId);
        invalidatePipelineStatsCache(tenantId);
        return { kind: 'closed', activity };
    }

    // Normal move or reopen → single update + timeline line. Compare-and-swap on the
    // stage we validated against (current.stage): if a concurrent terminal close slips in
    // between the guard and this write, the CAS matches 0 rows and we refuse — otherwise a
    // stale normal move could silently reopen a closed company with no reopen reason.
    const now = new Date().toISOString();
    let updateQuery = supabaseAdmin
        .from('companies')
        .update({
            stage: targetStage,
            updated_at: now,
            stage_changed_at: now,
            ...pipelineGeocode(guard.targetType, current.location, current.latitude),
        })
        .eq('id', companyId)
        .eq('tenant_id', tenantId);
    updateQuery = current.stage === null
        ? updateQuery.is('stage', null)
        : updateQuery.eq('stage', current.stage);
    const { data: company, error } = await updateQuery.select().maybeSingle();

    if (error) {
        log.error({ err: error }, 'Stage update error');
        throw new AppError('Failed to update stage', 500);
    }
    if (!company) {
        // CAS miss: the row either vanished (404) or its stage moved under us (409).
        const { data: fresh, error: freshErr } = await supabaseAdmin
            .from('companies')
            .select('stage')
            .eq('id', companyId)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (freshErr) throw new AppError('Failed to update stage', 500);
        if (!fresh) throw new AppError('Company not found', 404);
        throw new AppError(
            'The stage changed during this transition. Please retry.',
            409,
            'stage_conflict',
        );
    }

    invalidateOverviewCache(tenantId);
    invalidatePipelineStatsCache(tenantId);

    // Only log when the stage actually changed (avoid a no-op timeline line).
    if (current.stage !== targetStage) {
        await recordStageChangeActivity({
            tenantId,
            actorId: userId,
            companyId,
            oldSlug: current.stage,
            newSlug: targetStage,
            reopenReason: guard.isReopen ? reopenReason : null,
            stages,
        });
    }

    return { kind: 'moved', company: company as Record<string, unknown> };
}
