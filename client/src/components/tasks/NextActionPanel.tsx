import { useState } from 'react';
import {
    ActionIcon,
    Badge,
    Button,
    Center,
    Group,
    Menu,
    Paper,
    Skeleton,
    Stack,
    Text,
    ThemeIcon,
    Title,
    Tooltip,
} from '@mantine/core';
import {
    IconCalendarDue,
    IconCheck,
    IconClock,
    IconDotsVertical,
    IconPencil,
    IconPlus,
    IconTargetArrow,
    IconX,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';
import { useNextAction } from '../../contexts/NextActionContext';
import type { CrmTask, TasksResponse } from '../../types/task';
import TaskForm from './TaskForm';

interface NextActionPanelProps {
    companyId: string;
    contacts?: { id: string; first_name: string; last_name?: string | null }[];
    canEdit: boolean;
    legacyNextStep?: string | null;
}

function dueState(dueAt: string) {
    const due = new Date(dueAt);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    if (due.getTime() < now.getTime()) return { color: 'red', key: 'overdue' as const };
    if (dueDay.getTime() === today.getTime()) return { color: 'orange', key: 'today' as const };
    return { color: 'violet', key: 'upcoming' as const };
}

export default function NextActionPanel({ companyId, contacts = [], canEdit, legacyNextStep }: NextActionPanelProps) {
    const { t, i18n } = useTranslation();
    const queryClient = useQueryClient();
    const { suggestNextAction } = useNextAction();
    const [formOpened, setFormOpened] = useState(false);
    const [editingTask, setEditingTask] = useState<CrmTask | null>(null);

    const { data, isLoading, isError } = useQuery<TasksResponse>({
        queryKey: ['tasks', 'company', companyId, 'pending'],
        queryFn: async () => (await api.get('/tasks', {
            params: { company_id: companyId, status: 'pending', limit: '20' },
        })).data,
        enabled: !!companyId,
    });

    const refresh = () => {
        queryClient.invalidateQueries({ queryKey: ['tasks'] });
        queryClient.invalidateQueries({ queryKey: ['pipeline'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard-upcoming'] });
    };

    const completeMutation = useMutation({
        mutationFn: async (taskId: string) => api.post(`/tasks/${taskId}/complete`, {}),
        onSuccess: (_data, taskId) => {
            refresh();
            showSuccess(t('tasks.completed', 'Görev tamamlandı'));
            const done = tasks.find((tk) => tk.id === taskId);
            suggestNextAction({
                companyId,
                initialContactId: done?.contact_id ?? undefined,
                contacts,
            });
        },
        onError: (error) => showErrorFromApi(error),
    });

    const cancelMutation = useMutation({
        mutationFn: async (taskId: string) => api.post(`/tasks/${taskId}/cancel`),
        onSuccess: () => {
            refresh();
            showSuccess(t('tasks.cancelled', 'Görev iptal edildi'));
        },
        onError: (error) => showErrorFromApi(error),
    });

    const tasks = data?.data || [];
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';

    const openCreate = () => {
        setEditingTask(null);
        setFormOpened(true);
    };

    const openEdit = (task: CrmTask) => {
        setEditingTask(task);
        setFormOpened(true);
    };

    return (
        <Paper shadow="sm" radius="lg" p="lg" withBorder mb="lg">
            <Group justify="space-between" align="center" mb={tasks.length > 0 || isLoading ? 'md' : 0}>
                <Group gap="sm">
                    <ThemeIcon variant="light" color="violet" radius="md" size="lg">
                        <IconCalendarDue size={20} />
                    </ThemeIcon>
                    <div>
                        <Title order={4} fw={650}>{t('tasks.nextActions', 'Sonraki aksiyonlar')}</Title>
                        <Text size="xs" c="dimmed">
                            {t('tasks.nextActionsDescription', 'Bu firmada yapılacak sıradaki işler')}
                        </Text>
                    </div>
                    {tasks.length > 0 && (
                        <Badge variant="light" color="violet" radius="xl">{tasks.length}</Badge>
                    )}
                </Group>

                {canEdit && (
                    <Button
                        size="sm"
                        variant={tasks.length > 0 ? 'light' : 'filled'}
                        color="violet"
                        leftSection={<IconPlus size={16} />}
                        onClick={openCreate}
                    >
                        {t('tasks.add', 'Görev ekle')}
                    </Button>
                )}
            </Group>

            {isLoading ? (
                <Stack gap="xs">
                    <Skeleton height={64} radius="md" />
                    <Skeleton height={64} radius="md" />
                </Stack>
            ) : isError ? (
                <Center py="md">
                    <Text size="sm" c="red">{t('tasks.loadError', 'Görevler yüklenemedi')}</Text>
                </Center>
            ) : tasks.length === 0 ? (
                <Stack gap={6} align="flex-start" mt="md">
                    <Text size="sm" fw={600}>{t('tasks.emptyTitle', 'Planlanmış bir sonraki aksiyon yok')}</Text>
                    <Text size="sm" c="dimmed">
                        {legacyNextStep
                            ? t('tasks.legacyNextStep', { defaultValue: 'Eski next step: {{value}}', value: legacyNextStep })
                            : t('tasks.emptyDescription', 'Bu firmanın takipten düşmemesi için tarihli bir görev ekleyin.')}
                    </Text>
                </Stack>
            ) : (
                <Stack gap="xs">
                    {tasks.map((task, index) => {
                        const state = dueState(task.due_at);
                        const dueLabel = new Date(task.due_at).toLocaleString(locale, {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                        });
                        return (
                            <Paper
                                key={task.id}
                                p="sm"
                                radius="md"
                                withBorder
                                style={{
                                    borderLeftWidth: index === 0 ? 3 : 1,
                                    borderLeftColor: index === 0
                                        ? `var(--mantine-color-${state.color}-5)`
                                        : undefined,
                                }}
                            >
                                <Group justify="space-between" wrap="nowrap" align="flex-start">
                                    <Group gap="sm" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
                                        {canEdit && (
                                            <Tooltip label={t('tasks.complete', 'Tamamla')} withArrow>
                                                <ActionIcon
                                                    variant="light"
                                                    color="green"
                                                    radius="xl"
                                                    mt={2}
                                                    loading={completeMutation.isPending && completeMutation.variables === task.id}
                                                    onClick={() => completeMutation.mutate(task.id)}
                                                >
                                                    <IconCheck size={15} />
                                                </ActionIcon>
                                            </Tooltip>
                                        )}
                                        <Stack gap={4} style={{ minWidth: 0 }}>
                                            <Group gap="xs" wrap="wrap">
                                                <Text size="sm" fw={index === 0 ? 650 : 550}>{task.title}</Text>
                                                {task.priority === 'high' && (
                                                    <Badge size="xs" variant="light" color="red">
                                                        {t('tasks.priorities.high', 'Yüksek')}
                                                    </Badge>
                                                )}
                                                {task.deal_id && (
                                                    <Badge
                                                        size="xs"
                                                        variant="light"
                                                        color="grape"
                                                        leftSection={<IconTargetArrow size={11} />}
                                                    >
                                                        {t('deals.linkedBadge', 'Firsat')}
                                                    </Badge>
                                                )}
                                            </Group>
                                            <Group gap="xs" wrap="wrap">
                                                <Badge
                                                    size="xs"
                                                    variant="light"
                                                    color={state.color}
                                                    leftSection={<IconClock size={11} />}
                                                >
                                                    {state.key === 'overdue'
                                                        ? t('tasks.overdue', 'Gecikmiş')
                                                        : state.key === 'today'
                                                        ? t('tasks.today', 'Bugün')
                                                        : dueLabel}
                                                </Badge>
                                                {state.key !== 'upcoming' && (
                                                    <Text size="xs" c="dimmed">{dueLabel}</Text>
                                                )}
                                                {task.contact_name && (
                                                    <Text size="xs" c="dimmed">· {task.contact_name}</Text>
                                                )}
                                                {task.assigned_user && (
                                                    <Text size="xs" c="dimmed">
                                                        · {task.assigned_user.name || task.assigned_user.email}
                                                    </Text>
                                                )}
                                            </Group>
                                            {task.detail && (
                                                <Text size="xs" c="dimmed" lineClamp={2}>{task.detail}</Text>
                                            )}
                                        </Stack>
                                    </Group>

                                    {canEdit && (
                                        <Menu withinPortal position="bottom-end" shadow="sm">
                                            <Menu.Target>
                                                <ActionIcon variant="subtle" color="gray" size="sm">
                                                    <IconDotsVertical size={15} />
                                                </ActionIcon>
                                            </Menu.Target>
                                            <Menu.Dropdown>
                                                <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => openEdit(task)}>
                                                    {t('tasks.edit', 'Görevi düzenle')}
                                                </Menu.Item>
                                                <Menu.Item
                                                    color="red"
                                                    leftSection={<IconX size={14} />}
                                                    onClick={() => cancelMutation.mutate(task.id)}
                                                >
                                                    {t('tasks.cancel', 'İptal et')}
                                                </Menu.Item>
                                            </Menu.Dropdown>
                                        </Menu>
                                    )}
                                </Group>
                            </Paper>
                        );
                    })}
                </Stack>
            )}

            <TaskForm
                opened={formOpened}
                onClose={() => { setFormOpened(false); setEditingTask(null); }}
                companyId={companyId}
                contacts={contacts}
                task={editingTask}
            />
        </Paper>
    );
}

