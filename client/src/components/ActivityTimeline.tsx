import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Stack,
    Group,
    Text,
    Badge,
    Button,
    ActionIcon,
    Menu,
    Paper,
    Loader,
    Center,
    Divider,
    Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
    IconNotes,
    IconCalendar,
    IconClock,
    IconFileReport,
    IconArrowsExchange,
    IconPlus,
    IconDotsVertical,
    IconPencil,
    IconTrash,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { hasRolePermission } from '../lib/permissions';
import { showSuccess, showError } from '../lib/notifications';
import api from '../lib/api';
import ActivityForm from './ActivityForm';
import type { Activity, ActivityType } from '../types/activity';

interface ActivityTimelineProps {
    companyId: string;
    contactId?: string;
}

interface ActivitiesResponse {
    data: Activity[];
    pagination: {
        hasNext: boolean;
        total: number;
        page: number;
        limit: number;
        totalPages: number;
        hasPrev: boolean;
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

function formatActivityDate(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleDateString('tr-TR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export default function ActivityTimeline({ companyId, contactId }: ActivityTimelineProps) {
    const { t } = useTranslation();
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const [page, setPage] = useState(1);
    const [allActivities, setAllActivities] = useState<Activity[]>([]);
    const [editingActivity, setEditingActivity] = useState<Activity | null>(null);
    const [formOpened, { open: openForm, close: closeForm }] = useDisclosure(false);

    const isInternal = hasRolePermission(user?.role || '', 'activity_write' as any);
    const isSuperadmin = user?.role === 'superadmin';

    const { data, isLoading, isFetching } = useQuery<ActivitiesResponse>({
        queryKey: ['activities', companyId, contactId, page],
        queryFn: async () => {
            const params = new URLSearchParams({ company_id: companyId, page: String(page), limit: '20' });
            if (contactId) params.set('contact_id', contactId);
            const res = await api.get(`/activities?${params.toString()}`);
            return res.data as ActivitiesResponse;
        },
    });

    // Keep accumulated list as pages load
    const shownList: Activity[] = (() => {
        if (page === 1 && data) return data.data;
        return allActivities;
    })();

    const deleteMutation = useMutation({
        mutationFn: async (id: string) => {
            await api.delete(`/activities/${id}`);
        },
        onSuccess: () => {
            showSuccess(t('activity.deleted'));
            setPage(1);
            setAllActivities([]);
            queryClient.invalidateQueries({ queryKey: ['activities', companyId] });
        },
        onError: () => {
            showError(t('errors.generic'));
        },
    });

    const handleAddActivity = () => {
        setEditingActivity(null);
        openForm();
    };

    const handleEditActivity = (activity: Activity) => {
        setEditingActivity(activity);
        openForm();
    };

    const handleFormClose = () => {
        setEditingActivity(null);
        closeForm();
        setPage(1);
        setAllActivities([]);
        queryClient.invalidateQueries({ queryKey: ['activities', companyId] });
    };

    const hasMore = data?.pagination?.hasNext ?? false;
    const totalCount = data?.pagination?.total ?? (allActivities.length > 0 ? allActivities.length : undefined);

    return (
        <Paper shadow="sm" radius="lg" p="xl" withBorder>
            <Group justify="space-between" mb="lg">
                <Group gap="xs">
                    <IconNotes size={20} color="var(--mantine-color-violet-6)" />
                    <Title order={4} fw={600}>{t('activity.timeline')}</Title>
                    {totalCount != null && (
                        <Badge size="sm" variant="light" color="violet" circle>
                            {totalCount}
                        </Badge>
                    )}
                </Group>
                {isInternal && (
                    <Button
                        size="sm"
                        leftSection={<IconPlus size={16} />}
                        onClick={handleAddActivity}
                        variant="light"
                        color="violet"
                        radius="md"
                    >
                        {t('activity.addActivity')}
                    </Button>
                )}
            </Group>

            {isLoading && page === 1 ? (
                <Center py="xl">
                    <Loader size="sm" color="violet" />
                </Center>
            ) : shownList.length === 0 ? (
                <Center py="xl">
                    <Text size="sm" c="dimmed" fs="italic">{t('activity.noActivities')}</Text>
                </Center>
            ) : (
                <Stack gap="sm">
                    {shownList.map((activity, idx) => {
                        const isClosingReport = activity.type === 'sonlandirma_raporu';
                        const isStatusChange = activity.type === 'status_change';
                        const outcomeColor = OUTCOME_COLORS[activity.outcome || ''] || 'gray';

                        return (
                            <div key={activity.id}>
                                <Paper
                                    p="sm"
                                    radius="md"
                                    withBorder
                                    style={{
                                        borderColor: isClosingReport
                                            ? `var(--mantine-color-${outcomeColor}-4)`
                                            : undefined,
                                        background: isClosingReport
                                            ? `var(--mantine-color-${outcomeColor}-0)`
                                            : isStatusChange
                                            ? 'var(--mantine-color-gray-0)'
                                            : undefined,
                                    }}
                                >
                                    <Group justify="space-between" wrap="nowrap">
                                        <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                                            <Badge
                                                size="sm"
                                                variant="light"
                                                color={ACTIVITY_COLORS[activity.type]}
                                                leftSection={ACTIVITY_ICONS[activity.type]}
                                            >
                                                {t(`activity.types.${activity.type}`)}
                                            </Badge>
                                            {activity.outcome && (
                                                <Badge
                                                    size="sm"
                                                    variant="filled"
                                                    color={OUTCOME_COLORS[activity.outcome] || 'gray'}
                                                >
                                                    {t(`activity.closingReport.${activity.outcome}`, activity.outcome)}
                                                </Badge>
                                            )}
                                            {activity.visibility === 'internal' && (
                                                <Badge size="xs" variant="outline" color="gray">
                                                    {t('activity.visibility_options.internal')}
                                                </Badge>
                                            )}
                                        </Group>

                                        <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
                                            <Text size="xs" c="dimmed">
                                                {formatActivityDate(activity.occurred_at)}
                                            </Text>
                                            {isInternal && !isStatusChange && (
                                                <Menu withinPortal position="bottom-end" shadow="sm">
                                                    <Menu.Target>
                                                        <ActionIcon variant="subtle" size="sm" color="gray">
                                                            <IconDotsVertical size={14} />
                                                        </ActionIcon>
                                                    </Menu.Target>
                                                    <Menu.Dropdown>
                                                        {activity.type !== 'sonlandirma_raporu' && (
                                                            <Menu.Item
                                                                leftSection={<IconPencil size={14} />}
                                                                onClick={() => handleEditActivity(activity)}
                                                            >
                                                                {t('contact.editContact').replace('Contact', 'Activity')}
                                                            </Menu.Item>
                                                        )}
                                                        {isSuperadmin && (
                                                            <Menu.Item
                                                                color="red"
                                                                leftSection={<IconTrash size={14} />}
                                                                onClick={() => deleteMutation.mutate(activity.id)}
                                                            >
                                                                {t('company.delete')}
                                                            </Menu.Item>
                                                        )}
                                                    </Menu.Dropdown>
                                                </Menu>
                                            )}
                                        </Group>
                                    </Group>

                                    <Text size="sm" fw={500} mt="xs">
                                        {activity.summary}
                                    </Text>
                                    {activity.detail && (
                                        <Text size="sm" c="dimmed" mt={4} style={{ whiteSpace: 'pre-wrap' }}>
                                            {activity.detail}
                                        </Text>
                                    )}
                                </Paper>
                                {idx < shownList.length - 1 && (
                                    <Divider
                                        variant="dotted"
                                        ml="sm"
                                        style={{ borderColor: 'var(--mantine-color-gray-2)' }}
                                    />
                                )}
                            </div>
                        );
                    })}

                    {hasMore && (
                        <Button
                            variant="subtle"
                            color="gray"
                            size="xs"
                            onClick={() => setPage((p) => p + 1)}
                            loading={isFetching}
                        >
                            {t('activity.loadMore')}
                        </Button>
                    )}
                </Stack>
            )}

            <ActivityForm
                opened={formOpened}
                onClose={handleFormClose}
                companyId={companyId}
                contactId={contactId}
                activity={editingActivity}
            />
        </Paper>
    );
}
