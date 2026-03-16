import { useQuery } from '@tanstack/react-query';
import {
    Container,
    Title,
    SimpleGrid,
    Loader,
    Center,
    Stack,
    Text,
    Button,
    Group,
    Paper,
    Badge,
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
import { stageColors } from '../lib/stages';
import StatCard from '../components/StatCard';
import PipelineFunnel from '../components/charts/PipelineFunnel';

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
    const { user, activeTenantTier } = useAuth();
    const role = user?.role || '';
    const tier = (activeTenantTier || 'basic') as Tier;
    const isAdvanced = hasTierAccess(role, tier, 'advanced_stats');

    // Overview — always loaded
    const { data: overview, isLoading: overviewLoading, error: overviewError } = useQuery<OverviewData>({
        queryKey: ['statistics', 'overview'],
        queryFn: async () => (await api.get('/statistics/overview')).data,
    });

    // Pipeline — Pro tier or internal
    const { data: pipeline } = useQuery<PipelineData>({
        queryKey: ['statistics', 'pipeline'],
        queryFn: async () => (await api.get('/statistics/pipeline')).data,
        enabled: isAdvanced,
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
                <Group gap="xs" wrap="wrap">
                    {Object.entries(overview?.companiesByStage || {})
                        .filter(([stage]) => stage !== 'cold')
                        .sort((a, b) => b[1] - a[1])
                        .map(([stage, count]) => (
                            <Badge
                                key={stage}
                                color={stageColors[stage as keyof typeof stageColors] || 'gray'}
                                variant="light"
                                size="lg"
                                radius="md"
                            >
                                {t(`stages.${stage}`)} — {count}
                            </Badge>
                        ))}
                </Group>
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

            {/* Pro tier / Internal — pipeline funnel */}
            {isAdvanced && pipeline && (
                <SimpleGrid cols={{ base: 1, md: 2 }} mb="lg">
                    <PipelineFunnel
                        data={pipeline.funnel}
                        title={t('dashboard.pipelineFunnel')}
                    />
                </SimpleGrid>
            )}

            {/* Upgrade prompt for basic tier clients */}
            {!isAdvanced && (
                <Paper shadow="sm" radius="lg" p="xl" withBorder>
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
        </Container>
    );
}
