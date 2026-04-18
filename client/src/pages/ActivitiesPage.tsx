import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
    Container, Title, Group, Stack, Paper, Text, Badge, SegmentedControl,
    Loader, Center, Button, SimpleGrid, Select, TextInput, ActionIcon,
    Skeleton, Divider, Menu,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useDebouncedValue } from '@mantine/hooks';
import {
    IconNotes, IconCalendar, IconClock,
    IconUser, IconSearch, IconChevronLeft, IconChevronRight,
    IconDotsVertical, IconPencil, IconTrash,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { isInternal, hasRolePermission, canDelete } from '../lib/permissions';
import api from '../lib/api';
import StatCard from '../components/StatCard';
import { ACTIVITY_ICONS, ACTIVITY_COLORS, OUTCOME_COLORS } from '../lib/activityConstants';
import ActivityForm from '../components/ActivityForm';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import type { Activity, ActivityType } from '../types/activity';

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface ActivitiesResponse {
    data: Activity[];
    pagination: {
        hasNext: boolean;
        total: number;
        page: number;
    };
}

interface ActivityStats {
    meeting: number;
    not: number;
    follow_up: number;
    sonlandirma_raporu: number;
    total: number;
}

interface ActivityUser {
    id: string;
    email: string;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type PeriodType = 'day' | 'week' | 'month' | 'custom';

// ─── Helper Functions ─────────────────────────────────────────────────────────

function toLocalDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getDateRange(periodType: PeriodType, anchor: Date): { from: string; to: string } {
    if (periodType === 'custom') {
        return { from: '', to: '' };
    }

    if (periodType === 'day') {
        const from = toLocalDateStr(anchor);
        const to = `${from}T23:59:59`;
        return { from, to };
    }

    if (periodType === 'week') {
        const d = new Date(anchor);
        // Get Monday of the week (ISO week starts Monday)
        const day = d.getDay(); // 0=Sun,1=Mon,...,6=Sat
        const diff = day === 0 ? -6 : 1 - day; // adjust to Monday
        const monday = new Date(d);
        monday.setDate(d.getDate() + diff);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        const from = toLocalDateStr(monday);
        const to = `${toLocalDateStr(sunday)}T23:59:59`;
        return { from, to };
    }

    // month
    const firstDay = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const lastDay = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const from = toLocalDateStr(firstDay);
    const to = `${toLocalDateStr(lastDay)}T23:59:59`;
    return { from, to };
}

function shiftPeriod(periodType: PeriodType, anchor: Date, direction: 1 | -1): Date {
    const d = new Date(anchor);
    if (periodType === 'day') {
        d.setDate(d.getDate() + direction);
    } else if (periodType === 'week') {
        d.setDate(d.getDate() + direction * 7);
    } else if (periodType === 'month') {
        d.setMonth(d.getMonth() + direction);
    }
    return d;
}

function formatPeriodLabel(periodType: PeriodType, anchor: Date, locale: string): string {
    if (periodType === 'day') {
        return anchor.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
    }

    if (periodType === 'week') {
        const day = anchor.getDay();
        const diff = day === 0 ? -6 : 1 - day;
        const monday = new Date(anchor);
        monday.setDate(anchor.getDate() + diff);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);

        const startDay = monday.getDate();
        const endDay = sunday.getDate();
        const monthStr = sunday.toLocaleDateString(locale, { month: 'short' });
        const yearStr = sunday.getFullYear();
        return `${startDay} — ${endDay} ${monthStr} ${yearStr}`;
    }

    // month
    return anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}


function formatDate(iso: string, locale: string): string {
    return new Date(iso).toLocaleDateString(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatGroupDate(iso: string, locale: string): string {
    const date = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const dateStr = toLocalDateStr(date);
    const todayStr = toLocalDateStr(today);
    const yesterdayStr = toLocalDateStr(yesterday);

    if (dateStr === todayStr) return 'today';
    if (dateStr === yesterdayStr) return 'yesterday';
    return date.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
}

// ─── ActivityCard Component ───────────────────────────────────────────────────

interface ActivityCardProps {
    activity: Activity;
    navigate: ReturnType<typeof useNavigate>;
    t: ReturnType<typeof useTranslation>['t'];
    locale: string;
    canEdit: boolean;
    canDeleteItem: boolean;
    onEdit: (activity: Activity) => void;
    onDelete: (id: string) => void;
}

function ActivityCard({ activity, navigate, t, locale, canEdit, canDeleteItem, onEdit, onDelete }: ActivityCardProps) {
    const color = ACTIVITY_COLORS[activity.type] || 'gray';
    const outcomeColor = OUTCOME_COLORS[activity.outcome || ''] || 'gray';
    const isStatusChange = activity.type === 'status_change';
    const isClosingReport = activity.type === 'sonlandirma_raporu';
    const showMenu = (canEdit && !isStatusChange && !isClosingReport) || canDeleteItem;

    return (
        <Paper key={activity.id} p="md" radius="md" withBorder>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                    {activity.company_name && (
                        <Text
                            size="sm"
                            fw={600}
                            c="blue"
                            style={{ cursor: 'pointer' }}
                            onClick={() => navigate(`/companies/${activity.company_id}`)}
                        >
                            {activity.company_name}
                        </Text>
                    )}
                    <Group gap="xs" wrap="wrap">
                        <Badge
                            size="sm"
                            variant="light"
                            color={color}
                            leftSection={ACTIVITY_ICONS[activity.type]}
                        >
                            {t(`activity.types.${activity.type}`)}
                        </Badge>
                        {activity.outcome && (
                            <Badge size="sm" variant="filled" color={outcomeColor}>
                                {t(`activity.outcomes.${activity.outcome}`, activity.outcome)}
                            </Badge>
                        )}
                        {activity.visibility === 'internal' && (
                            <Badge size="xs" variant="outline" color="gray">
                                {t('activity.visibility_options.internal')}
                            </Badge>
                        )}
                        {activity.contact_name && (
                            <Badge
                                size="xs"
                                variant="light"
                                color="gray"
                                leftSection={<IconUser size={10} />}
                            >
                                {activity.contact_name}
                            </Badge>
                        )}
                    </Group>
                    <Text size="sm" fw={500}>{activity.summary}</Text>
                    {activity.detail && (
                        <Text size="xs" c="dimmed" lineClamp={2}>{activity.detail}</Text>
                    )}
                </Stack>
                <Group gap={4} align="flex-start" wrap="nowrap">
                    <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                        {formatDate(activity.occurred_at, locale)}
                    </Text>
                    {showMenu && (
                        <Menu withinPortal position="bottom-end" shadow="sm">
                            <Menu.Target>
                                <ActionIcon variant="subtle" size="sm" color="gray">
                                    <IconDotsVertical size={14} />
                                </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                                {canEdit && !isStatusChange && !isClosingReport && (
                                    <Menu.Item
                                        leftSection={<IconPencil size={14} />}
                                        onClick={() => onEdit(activity)}
                                    >
                                        {t('activity.editActivity')}
                                    </Menu.Item>
                                )}
                                {canDeleteItem && (
                                    <Menu.Item
                                        color="red"
                                        leftSection={<IconTrash size={14} />}
                                        onClick={() => onDelete(activity.id)}
                                    >
                                        {t('company.delete')}
                                    </Menu.Item>
                                )}
                            </Menu.Dropdown>
                        </Menu>
                    )}
                </Group>
            </Group>
        </Paper>
    );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ActivitiesPage() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const { user } = useAuth();
    const queryClient = useQueryClient();

    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';

    const canEditActivities = hasRolePermission(user?.role || '', 'activity_write');
    const canDeleteActivities = canDelete(user?.role || '');

    const [editingActivity, setEditingActivity] = useState<Activity | null>(null);
    const [formOpened, setFormOpened] = useState(false);

    const deleteMutation = useMutation({
        mutationFn: (id: string) => api.delete(`/activities/${id}`),
        onSuccess: () => {
            showSuccess(t('activity.deleted'));
            queryClient.invalidateQueries({ queryKey: ['activities-all'] });
            queryClient.invalidateQueries({ queryKey: ['activities-stats'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    function handleEdit(activity: Activity) {
        setEditingActivity(activity);
        setFormOpened(true);
    }

    function handleFormClose() {
        setFormOpened(false);
        setEditingActivity(null);
        queryClient.invalidateQueries({ queryKey: ['activities-all'] });
        queryClient.invalidateQueries({ queryKey: ['activities-stats'] });
    }

    // Period / date navigation
    const [periodType, setPeriodType] = useState<PeriodType>('month');
    const [periodAnchor, setPeriodAnchor] = useState<Date>(new Date());
    const [customRange, setCustomRange] = useState<[Date | null, Date | null]>([null, null]);

    // Filters
    const [typeFilter, setTypeFilter] = useState('');
    const [visibilityFilter, setVisibilityFilter] = useState('');
    const [createdByFilter, setCreatedByFilter] = useState('');
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 300);

    // Grouping
    const [groupBy, setGroupBy] = useState<'none' | 'date' | 'company' | 'type'>('none');

    // Pagination
    const [page, setPage] = useState(1);
    const [allActivities, setAllActivities] = useState<Activity[]>([]);

    // ── Derived ──

    const pageLimit = groupBy !== 'none' ? 100 : 20;

    const dateRange = useMemo(() => {
        if (periodType === 'custom') {
            const d0 = customRange[0];
            const d1 = customRange[1];
            if (!d0 || !d1) return { from: '', to: '' };
            return {
                from: toLocalDateStr(d0 instanceof Date ? d0 : new Date(d0)),
                to: `${toLocalDateStr(d1 instanceof Date ? d1 : new Date(d1))}T23:59:59`,
            };
        }
        return getDateRange(periodType, periodAnchor);
    }, [periodType, periodAnchor, customRange]);

    const queryEnabled =
        periodType !== 'custom' || (!!customRange[0] && !!customRange[1]);

    // ── Queries ──

    const { data, isLoading } = useQuery<ActivitiesResponse>({
        queryKey: [
            'activities-all',
            page,
            pageLimit,
            typeFilter,
            visibilityFilter,
            createdByFilter,
            debouncedSearch,
            dateRange.from,
            dateRange.to,
        ],
        queryFn: async () => {
            const params: Record<string, string> = {
                page: String(page),
                limit: String(pageLimit),
            };
            if (typeFilter) params.type = typeFilter;
            if (visibilityFilter) params.visibility = visibilityFilter;
            if (createdByFilter) params.created_by = createdByFilter;
            if (debouncedSearch) params.search = debouncedSearch;
            if (dateRange.from) params.date_from = dateRange.from;
            if (dateRange.to) params.date_to = dateRange.to;
            return (await api.get('/activities/all', { params })).data;
        },
        enabled: queryEnabled,
        refetchOnWindowFocus: false,
    });

    // Stats query: intentionally excludes typeFilter so cards always show
    // the full type breakdown for the selected period
    const { data: stats, isLoading: statsLoading } = useQuery<ActivityStats>({
        queryKey: [
            'activities-stats',
            visibilityFilter,
            createdByFilter,
            debouncedSearch,
            dateRange.from,
            dateRange.to,
        ],
        queryFn: async () => {
            const params: Record<string, string> = {};
            if (visibilityFilter) params.visibility = visibilityFilter;
            if (createdByFilter) params.created_by = createdByFilter;
            if (debouncedSearch) params.search = debouncedSearch;
            if (dateRange.from) params.date_from = dateRange.from;
            if (dateRange.to) params.date_to = dateRange.to;
            return (await api.get('/activities/stats', { params })).data;
        },
        enabled: queryEnabled,
    });

    const { data: usersData } = useQuery<ActivityUser[]>({
        queryKey: ['activities-users'],
        queryFn: async () => (await api.get('/activities/users')).data,
    });

    // ── Effects ──

    // Reset pagination when filters/dates change
    // Note: groupBy is NOT included — grouping is client-side only (useMemo),
    // no refetch needed. Including it would clear allActivities without triggering
    // a refetch, leaving the list empty.
    useEffect(() => {
        setPage(1);
        setAllActivities([]);
    }, [
        typeFilter,
        visibilityFilter,
        createdByFilter,
        debouncedSearch,
        dateRange.from,
        dateRange.to,
    ]);

    // Accumulate pages
    useEffect(() => {
        if (!data?.data) return;
        if (page === 1) {
            setAllActivities(data.data);
        } else {
            setAllActivities((prev) => {
                const existingIds = new Set(prev.map((a) => a.id));
                const newItems = data.data.filter((a: Activity) => !existingIds.has(a.id));
                return [...prev, ...newItems];
            });
        }
    }, [data, page]);

    const hasMore = data?.pagination?.hasNext ?? false;
    const total = data?.pagination?.total ?? 0;

    // ── Grouping ──

    interface GroupedSection {
        key: string;
        label: string;
        color?: string;
        icon?: React.ReactNode;
        items: Activity[];
    }

    const groupedSections = useMemo<GroupedSection[] | null>(() => {
        if (groupBy === 'none') return null;
        if (allActivities.length === 0) return [];

        if (groupBy === 'date') {
            const map = new Map<string, Activity[]>();
            for (const a of allActivities) {
                const key = toLocalDateStr(new Date(a.occurred_at));
                if (!map.has(key)) map.set(key, []);
                map.get(key)!.push(a);
            }
            // Sort by date descending
            const sorted = Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
            return sorted.map(([key, items]) => {
                const label = formatGroupDate(items[0].occurred_at, locale);
                const displayLabel =
                    label === 'today'
                        ? t('activities.today')
                        : label === 'yesterday'
                        ? t('activities.yesterday')
                        : label;
                return { key, label: displayLabel, items };
            });
        }

        if (groupBy === 'company') {
            const map = new Map<string, { name: string; items: Activity[] }>();
            for (const a of allActivities) {
                const key = a.company_id;
                if (!map.has(key)) map.set(key, { name: a.company_name || key, items: [] });
                map.get(key)!.items.push(a);
            }
            const sorted = Array.from(map.entries()).sort((a, b) =>
                a[1].name.localeCompare(b[1].name)
            );
            return sorted.map(([key, { name, items }]) => ({
                key,
                label: name,
                items,
            }));
        }

        // type
        const map = new Map<string, Activity[]>();
        for (const a of allActivities) {
            if (!map.has(a.type)) map.set(a.type, []);
            map.get(a.type)!.push(a);
        }
        return Array.from(map.entries()).map(([key, items]) => ({
            key,
            label: t(`activity.types.${key}`),
            color: ACTIVITY_COLORS[key as ActivityType] || 'gray',
            icon: ACTIVITY_ICONS[key as ActivityType],
            items,
        }));
    }, [groupBy, allActivities, locale, t]);

    // ── Render ──

    const periodLabel =
        periodType !== 'custom' ? formatPeriodLabel(periodType, periodAnchor, locale) : '';

    const userSelectData = (usersData || []).map((u) => ({
        value: u.id,
        label: u.email,
    }));

    return (
        <Container size="lg" py="xl">
            {/* Header */}
            <Group justify="space-between" mb="lg">
                <Group gap="xs">
                    <Title order={2}>{t('activities.pageTitle')}</Title>
                    <Badge size="lg" variant="light" color="violet" circle>
                        {total}
                    </Badge>
                </Group>
            </Group>

            {/* Stats Cards */}
            <SimpleGrid cols={{ base: 2, sm: 4 }} mb="lg">
                {statsLoading ? (
                    <>
                        <Skeleton height={100} radius="lg" />
                        <Skeleton height={100} radius="lg" />
                        <Skeleton height={100} radius="lg" />
                        <Skeleton height={100} radius="lg" />
                    </>
                ) : (
                    <>
                        <StatCard
                            title={t('activities.statsTotal')}
                            value={stats?.total ?? 0}
                            icon={<IconCalendar size={22} />}
                            color="violet"
                        />
                        <StatCard
                            title={t('activities.types.meeting')}
                            value={stats?.meeting ?? 0}
                            icon={<IconCalendar size={22} />}
                            color="violet"
                        />
                        <StatCard
                            title={t('activities.types.not')}
                            value={stats?.not ?? 0}
                            icon={<IconNotes size={22} />}
                            color="blue"
                        />
                        <StatCard
                            title={t('activities.types.follow_up')}
                            value={stats?.follow_up ?? 0}
                            icon={<IconClock size={22} />}
                            color="orange"
                        />
                    </>
                )}
            </SimpleGrid>

            {/* Filters + Date Navigation */}
            <Paper p="md" radius="md" withBorder mb="sm">
                <Stack gap="sm">
                    {/* Row 1: Filters (left) + Date Navigation (right) */}
                    <Group justify="space-between" wrap="wrap" gap="sm">
                        <Group gap="sm" wrap="wrap">
                            <SegmentedControl
                                size="sm"
                                value={typeFilter}
                                onChange={(v) => { setTypeFilter(v); if (v && groupBy === 'type') setGroupBy('none'); }}
                                data={[
                                    { label: t('activities.all'), value: '' },
                                    { label: t('activities.types.not'), value: 'not' },
                                    { label: t('activities.types.meeting'), value: 'meeting' },
                                    { label: t('activities.types.follow_up'), value: 'follow_up' },
                                ]}
                            />

                            {isInternal(user?.role || '') && (
                                <SegmentedControl
                                    size="sm"
                                    value={visibilityFilter}
                                    onChange={(v) => setVisibilityFilter(v)}
                                    data={[
                                        { label: t('activities.allVisibility'), value: '' },
                                        { label: t('activity.visibility_options.internal'), value: 'internal' },
                                        { label: t('activity.visibility_options.client'), value: 'client' },
                                    ]}
                                />
                            )}

                            {userSelectData.length > 0 && (
                                <Select
                                    size="sm"
                                    placeholder={t('activities.allUsers')}
                                    clearable
                                    searchable
                                    value={createdByFilter}
                                    onChange={(v) => setCreatedByFilter(v || '')}
                                    data={userSelectData}
                                    style={{ minWidth: 180 }}
                                />
                            )}
                        </Group>

                        <Group gap="xs" wrap="nowrap">
                            <SegmentedControl
                                size="xs"
                                value={periodType}
                                onChange={(v) => {
                                    setPeriodType(v as PeriodType);
                                    setPeriodAnchor(new Date());
                                }}
                                data={[
                                    { label: t('activities.periodDay'), value: 'day' },
                                    { label: t('activities.periodWeek'), value: 'week' },
                                    { label: t('activities.periodMonth'), value: 'month' },
                                    { label: t('activities.periodCustom'), value: 'custom' },
                                ]}
                            />

                            {periodType !== 'custom' && (
                                <Group gap={4} wrap="nowrap">
                                    <ActionIcon
                                        variant="subtle"
                                        color="gray"
                                        size="sm"
                                        onClick={() =>
                                            setPeriodAnchor((prev) => shiftPeriod(periodType, prev, -1))
                                        }
                                    >
                                        <IconChevronLeft size={14} />
                                    </ActionIcon>
                                    <Text size="xs" fw={600} miw={120} ta="center">
                                        {periodLabel}
                                    </Text>
                                    <ActionIcon
                                        variant="subtle"
                                        color="gray"
                                        size="sm"
                                        onClick={() =>
                                            setPeriodAnchor((prev) => shiftPeriod(periodType, prev, 1))
                                        }
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

                            {periodType === 'custom' && (
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

                    {/* Row 2: Search bar full width */}
                    <TextInput
                        size="sm"
                        placeholder={t('activities.search')}
                        leftSection={<IconSearch size={16} />}
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                    />
                </Stack>
            </Paper>

            {/* Grouping Control */}
            <Group mb="md">
                <SegmentedControl
                    size="xs"
                    value={groupBy}
                    onChange={(v) => setGroupBy(v as typeof groupBy)}
                    data={[
                        { label: t('activities.groupByNone'), value: 'none' },
                        { label: t('activities.groupByDate'), value: 'date' },
                        { label: t('activities.groupByCompany'), value: 'company' },
                        ...(!typeFilter ? [{ label: t('activities.groupByType'), value: 'type' }] : []),
                    ]}
                />
            </Group>

            {/* Activity List */}
            {isLoading && allActivities.length === 0 ? (
                <Center py="xl">
                    <Loader size="md" color="violet" />
                </Center>
            ) : allActivities.length === 0 ? (
                <Center py="xl">
                    <Text c="dimmed" fs="italic">
                        {t('activity.noActivities')}
                    </Text>
                </Center>
            ) : groupedSections !== null ? (
                // Grouped view
                <Stack gap="lg">
                    {groupedSections.map((section) => (
                        <Stack key={section.key} gap="xs">
                            <Group gap="xs">
                                {section.color && (
                                    <Badge
                                        size="sm"
                                        variant="light"
                                        color={section.color}
                                        leftSection={section.icon}
                                    >
                                        {section.label}
                                    </Badge>
                                )}
                                {!section.color && (
                                    <Text size="sm" fw={700} c="dimmed">
                                        {section.label}
                                    </Text>
                                )}
                                <Text size="xs" c="dimmed">
                                    ({section.items.length})
                                </Text>
                            </Group>
                            <Divider />
                            <Stack gap="sm">
                                {section.items.map((activity) => (
                                    <ActivityCard
                                        key={activity.id}
                                        activity={activity}
                                        navigate={navigate}
                                        t={t}
                                        locale={locale}
                                        canEdit={canEditActivities}
                                        canDeleteItem={canDeleteActivities}
                                        onEdit={handleEdit}
                                        onDelete={(id) => deleteMutation.mutate(id)}
                                    />
                                ))}
                            </Stack>
                        </Stack>
                    ))}

                    {hasMore && (
                        <Center>
                            <Button
                                variant="subtle"
                                color="gray"
                                onClick={() => setPage((p) => p + 1)}
                            >
                                {t('activity.loadMore')}
                            </Button>
                        </Center>
                    )}
                </Stack>
            ) : (
                // Flat view
                <Stack gap="sm">
                    {allActivities.map((activity) => (
                        <ActivityCard
                            key={activity.id}
                            activity={activity}
                            navigate={navigate}
                            t={t}
                            locale={locale}
                            canEdit={canEditActivities}
                            canDeleteItem={canDeleteActivities}
                            onEdit={handleEdit}
                            onDelete={(id) => deleteMutation.mutate(id)}
                        />
                    ))}

                    {hasMore && (
                        <Center>
                            <Button
                                variant="subtle"
                                color="gray"
                                onClick={() => setPage((p) => p + 1)}
                            >
                                {t('activity.loadMore')}
                            </Button>
                        </Center>
                    )}
                </Stack>
            )}

            <ActivityForm
                opened={formOpened}
                onClose={handleFormClose}
                companyId={editingActivity?.company_id ?? ''}
                activity={editingActivity}
            />
        </Container>
    );
}
