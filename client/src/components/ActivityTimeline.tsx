import { useState, useEffect } from 'react';
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
    IconPlus,
    IconDotsVertical,
    IconPencil,
    IconTrash,
    IconUser,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ACTIVITY_ICONS, ACTIVITY_COLORS, OUTCOME_COLORS } from '../lib/activityConstants';
import { useAuth } from '../contexts/AuthContext';
import { hasRolePermission } from '../lib/permissions';
import { showSuccess, showError } from '../lib/notifications';
import api from '../lib/api';
import ActivityForm from './ActivityForm';
import type { Activity } from '../types/activity';

interface ActivityTimelineProps {
    companyId: string;
    contactId?: string;
    compact?: boolean;
    typeFilter?: string;
    /** When true, render nothing instead of "no activities" message */
    hideEmpty?: boolean;
    /** When true, render without Paper wrapper, header, and add button — for embedding inside tabs */
    embedded?: boolean;
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

function formatActivityDate(isoString: string, locale: string = 'tr-TR'): string {
    const date = new Date(isoString);
    return date.toLocaleDateString(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export default function ActivityTimeline({ companyId, contactId, compact, typeFilter: externalTypeFilter, hideEmpty, embedded }: ActivityTimelineProps) {
    const { t, i18n } = useTranslation();
    const locale = i18n.language === 'tr' ? 'tr-TR' : 'en-US';
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const [page, setPage] = useState(1);
    const [allActivities, setAllActivities] = useState<Activity[]>([]);
    const [editingActivity, setEditingActivity] = useState<Activity | null>(null);
    const [formOpened, { open: openForm, close: closeForm }] = useDisclosure(false);
    const typeFilter = externalTypeFilter ?? '';

    const canEditActivities = hasRolePermission(user?.role || '', 'activity_write');
    const isSuperadmin = user?.role === 'superadmin';

    // Reset accumulated pages when typeFilter changes
    useEffect(() => {
        setPage(1);
        setAllActivities([]);
    }, [typeFilter]);

    const { data, isLoading, isFetching } = useQuery<ActivitiesResponse>({
        queryKey: ['activities', companyId, contactId, page, typeFilter],
        queryFn: async () => {
            const params: any = { company_id: companyId, page: String(page), limit: '20' };
            if (contactId) params.contact_id = contactId;
            if (typeFilter) params.type = typeFilter;
            const searchParams = new URLSearchParams(params);
            const res = await api.get(`/activities?${searchParams.toString()}`);
            return res.data as ActivitiesResponse;
        },
        refetchOnWindowFocus: false,
    });

    // Accumulate pages as they load
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

    const shownList: Activity[] = allActivities;

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
    };

    const hasMore = data?.pagination?.hasNext ?? false;
    const totalCount = data?.pagination?.total ?? (allActivities.length > 0 ? allActivities.length : undefined);

    const content = (
        <>
            {isLoading && page === 1 ? (
                <Center py={compact ? 'xs' : 'xl'}>
                    <Loader size="sm" color="violet" />
                </Center>
            ) : shownList.length === 0 ? (
                hideEmpty ? null : (
                    <Center py={compact ? 'xs' : 'xl'}>
                        <Text size={compact ? 'xs' : 'sm'} c="dimmed" fs="italic">{t('activity.noActivities')}</Text>
                    </Center>
                )
            ) : (
                <Stack gap={compact ? 4 : 'sm'}>
                    {shownList.map((activity, idx) => {
                        const isClosingReport = activity.type === 'sonlandirma_raporu';
                        const isStatusChange = activity.type === 'status_change';
                        const outcomeColor = OUTCOME_COLORS[activity.outcome || ''] || 'gray';

                        return (
                            <div key={activity.id}>
                                <Paper
                                    p={compact ? 'xs' : 'sm'}
                                    radius="md"
                                    withBorder
                                    shadow={compact ? undefined : 'xs'}
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
                                                size="xs"
                                                variant="light"
                                                color={ACTIVITY_COLORS[activity.type]}
                                                leftSection={ACTIVITY_ICONS[activity.type]}
                                            >
                                                {t(`activity.types.${activity.type}`)}
                                            </Badge>
                                            {activity.outcome && (
                                                <Badge
                                                    size="xs"
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
                                            {activity.contact_name && (
                                                <Badge size="xs" variant="light" color="gray" leftSection={<IconUser size={10} />}>
                                                    {activity.contact_name}
                                                </Badge>
                                            )}
                                        </Group>

                                        <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
                                            <Text size="xs" c="dimmed">
                                                {formatActivityDate(activity.occurred_at, locale)}
                                            </Text>
                                            {canEditActivities && !isStatusChange && (
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
                                                                {t('activity.editActivity')}
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

                                    <Text size={compact ? 'xs' : 'sm'} fw={500} mt="xs">
                                        {activity.summary}
                                    </Text>
                                    {activity.detail && (
                                        <Text size={compact ? 'xs' : 'sm'} c="dimmed" mt={4} style={{ whiteSpace: 'pre-wrap' }}>
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
        </>
    );

    if (embedded || compact) {
        return (
            <>
                {embedded && canEditActivities && (
                    <Group justify="flex-end" mb="md">
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
                    </Group>
                )}
                {content}
            </>
        );
    }

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
                {canEditActivities && (
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
            {content}
        </Paper>
    );
}
