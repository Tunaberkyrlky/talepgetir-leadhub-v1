import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Container,
    Title,
    SimpleGrid,
    Loader,
    Center,
    Stack,
    Text,
    Button,
    Paper,
} from '@mantine/core';
import {
    IconBuilding,
    IconUsers,
    IconTrendingUp,
    IconTrophy,
    IconPercentage,
    IconChartBar,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { hasTierAccess, type Tier } from '../lib/permissions';
import StatCard from '../components/StatCard';
import StageVerticalBar from '../components/charts/StageVerticalBar';
import PipelineFunnel from '../components/charts/PipelineFunnel';
import type { CompanyLocation } from '../components/GlobeMap';

const GlobeMap = lazy(() => import('../components/GlobeMap'));

interface OverviewData {
    totalCompanies: number;
    totalContacts: number;
    activeDeals: number;
    wonDeals: number;
    conversionRate: number;
    companiesByStage: Record<string, number>;
}

interface PipelineData {
    funnel: { stage: string; count: number }[];
    terminal: { stage: string; count: number }[];
}

export default function DashboardPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { user, activeTenantTier } = useAuth();
    const role = user?.role || '';
    const tier = (activeTenantTier || 'basic') as Tier;
    const isAdvanced = hasTierAccess(role, tier, 'advanced_stats');

    const handleStageClick = useCallback((stage: string) => {
        navigate(`/pipeline?focus=${stage}`);
    }, [navigate]);

    // Overview — always loaded, refetch every visit & periodically
    const { data: overview, isLoading: overviewLoading, error: overviewError } = useQuery<OverviewData>({
        queryKey: ['statistics', 'overview'],
        queryFn: async () => (await api.get('/statistics/overview')).data,
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        refetchInterval: 5 * 60_000,
    });

    // Company locations — for globe map (pro tier only)
    const { data: companyLocations, isLoading: locationsLoading } = useQuery<{ data: CompanyLocation[] }>({
        queryKey: ['statistics', 'company-locations'],
        queryFn: async () => (await api.get('/statistics/company-locations')).data,
        enabled: isAdvanced,
        staleTime: 5 * 60_000,
        refetchOnWindowFocus: false,
    });

    // Pipeline — Pro tier or internal
    const { data: pipeline } = useQuery<PipelineData>({
        queryKey: ['statistics', 'pipeline'],
        queryFn: async () => (await api.get('/statistics/pipeline')).data,
        enabled: isAdvanced,
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        refetchInterval: isAdvanced ? 5 * 60_000 : false,
    });

    if (overviewError) {
        return (
            <Container size="xl" py="xl">
                <Center>
                    <Stack align="center">
                        <Text c="red">{t('common.error')}</Text>
                        <Button variant="light" onClick={() => window.location.reload()}>
                            {t('common.retry')}
                        </Button>
                    </Stack>
                </Center>
            </Container>
        );
    }

    if (overviewLoading) {
        return (
            <Container size="xl" py="xl">
                <Center py={120}>
                    <Loader size="lg" color="violet" />
                </Center>
            </Container>
        );
    }

    return (
        <Container size="xl" py="lg">
            <Title order={2} fw={700} mb="lg">
                {t('nav.dashboard')}
            </Title>

            {/* Stat Cards — always visible */}
            <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} mb="lg">
                <StatCard
                    title={t('dashboard.totalCompanies')}
                    value={overview?.totalCompanies ?? 0}
                    icon={<IconBuilding size={22} />}
                    color="violet"
                />
                <StatCard
                    title={t('dashboard.totalContacts')}
                    value={overview?.totalContacts ?? 0}
                    icon={<IconUsers size={22} />}
                    color="blue"
                />
                <StatCard
                    title={t('dashboard.activeDeals')}
                    value={overview?.activeDeals ?? 0}
                    icon={<IconTrendingUp size={22} />}
                    color="cyan"
                />
                <StatCard
                    title={t('dashboard.wonDeals')}
                    value={overview?.wonDeals ?? 0}
                    icon={<IconTrophy size={22} />}
                    color="green"
                />
            </SimpleGrid>

            {/* Stage Distribution — always visible (basic view) */}
            <Paper shadow="sm" radius="lg" p="lg" mb="lg" withBorder>
                <Text size="sm" fw={700} mb="md" tt="uppercase" c="dimmed" style={{ letterSpacing: '0.5px' }}>
                    {t('dashboard.stageDistribution')}
                </Text>
                {Object.entries(overview?.companiesByStage || {}).some(
                    ([stage, count]) => stage !== 'cold' && count > 0
                ) ? (
                    <StageVerticalBar data={overview?.companiesByStage || {}} onStageClick={handleStageClick} />
                ) : (
                    <Text c="dimmed" size="sm" ta="center" py="md">
                        {t('dashboard.noStageData')}
                    </Text>
                )}
            </Paper>

            {/* Conversion Rate — always visible */}
            {overview && overview.conversionRate > 0 && (
                <SimpleGrid cols={{ base: 1, md: 2 }} mb="lg">
                    <StatCard
                        title={t('dashboard.conversionRate')}
                        value={`${overview.conversionRate}%`}
                        icon={<IconPercentage size={22} />}
                        color="teal"
                        description={t('dashboard.conversionDesc')}
                    />
                </SimpleGrid>
            )}

            {/* World Map — Pro tier / Internal only */}
            {isAdvanced ? (
                <Suspense fallback={<Center style={{ height: 320 }}><Loader color="violet" /></Center>}>
                    <GlobeMap
                        data={companyLocations?.data || []}
                        isLoading={locationsLoading}
                    />
                </Suspense>
            ) : (
                <Paper shadow="sm" radius="lg" p="xl" mb="lg" withBorder>
                    <Center>
                        <Stack align="center" gap="sm">
                            <IconChartBar size={48} color="#6c63ff" stroke={1.5} />
                            <Text fw={600} size="lg">
                                {t('dashboard.upgradeTitle')}
                            </Text>
                            <Text c="dimmed" size="sm" ta="center" maw={400}>
                                {t('dashboard.upgradeDesc')}
                            </Text>
                        </Stack>
                    </Center>
                </Paper>
            )}

            {/* Pro tier / Internal — pipeline funnel */}
            {isAdvanced && pipeline && (
                <SimpleGrid cols={{ base: 1, md: 2 }} mb="lg">
                    <PipelineFunnel
                        data={pipeline.funnel}
                        title={t('dashboard.pipelineFunnel')}
                        onStageClick={handleStageClick}
                    />
                </SimpleGrid>
            )}
        </Container>
    );
}
