/**
 * Shared "does this tenant have a research project yet" fetch (WP6).
 * Both RootRedirect (onboarding gate at "/") and ResearchFlowPage (the wizard) need the
 * exact same answer to "what's the tenant's most recent research project" — they MUST
 * share one react-query cache key so that creating the tenant's first project from the
 * wizard immediately invalidates what RootRedirect sees on the next visit to "/". Two
 * different keys for the same fetch is how that cache went stale (WP6 review P2).
 */
import { useQuery } from '@tanstack/react-query';
import api from './api';
import { useAuth } from '../contexts/AuthContext';

export interface ResearchProjectSummary {
    id: string;
    name: string;
    profile: Record<string, unknown> | null;
    // icp_card_index/geo_card_index: WP8a additive keys in the same flow_state JSONB column
    // (no migration) — the wizard's persisted cursor into the sub-ICP / geo-cell card review.
    // calibration_company_index: WP8b's own additive key, same reasoning — the persisted
    // cursor into step 12's one-company-per-screen rating review.
    // calibration_icp_id: WP8b P1-C fix additive key, same reasoning — pins WHICH ICP steps
    // 11-14 are calibrating, so it survives a reload instead of being recomputed every render
    // (recomputing let apply-revision's approved->draft demotion flip or null the target mid-loop).
    // offer_card_index: WP9's own additive key, same reasoning — the persisted cursor into
    // step 16's one-card-per-screen offer/angle review.
    // reseed_from_draft: additive key set by the wizard's subject-change paths (website/social
    // edit, "research again") — tells the steps 3-5 pre-fill that gate-absent fields are stale
    // after a fresh crawl and must reseed from ai_draft, not the previous subject's confirmed
    // profile values.
    flow_state: {
        step?: number;
        completed_gates?: string[];
        icp_card_index?: number;
        geo_card_index?: number;
        calibration_company_index?: number;
        calibration_icp_id?: string | null;
        offer_card_index?: number;
        reseed_from_draft?: boolean;
    } | null;
}

export interface ResearchProjectsListResponse {
    data: ResearchProjectSummary[];
}

// Keyed by tenant so a tenant switch can never observe the previous tenant's cached
// "latest project" (or lack thereof) before AuthContext's post-switch invalidateQueries()
// round-trips — every consumer that reads/writes this cache (RootRedirect,
// ResearchFlowPage, ResearchPage) must build the key through this function with the
// SAME activeTenantId, not a bare constant.
export function latestResearchProjectQueryKey(tenantId: string | null) {
    return ['research', 'projects', 'latest', tenantId] as const;
}

async function fetchLatestResearchProject(): Promise<ResearchProjectsListResponse> {
    return (await api.get('/research/projects?limit=1')).data;
}

/** The tenant's most recent research project (or an empty list if none exists yet). */
export function useLatestResearchProject() {
    const { activeTenantId } = useAuth();
    return useQuery<ResearchProjectsListResponse>({
        queryKey: latestResearchProjectQueryKey(activeTenantId),
        queryFn: fetchLatestResearchProject,
    });
}

// Threshold for "the tenant finished onboarding": at least one ICP reached the terminal
// 'calibrated' state (server sets it in routes/research/icps.ts mark-calibrated). Structural
// type on purpose — this lib must not import ResearchIcp from the IcpCard component file.
export function isOnboardingComplete(
    icps: ReadonlyArray<{ calibration_state: string }> | null | undefined,
): boolean {
    return !!icps?.some((i) => i.calibration_state === 'calibrated');
}

/**
 * Onboarding-completion gate composed on top of the tenant's latest project and that
 * project's ICPs. The ICP query REUSES ResearchFlowPage's exact key + URL so the cache
 * is shared, never duplicated (same class of stale-cache bug the file header warns about).
 * Loading/error are folded across both queries; consumers should fail open on isError
 * per the RootRedirect convention so a network hiccup never strands a calibrated tenant.
 */
export function useIsOnboardingComplete() {
    const { activeTenantId } = useAuth();
    const latest = useLatestResearchProject();
    const projectId = latest.data?.data?.[0]?.id ?? null;

    const icpsQuery = useQuery<{ data: Array<{ calibration_state: string }> }>({
        queryKey: ['research', 'icps', projectId, activeTenantId],
        queryFn: async () => (await api.get(`/research/icps?project_id=${projectId}`)).data,
        enabled: !!projectId,
    });

    const hasProject = !!projectId;
    return {
        hasProject,
        isComplete: hasProject && isOnboardingComplete(icpsQuery.data?.data),
        // Never report isComplete=false while ICPs are still loading for an existing project.
        isLoading: latest.isLoading || (hasProject && icpsQuery.isLoading),
        isError: latest.isError || icpsQuery.isError,
    };
}
