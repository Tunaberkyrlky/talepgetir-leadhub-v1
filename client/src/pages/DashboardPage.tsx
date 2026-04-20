import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
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
    Group,
    SegmentedControl,
    ThemeIcon,
    ActionIcon,
    ScrollArea,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { type DatePeriod, getDateRange, shiftPeriod, formatPeriodLabel, getCustomDateRange, toLocalDateStr, formatAgendaDayLabel, getDateUrgencyColor } from '../lib/dateUtils';
import {
    IconBuilding,
    IconTrendingUp,
    IconTrophy,
    IconPercentage,
    IconChartBar,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { hasTierAccess, type Tier } from '../lib/permissions';
import StatCard from '../components/StatCard';
import StageVerticalBar from '../components/charts/StageVerticalBar';
import PipelineFunnel from '../components/charts/PipelineFunnel';
import AgendaDayGroup from '../components/AgendaDayGroup';
import type { CompanyLocation } from '../components/GlobeMap';
import type { Activity } from '../types/activity';

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

type DashboardPeriod = DatePeriod | 'all' | 'custom';

export default function DashboardPage() {
    const { t, i18n } = useTranslation();
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';
    const navigate = useNavigate();
    const { user, activeTenantTier } = useAuth();
    const role = user?.role || '';
    const tier = (activeTenantTier || 'basic') as Tier;
    const isAdvanced = hasTierAccess(role, tier, 'advanced_stats');

    const [period, setPeriod] = useState<DashboardPeriod>('month');
    const [periodAnchor, setPeriodAnchor] = useState<Date>(new Date());
    const [customRange, setCustomRange] = useState<[Date | null, Date | null]>([null, null]);

    const dateParams = useMemo(() => {
        if (period === 'all') return null;
        if (period === 'custom') {
            if (!customRange[0] || !customRange[1]) return null;
            return getCustomDateRange(customRange[0], customRange[1]);
        }
        return getDateRange(period, periodAnchor);
    }, [period, periodAnchor, customRange]);

    const handleStageClick = useCallback((stage: string) => {
        navigate(`/pipeline?focus=${stage}`);
    }, [navigate]);

    // Overview — always loaded, refetch every visit & periodically
    const { data: overview, isLoading: overviewLoading, error: overviewError } = useQuery<OverviewData>({
        queryKey: ['statistics', 'overview', dateParams],
        queryFn: async () => {
            const params = new URLSearchParams();
            if (dateParams?.dateFrom) params.set('dateFrom', dateParams.dateFrom);
            if (dateParams?.dateTo) params.set('dateTo', dateParams.dateTo);
            const query = params.toString();
            return (await api.get(`/statistics/overview${query ? `?${query}` : ''}`)).data;
        },
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        refetchInterval: 5 * 60_000,
    });

    // Company locations — for globe map (pro tier only)
    const queryClient = useQueryClient();
    const { data: companyLocations, isLoading: locationsLoading, error: locationsError } = useQuery<{ data: CompanyLocation[], missingCount: number }>({
        queryKey: ['statistics', 'company-locations', dateParams],
        queryFn: async () => {
            const params = new URLSearchParams();
            if (dateParams?.dateFrom) params.set('dateFrom', dateParams.dateFrom);
            if (dateParams?.dateTo) params.set('dateTo', dateParams.dateTo);
            const query = params.toString();
            return (await api.get(`/statistics/company-locations${query ? `?${query}` : ''}`)).data;
        },
        enabled: isAdvanced,
        staleTime: 5 * 60_000,
        refetchOnWindowFocus: false,
    });

    const [geocodeLoading, setGeocodeLoading] = useState(false);
    const [geocodeStages, setGeocodeStages] = useState<{ message: string; status: 'active' | 'done' | 'error' }[]>([]);

    // Auto-clear stages 7s after completion
    useEffect(() => {
        if (!geocodeLoading && geocodeStages.length > 0) {
            const timer = setTimeout(() => setGeocodeStages([]), 7000);
            return () => clearTimeout(timer);
        }
    }, [geocodeLoading, geocodeStages.length]);

    const handleGeocode = useCallback(async () => {
        if (geocodeLoading) return;
        setGeocodeLoading(true);
        setGeocodeStages([]);

        const API_URL = import.meta.env.VITE_API_URL || '/api';
        const activeTenantId = localStorage.getItem('activeTenantId');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (activeTenantId && activeTenantId !== 'null') headers['X-Tenant-Id'] = activeTenantId;

        try {
            const response = await fetch(`${API_URL}/companies/geocode`, {
                method: 'POST',
                credentials: 'include',
                headers,
            });

            if (!response.body) throw new Error('No response body');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (data.type === 'progress') {
                            setGeocodeStages(prev => [
                                ...prev.map(s => ({ ...s, status: 'done' as const })),
                                { message: data.message, status: 'active' as const },
                            ]);
                        } else if (data.type === 'result') {
                            setGeocodeStages(prev => prev.map(s => ({ ...s, status: 'done' as const })));
                            queryClient.invalidateQueries({ queryKey: ['statistics', 'company-locations'] });
                            if (data.geocoded > 0) {
                                const msg = data.skipped
                                    ? t('dashboard.geocodeSuccessWithSkipped', { geocoded: data.geocoded, total: data.total, skipped: data.skipped })
                                    : t('dashboard.geocodeSuccess', { geocoded: data.geocoded, total: data.total });
                                showSuccess(msg);
                                if (data.noLocation > 0) {
                                    notifications.show({ message: t('dashboard.geocodeNoLocation', { count: data.noLocation }), color: 'yellow' });
                                }
                            } else if (data.total === 0 && data.noLocation > 0) {
                                notifications.show({ message: t('dashboard.geocodeNoneFoundWithNoLocation', { totalPipeline: data.totalPipeline, noLocation: data.noLocation }), color: 'yellow' });
                            } else if (data.total === 0) {
                                notifications.show({ message: t('dashboard.geocodeNoneFound'), color: 'blue' });
                            } else {
                                notifications.show({ message: t('dashboard.geocodeNoneResolved', { total: data.total }), color: 'yellow' });
                            }
                        } else if (data.type === 'error') {
                            setGeocodeStages(prev => [
                                ...prev.map(s => ({ ...s, status: 'done' as const })),
                                { message: data.message, status: 'error' as const },
                            ]);
                        }
                    } catch {
                        // ignore malformed SSE lines
                    }
                }
            }
        } catch (err) {
            showErrorFromApi(err, t('dashboard.geocodeError'));
            setGeocodeStages(prev => [
                ...prev.map(s => ({ ...s, status: 'done' as const })),
                { message: t('dashboard.geocodeError'), status: 'error' as const },
            ]);
        } finally {
            setGeocodeLoading(false);
        }
    }, [geocodeLoading, queryClient, t]);

    useEffect(() => {
        if (locationsError) showErrorFromApi(locationsError, t('dashboard.locationsError'));
    }, [locationsError, t]);

    // Pipeline — Pro tier or internal
    const { data: pipeline, error: pipelineError } = useQuery<PipelineData>({
        queryKey: ['statistics', 'pipeline', dateParams],
        queryFn: async () => {
            const params = new URLSearchParams();
            if (dateParams?.dateFrom) params.set('dateFrom', dateParams.dateFrom);
            if (dateParams?.dateTo) params.set('dateTo', dateParams.dateTo);
            const query = params.toString();
            return (await api.get(`/statistics/pipeline${query ? `?${query}` : ''}`)).data;
        },
        enabled: isAdvanced,
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        refetchInterval: isAdvanced ? 5 * 60_000 : false,
    });

    useEffect(() => {
        if (pipelineError) showErrorFromApi(pipelineError, t('dashboard.pipelineError'));
    }, [pipelineError, t]);

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
            <Group justify="space-between" align="center" mb="lg" wrap="wrap" gap="sm">
                <Title order={2} fw={700}>
                    {t('nav.dashboard')}
                </Title>
                <Group gap="xs" wrap="nowrap" justify="flex-end">
                    <SegmentedControl
                        value={period}
                        onChange={(v) => {
                            setPeriod(v as DashboardPeriod);
                            setPeriodAnchor(new Date());
                        }}
                        data={[
                            { label: t('filter.all'), value: 'all' },
                            { label: t('activities.periodDay'), value: 'day' },
                            { label: t('activities.periodWeek'), value: 'week' },
                            { label: t('activities.periodMonth'), value: 'month' },
                            { label: t('activities.periodCustom'), value: 'custom' },
                        ]}
                        size="xs"
                    />
                    {period !== 'all' && period !== 'custom' && (
                        <Group gap={4} wrap="nowrap">
                            <ActionIcon
                                variant="subtle"
                                color="gray"
                                size="sm"
                                onClick={() => setPeriodAnchor((prev) => shiftPeriod(period, prev, -1))}
                            >
                                <IconChevronLeft size={14} />
                            </ActionIcon>
                            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap', minWidth: 120, textAlign: 'center' }}>
                                {formatPeriodLabel(period, periodAnchor, locale)}
                            </Text>
                            <ActionIcon
                                variant="subtle"
                                color="gray"
                                size="sm"
                                onClick={() => setPeriodAnchor((prev) => shiftPeriod(period, prev, 1))}
                            >
                                <IconChevronRight size={14} />
                            </ActionIcon>
                            <Button
                                size="compact-xs"
                                variant="light"
                                color="violet"
                                onClick={() => setPeriodAnchor(new Date())}
                            >
                                {t('activities.today')}
                            </Button>
                        </Group>
                    )}
                    {period === 'custom' && (
                        <DatePickerInput
                            type="range"
                            placeholder={t('activities.dateRange')}
                            value={customRange}
                            onChange={(v) => setCustomRange(v as [Date | null, Date | null])}
                            clearable
                            size="xs"
                        />
                    )}
                </Group>
            </Group>

            {/* Stat Cards — always visible */}
            <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} mb="lg">
                {/* Combined companies + contacts card */}
                <Paper shadow="sm" radius="lg" p="lg" withBorder>
                    <Group justify="space-between" align="flex-start" wrap="nowrap">
                        <Stack gap={4}>
                            <Text size="xs" tt="uppercase" fw={700} c="dimmed" style={{ letterSpacing: '0.5px' }}>
                                {t('dashboard.totalCompanies')}
                            </Text>
                            <Group gap={6} align="baseline" wrap="nowrap">
                                <Text fw={800} style={{ fontSize: '2rem', lineHeight: 1.1 }}>
                                    {overview?.totalCompanies ?? 0}
                                </Text>
                                <Text size="sm" c="dimmed" fw={500} style={{ whiteSpace: 'nowrap' }}>
                                    / {overview?.totalContacts ?? 0} {t('dashboard.contacts', 'kişi')}
                                </Text>
                            </Group>
                        </Stack>
                        <ThemeIcon color="violet" variant="light" size="xl" radius="md" style={{ flexShrink: 0 }}>
                            <IconBuilding size={22} />
                        </ThemeIcon>
                    </Group>
                </Paper>
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
                <StatCard
                    title={t('dashboard.conversionRate')}
                    value={`${overview?.conversionRate ?? 0}%`}
                    icon={<IconPercentage size={22} />}
                    color="teal"
                    description={t('dashboard.conversionDesc')}
                />
            </SimpleGrid>

            {/* Stage Distribution + Upcoming Agenda */}
            <SimpleGrid cols={{ base: 1, md: 2 }} mb="lg">
                <Paper shadow="sm" radius="lg" p="lg" withBorder>
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
                <UpcomingAgendaWidget />
            </SimpleGrid>

