import { createContext, useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';

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
    refetch: () => void;
}

const StagesContext = createContext<StagesContextValue | null>(null);

export function StagesProvider({ children }: { children: React.ReactNode }) {
    const { t, i18n } = useTranslation();

    const { data, isLoading, refetch } = useQuery<StageDefinition[]>({
        queryKey: ['settings', 'stages'],
        queryFn: async () => (await api.get('/settings/stages')).data.data,
        staleTime: 5 * 60 * 1000,
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
            refetch: () => { refetch(); },
        };
    }, [data, isLoading, refetch, t, i18n]);

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
