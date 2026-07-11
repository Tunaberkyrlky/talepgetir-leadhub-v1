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
    flow_state: {
        step?: number;
        completed_gates?: string[];
        icp_card_index?: number;
        geo_card_index?: number;
        calibration_company_index?: number;
        calibration_icp_id?: string | null;
        offer_card_index?: number;
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