{/* World Map — Pro tier / Internal only */}
            {isAdvanced ? (
                <>
                    <Suspense fallback={<Center style={{ height: 320 }}><Loader color="violet" /></Center>}>
                        <GlobeMap
                            data={companyLocations?.data || []}
                            missingCount={companyLocations?.missingCount || 0}
                            isLoading={locationsLoading}
                            onGeocode={handleGeocode}
                            geocodeLoading={geocodeLoading}
                            geocodeStages={geocodeStages}
                            canGeocode={['superadmin', 'ops_agent', 'client_admin'].includes(role)}
                        />
                    </Suspense>
                </>
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

// ─── Upcoming Agenda Widget (Dashboard) ──────────────────────────────────────

function UpcomingAgendaWidget() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';

    const now = new Date();
    const past3 = new Date(now); past3.setDate(now.getDate() - 3);
    const future7 = new Date(now); future7.setDate(now.getDate() + 7);
    const dateFrom = toLocalDateStr(past3);
    const dateTo = `${toLocalDateStr(future7)}T23:59:59`;

    const { data } = useQuery<{ data: Activity[] }>({
        queryKey: ['dashboard-upcoming', dateFrom, dateTo],
        queryFn: async () => (await api.get('/activities/all', {
            params: { date_from: dateFrom, date_to: dateTo, limit: '30' },
        })).data,
        staleTime: 60_000,
    });

    const todayStr = toLocalDateStr(now);
    const activities = data?.data || [];

    // Only future + overdue, exclude system types
    const relevant = activities.filter(a =>
        ['not', 'meeting', 'follow_up'].includes(a.type)
    );

    // Group by day — skip overdue on dashboard
    const dayMap = new Map<string, Activity[]>();
    for (const a of relevant) {
        const dk = toLocalDateStr(new Date(a.occurred_at));
        if (dk < todayStr) continue; // skip overdue on dashboard
        if (!dayMap.has(dk)) dayMap.set(dk, []);
        dayMap.get(dk)!.push(a);
    }

    type Section = { key: string; label: string; color: string; items: Activity[] };
    const sections: Section[] = [];
    for (const [dk, items] of Array.from(dayMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        sections.push({
            key: dk,
            label: formatAgendaDayLabel(dk, todayStr, locale, t),
            color: getDateUrgencyColor(dk, todayStr),
            items: items.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)),
        });
    }

    // Limit to ~10 activities total for widget
    let shownCount = 0;
    const limitedSections = sections.map(s => {
        const remaining = Math.max(0, 10 - shownCount);
        const limited = s.items.slice(0, remaining);
        shownCount += limited.length;
        return { ...s, items: limited };
    }).filter(s => s.items.length > 0);

    return (
        <Paper shadow="sm" radius="lg" p="lg" withBorder>
            <Group justify="space-between" mb="md">
                <Text size="sm" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.5px' }}>
                    {t('dashboard.upcomingActivities', 'Yaklaşan Aktiviteler')}
                </Text>
                <Button
                    size="compact-xs"
                    variant="subtle"
                    color="violet"
                    onClick={() => navigate('/activities?view=agenda')}
                >
                    {t('activities.viewFullAgenda', 'Tüm Ajandayı Gör')} →
                </Button>
            </Group>

            {limitedSections.length === 0 ? (
                <Center py="lg">
                    <Text c="dimmed" size="sm" fs="italic">
                        {t('activity.noActivities')}
                    </Text>
                </Center>
            ) : (
                <ScrollArea.Autosize mah={360} offsetScrollbars>
                <Stack gap={0}>
                    {limitedSections.map((section) => {
                        const isOverdue = section.key === '__overdue';
                        const dateStr = isOverdue
                            ? ''
                            : new Date(section.key + 'T00:00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short' });
                        return (
                            <AgendaDayGroup
                                key={section.key}
                                label={section.label}
                                dateStr={dateStr}
                                urgencyColor={section.color}
                                activities={section.items}
                                locale={locale}
                                canEdit={false}
                                canDeleteItem={false}
                                onEdit={() => {}}
                                onDelete={() => {}}
                                compact
                            />
                        );
                    })}
                </Stack>
                </ScrollArea.Autosize>
            )}
        </Paper>
    );
}
