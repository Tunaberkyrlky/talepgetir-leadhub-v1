import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
    Container,
    Title,
    Group,
    Stack,
    Paper,
    Text,
    Badge,
    SegmentedControl,
    Loader,
    Center,
    Button,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import {
    IconNotes,
    IconCalendar,
    IconClock,
    IconFileReport,
    IconArrowsExchange,
    IconUser,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import type { Activity, ActivityType } from '../types/activity';

interface ActivitiesResponse {
    data: Activity[];
    pagination: {
        hasNext: boolean;
        total: number;
        page: number;
    };
}

const ACTIVITY_ICONS: Record<ActivityType, React.ReactNode> = {
    not: <IconNotes size={16} />,
    meeting: <IconCalendar size={16} />,
    follow_up: <IconClock size={16} />,
    sonlandirma_raporu: <IconFileReport size={16} />,
    status_change: <IconArrowsExchange size={16} />,
};

const ACTIVITY_COLORS: Record<ActivityType, string> = {
    not: 'blue',
    meeting: 'violet',
    follow_up: 'orange',
    sonlandirma_raporu: 'green',
    status_change: 'gray',
};

const OUTCOME_COLORS: Record<string, string> = {
    won: 'green',
    lost: 'red',
    on_hold: 'gray',
    cancelled: 'dark',
};

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('tr-TR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export default function ActivitiesPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [page, setPage] = useState(1);
    const [typeFilter, setTypeFilter] = useState('');
    const [dateRange, setDateRange] = useState<[Date | null, Date | null]>([null, null]);

    const toLocalDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const d0 = dateRange[0] ? new Date(dateRange[0]) : null;
    const d1 = dateRange[1] ? new Date(dateRange[1]) : null;
    const bothDatesSelected = d0 && !isNaN(d0.getTime()) && d1 && !isNaN(d1.getTime());
    const dateFrom = bothDatesSelected ? toLocalDate(d0) : undefined;
    const dateTo = bothDatesSelected ? toLocalDate(d1) + 'T23:59:59' : undefined;

    const { data, isLoading } = useQuery<ActivitiesResponse>({
        queryKey: ['activities-all', page, typeFilter, dateFrom, dateTo],
        queryFn: async () => {
            const params: Record<string, string> = { page: String(page), limit: '20' };
            if (typeFilter) params.type = typeFilter;
            if (dateFrom) params.date_from = dateFrom;
            if (dateTo) params.date_to = dateTo;
            return (await api.get('/activities/all', { params })).data;
        },
    });

    const activities = data?.data || [];
    const hasMore = data?.pagination?.hasNext ?? false;
    const total = data?.pagination?.total ?? 0;

    return (
        <Container size="md" py="xl">
            <Group justify="space-between" mb="lg">
                <Group gap="xs">
                    <Title order={2}>{t('activities.pageTitle')}</Title>
                    <Badge size="lg" variant="light" color="violet" circle>{total}</Badge>
                </Group>
            </Group>

            <Group gap="sm" mb="lg" wrap="wrap">
                <SegmentedControl
                    size="sm"
                    value={typeFilter}
                    onChange={(v) => { setTypeFilter(v); setPage(1); }}
                    data={[
                        { label: t('activities.all'), value: '' },
                        { label: t('activities.types.not'), value: 'not' },
                        { label: t('activities.types.meeting'), value: 'meeting' },
                        { label: t('activities.types.follow_up'), value: 'follow_up' },
                    ]}
                />
                <DatePickerInput
                    type="range"
                    placeholder={t('activities.dateRange')}
                    value={dateRange}
                    onChange={(v) => { setDateRange(v); setPage(1); }}
                    clearable
                    size="sm"
                />
            </Group>

            {isLoading ? (
                <Center py="xl">
                    <Loader size="md" color="violet" />
                </Center>
            ) : activities.length === 0 ? (
                <Center py="xl">
                    <Text c="dimmed" fs="italic">{t('activity.noActivities')}</Text>
                </Center>
            ) : (
                <Stack gap="sm">
                    {activities.map((activity) => {
                        const color = ACTIVITY_COLORS[activity.type] || 'gray';
                        const outcomeColor = OUTCOME_COLORS[activity.outcome || ''] || 'gray';

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
                                                    {t('activity.internal')}
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
                                    <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                                        {formatDate(activity.occurred_at)}
                                    </Text>
                                </Group>
                            </Paper>
                        );
                    })}

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
        </Container>
    );
}
