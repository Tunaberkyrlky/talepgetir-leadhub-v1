import { createContext, useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from './AuthContext';

export interface StageDefinition {
    id: string;
    slug: string;
    display_name: string;
    color: string;
    sort_order: number;
    stage_type: 'initial' | 'pipeline' | 'terminal';
    is_active: boolean;
}

interface StagesContextValue {
    allStages: StageDefinition[];
    pipelineStages: StageDefinition[];
    terminalStages: StageDefinition[];
    initialStage: StageDefinition | null;
    pipelineStageSlugs: string[];
    terminalStageSlugs: string[];
    getStageColor: (slug: string) => string;
    getStageLabel: (slug: string) => string;
    stageOptions: { value: string; label: string }[];
    isLoading: boolean;
    isError: boolean;
    refetch: () => void;
}

const StagesContext = createContext<StagesContextValue | null>(null);

export function StagesProvider({ children }: { children: React.ReactNode }) {
    const { t, i18n } = useTranslation();
    const { isAuthenticated, activeTenantId } = useAuth();

    const { data, isLoading, isError, refetch } = useQuery<StageDefinition[]>({
        // Tenant-scoped key so switching tenants (internal roles switch via X-Tenant-Id)
        // refetches and never surfaces a previous tenant's cached stages. Prefix-based
        // invalidations (['settings','stages']) still match this longer key.
        queryKey: ['settings', 'stages', activeTenantId],
        queryFn: async ({ queryKey, signal }) => {
            // Pin the tenant to the KEY being fetched (not mutable closure state) so a stale-key
            // refetch after a tenant switch still targets the right tenant. Interceptor preserves it.
            const tid = queryKey[2] as string;
            return (await api.get('/settings/stages', { headers: { 'X-Tenant-Id': tid }, signal })).data.data;
        },
        staleTime: 5 * 60 * 1000,
        enabled: isAuthenticated && !!activeTenantId,
    });

    const value = useMemo<StagesContextValue>(() => {
        const allStages = data || [];

        const pipelineStages = allStages.filter((s) => s.stage_type === 'pipeline');
        const terminalStages = allStages.filter((s) => s.stage_type === 'terminal');
        const initialStage = allStages.find((s) => s.stage_type === 'initial') || null;

        const stageMap = new Map(allStages.map((s) => [s.slug, s]));

        const getStageColor = (slug: string): string => {
            return stageMap.get(slug)?.color || 'gray';
        };

        const resolveLabel = (slug: string, displayName: string): string => {
            // If an English default exists and display_name still matches it,
            // the user hasn't customised this stage → use the active locale translation.
            const englishDefault = i18n.exists(`stages.${slug}`)
                ? i18n.t(`stages.${slug}`, { lng: 'en' })
                : null;
            if (englishDefault && displayName === englishDefault) {
                return t(`stages.${slug}`);
            }
            // Custom name set by the user → use as-is
            return displayName;
        };

        const getStageLabel = (slug: string): string => {
            const stage = stageMap.get(slug);
            if (!stage) return slug;
            return resolveLabel(slug, stage.display_name);
        };

        const stageOptions = allStages.map((s) => ({
            value: s.slug,
            label: resolveLabel(s.slug, s.display_name),
        }));

        return {
            allStages,
            pipelineStages,
            terminalStages,
            initialStage,
            pipelineStageSlugs: pipelineStages.map((s) => s.slug),
            terminalStageSlugs: terminalStages.map((s) => s.slug),
            getStageColor,
            getStageLabel,
            stageOptions,
            isLoading,
            isError,
            refetch: () => { refetch(); },
        };
    }, [data, isLoading, isError, refetch, t, i18n]);

    return (
        <StagesContext.Provider value={value}>
            {children}
        </StagesContext.Provider>
    );
}

export function useStages(): StagesContextValue {
    const ctx = useContext(StagesContext);
    if (!ctx) throw new Error('useStages must be used within StagesProvider');
    return ctx;
}
