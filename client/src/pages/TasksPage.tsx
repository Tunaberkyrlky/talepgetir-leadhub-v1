import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
    ActionIcon,
    Anchor,
    Badge,
    Button,
    Center,
    Combobox,
    Container,
    Group,
    Input,
    InputBase,
    Loader,
    Menu,
    Modal,
    Paper,
    SegmentedControl,
    Select,
    Skeleton,
    Stack,
    Text,
    ThemeIcon,
    Title,
    Tooltip,
    useCombobox,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
    IconChevronLeft,
    IconChevronRight,
    IconCheck,
    IconClock,
    IconClockPause,
    IconDotsVertical,
    IconListCheck,
    IconPencil,
    IconPlus,
    IconRotateClockwise,
    IconUser,
    IconX,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { useNextAction } from '../contexts/NextActionContext';
import { canWrite } from '../lib/permissions';
import api from '../lib/api';
import { showErrorFromApi, showSuccess } from '../lib/notifications';
import TaskForm from '../components/tasks/TaskForm';
import OwnerSelect from '../components/OwnerSelect';
import type { CrmTask, TasksResponse } from '../types/task';

type TaskTab = 'overdue' | 'today' | 'upcoming' | 'completed';
type AssigneeScope = 'me' | 'created' | 'all';

const PAGE_LIMIT = 50;

function endOfToday(now: Date): string {
    const d = new Date(now);
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
}

function startOfTomorrow(now: Date): string {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
}

// Sekme zaman penceresi + filtreler → sunucu sorgu parametreleri.
// now HER fetch'te taze hesaplanır; sınırlar query key'e GİRMEZ (yeni key üretmesin diye),
// gece yarısı/uzun-açık-sayfa bayatlığını refetchInterval toplar.
function buildQueryParams(
    tab: TaskTab,
    assignee: AssigneeScope,
    companyId: string,
    priority: string,
): Record<string, string> {
    const now = new Date();
    const params: Record<string, string> = {};
    if (tab === 'overdue') {
        params.overdue = 'true';
    } else if (tab === 'today') {
        params.status = 'pending';
        params.date_from = now.toISOString();
        params.date_to = endOfToday(now);
    } else if (tab === 'upcoming') {
        params.status = 'pending';
        params.date_from = startOfTomorrow(now);
    } else {
        // completed — son 30 gün, due_at değil completed_at üzerinden.
        params.status = 'completed';
        const from = new Date(now);
        from.setDate(from.getDate() - 30);
        params.completed_from = from.toISOString();
    }
    if (assignee === 'me') params.assigned_to = 'me';
    else if (assignee === 'created') params.created_by = 'me';
    if (companyId) params.company_id = companyId;
    if (priority) params.priority = priority;
    return params;
}

// Ertele hedefi: bugünden itibaren, sabah 09:00.
function snoozeTo(daysFromNow: number): string {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
}

// v2 §9.3 — gecikme yalnız pending && due_at < now içindir.
function dueState(dueAt: string) {
    const due = new Date(dueAt);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    if (due.getTime() < now.getTime()) return { color: 'red', key: 'overdue' as const };
    if (dueDay.getTime() === today.getTime()) return { color: 'orange', key: 'today' as const };
    return { color: 'violet', key: 'upcoming' as const };
}

export default function TasksPage() {
    const { t, i18n } = useTranslation();
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const { suggestNextAction } = useNextAction();
    const canEdit = canWrite(user?.role || '');
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';

    const [activeTab, setActiveTab] = useState<TaskTab>('overdue');
    const [assigneeScope, setAssigneeScope] = useState<AssigneeScope>('me');
    const [priorityFilter, setPriorityFilter] = useState('');
    const [companyFilter, setCompanyFilter] = useState<{ id: string; name: string } | null>(null);
    const companyFilterId = companyFilter?.id ?? '';
    const [page, setPage] = useState(1);

    // Form state
    const [formOpened, setFormOpened] = useState(false);
    const [editingTask, setEditingTask] = useState<CrmTask | null>(null);

    // Reassign state (owner picker modal)
    const [reassignTask, setReassignTask] = useState<CrmTask | null>(null);
    const [reassignValue, setReassignValue] = useState<string | null>(null);

    // Şirket filtresi — ActivitiesPage ile aynı async Combobox deseni.
    const [companySearch, setCompanySearch] = useState('');
    const [debouncedCompanySearch] = useDebouncedValue(companySearch, 250);
    const [companyDropdownOpened, setCompanyDropdownOpened] = useState(false);
    const companyCombobox = useCombobox({
        onDropdownOpen: () => setCompanyDropdownOpened(true),
        onDropdownClose: () => {
            setCompanyDropdownOpened(false);
            companyCombobox.resetSelectedOption();
        },
    });

    const { data: companyOptions, isLoading: companyOptionsLoading } = useQuery<{
        data: { id: string; name: string }[];
    }>({
        queryKey: ['tasks-company-picker', debouncedCompanySearch],
        queryFn: async () => {
            const params: Record<string, string> = { limit: '20' };
            if (debouncedCompanySearch.trim()) params.search = debouncedCompanySearch.trim();
            return (await api.get('/companies', { params })).data;
        },
        enabled: companyDropdownOpened,
        staleTime: 30_000,
    });

    const { data, isLoading, isError } = useQuery<TasksResponse>({
        queryKey: ['tasks', 'my-work', activeTab, assigneeScope, companyFilterId, priorityFilter, page],
        // Sınırlar queryFn içinde taze hesaplanır (key'e girmez); refetchInterval bayatlığı toplar.
        queryFn: async () => {
            const params = buildQueryParams(activeTab, assigneeScope, companyFilterId, priorityFilter);
            return (await api.get('/tasks', {
                params: { ...params, page: String(page), limit: String(PAGE_LIMIT) },
            })).data;
        },
        refetchInterval: 300_000,
    });

    // Sekme veya filtre değişince ilk sayfaya dön (setState effect'i yerine olay anında).
    const changeTab = (v: TaskTab) => { setActiveTab(v); setPage(1); };
    const changeAssignee = (v: AssigneeScope) => { setAssigneeScope(v); setPage(1); };
    const changePriority = (v: string) => { setPriorityFilter(v); setPage(1); };
    const pickCompany = (c: { id: string; name: string } | null) => { setCompanyFilter(c); setPage(1); };

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
            if (done) {
                // Tek elemanlı contacts, önceden seçili kişiye TaskForm Select'inde etiket kazandırır.
                suggestNextAction({
                    companyId: done.company_id,
                    initialContactId: done.contact_id ?? undefined,
                    contacts: done.contact_id
                        ? [{ id: done.contact_id, first_name: done.contact_name ?? '' }]
                        : [],
                });
            }
        },
        onError: (error) => showErrorFromApi(error),
    });

    const cancelMutation = useMutation({
        mutationFn: async (taskId: string) => api.post(`/tasks/${taskId}/cancel`),
        onSuccess: () => { refresh(); showSuccess(t('tasks.cancelled', 'Görev iptal edildi')); },
        onError: (error) => showErrorFromApi(error),
    });

    const reopenMutation = useMutation({
        mutationFn: async (taskId: string) => api.post(`/tasks/${taskId}/reopen`),
        onSuccess: () => { refresh(); showSuccess(t('tasks.reopened', 'Görev yeniden açıldı')); },
        onError: (error) => showErrorFromApi(error),
    });

    const snoozeMutation = useMutation({
        mutationFn: async ({ id, due_at }: { id: string; due_at: string }) =>
            api.put(`/tasks/${id}`, { due_at }),
        onSuccess: () => { refresh(); showSuccess(t('tasks.snoozed', 'Görev ertelendi')); },
        onError: (error) => showErrorFromApi(error),
    });

    const reassignMutation = useMutation({
        mutationFn: async ({ id, assigned_to }: { id: string; assigned_to: string | null }) =>
            api.put(`/tasks/${id}`, { assigned_to }),
        onSuccess: () => {
            refresh();
            setReassignTask(null);
            showSuccess(t('owner.taskReassigned'));
        },
        onError: (error) => showErrorFromApi(error),
    });

    const openReassign = (task: CrmTask) => {
        setReassignTask(task);
        setReassignValue(task.assigned_to ?? null);
    };

    const tasks = data?.data || [];
    const total = data?.pagination?.total ?? 0;
    const hasNext = data?.pagination?.hasNext ?? false;
    const hasPrev = data?.pagination?.hasPrev ?? false;

    const openCreate = () => { setEditingTask(null); setFormOpened(true); };
    const openEdit = (task: CrmTask) => { setEditingTask(task); setFormOpened(true); };

    const tabs: { value: TaskTab; label: string }[] = [
        { value: 'overdue', label: t('tasks.tabsOverdue', 'Gecikmiş') },
        { value: 'today', label: t('tasks.tabsToday', 'Bugün') },
        { value: 'upcoming', label: t('tasks.tabsUpcoming', 'Yaklaşan') },
        { value: 'completed', label: t('tasks.tabsCompleted', 'Tamamlanan') },
    ];

    const emptyCopy: Record<TaskTab, { title: string; description: string }> = {
        overdue: {
            title: t('tasks.emptyOverdueTitle', 'Gecikmiş görev yok'),
            description: t('tasks.emptyOverdueDescription', 'Harika, geride kalan bir işiniz yok.'),
        },
        today: {
            title: t('tasks.emptyTodayTitle', 'Bugün için görev yok'),
            description: t('tasks.emptyTodayDescription', 'Bir firma seçip tarihli görev ekleyerek gününüzü planlayın.'),
        },
        upcoming: {
            title: t('tasks.emptyUpcomingTitle', 'Yaklaşan görev yok'),
            description: t('tasks.emptyUpcomingDescription', 'İleriye dönük takipler için bir firmaya tarihli görev ekleyin.'),
        },
        completed: {
            title: t('tasks.emptyCompletedTitle', 'Tamamlanan görev yok'),
            description: t('tasks.emptyCompletedDescription', 'Son 30 günde tamamladığınız bir görev bulunmuyor.'),
        },
    };

    const renderTask = (task: CrmTask) => {
        const state = dueState(task.due_at);
        const isCompleted = task.status === 'completed';
        const isCancelled = task.status === 'cancelled';
        const dueLabel = new Date(task.due_at).toLocaleString(locale, {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
        });
        const busy = completeMutation.variables === task.id
            || cancelMutation.variables === task.id
            || reopenMutation.variables === task.id
            || (snoozeMutation.isPending && snoozeMutation.variables?.id === task.id);

        return (
            <Paper key={task.id} p="sm" radius="md" withBorder>
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                    <Group gap="sm" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
                        {canEdit && task.status === 'pending' && (
                            <Tooltip label={t('tasks.complete', 'Tamamla')} withArrow>
                                <ActionIcon
                                    variant="light"
                                    color="green"
                                    radius="xl"
                                    mt={2}
                                    aria-label={t('tasks.complete', 'Tamamla')}
                                    loading={completeMutation.isPending && completeMutation.variables === task.id}
                                    onClick={() => completeMutation.mutate(task.id)}
                                >
                                    <IconCheck size={15} />
                                </ActionIcon>
                            </Tooltip>
                        )}
                        {isCompleted && (
                            <ThemeIcon variant="light" color="green" radius="xl" size="md" mt={2}>
                                <IconCheck size={15} />
                            </ThemeIcon>
                        )}
                        <Stack gap={4} style={{ minWidth: 0 }}>
                            <Group gap="xs" wrap="wrap">
                                <Text size="sm" fw={600} td={isCompleted || isCancelled ? 'line-through' : undefined}>
                                    {task.title}
                                </Text>
                                {task.priority === 'high' && task.status === 'pending' && (
                                    <Badge size="xs" variant="light" color="red">
                                        {t('tasks.priorities.high', 'Yüksek')}
                                    </Badge>
                                )}
                            </Group>
                            <Group gap="xs" wrap="wrap">
                                {task.company_name && (
                                    <Anchor
                                        component={Link}
                                        to={`/companies/${task.company_id}`}
                                        size="xs"
                                        fw={600}
                                        c="blue"
                                    >
                                        {task.company_name}
                                    </Anchor>
                                )}
                                {task.status === 'pending' ? (
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
                                ) : (
                                    <Badge
                                        size="xs"
                                        variant="light"
                                        color={isCompleted ? 'green' : 'gray'}
                                        leftSection={<IconClock size={11} />}
                                    >
                                        {isCompleted
                                            ? t('tasks.completedBadge', 'Tamamlandı')
                                            : t('tasks.cancelledBadge', 'İptal edildi')}
                                    </Badge>
                                )}
                                {task.status === 'pending' && state.key !== 'upcoming' && (
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
                                <ActionIcon
                                    variant="subtle"
                                    color="gray"
                                    size="sm"
                                    loading={busy}
                                    aria-label={t('common.actions', 'İşlemler')}
                                >
                                    <IconDotsVertical size={15} />
                                </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                                {task.status === 'pending' ? (
                                    <>
                                        <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => openEdit(task)}>
                                            {t('tasks.edit', 'Görevi düzenle')}
                                        </Menu.Item>
                                        <Menu.Item leftSection={<IconUser size={14} />} onClick={() => openReassign(task)}>
                                            {t('owner.reassign')}
                                        </Menu.Item>
                                        <Menu.Label>{t('tasks.snooze', 'Ertele')}</Menu.Label>
                                        <Menu.Item
                                            leftSection={<IconClockPause size={14} />}
                                            onClick={() => snoozeMutation.mutate({ id: task.id, due_at: snoozeTo(1) })}
                                        >
                                            {t('tasks.snoozeTomorrow', 'Yarına ertele')}
                                        </Menu.Item>
                                        <Menu.Item
                                            leftSection={<IconClockPause size={14} />}
                                            onClick={() => snoozeMutation.mutate({ id: task.id, due_at: snoozeTo(7) })}
                                        >
                                            {t('tasks.snoozeNextWeek', 'Gelecek haftaya ertele')}
                                        </Menu.Item>
                                        <Menu.Divider />
                                        <Menu.Item
                                            color="red"
                                            leftSection={<IconX size={14} />}
                                            onClick={() => cancelMutation.mutate(task.id)}
                                        >
                                            {t('tasks.cancel', 'İptal et')}
                                        </Menu.Item>
                                    </>
                                ) : (
                                    <Menu.Item
                                        leftSection={<IconRotateClockwise size={14} />}
                                        onClick={() => reopenMutation.mutate(task.id)}
                                    >
                                        {t('tasks.reopen', 'Yeniden aç')}
                                    </Menu.Item>
                                )}
                            </Menu.Dropdown>
                        </Menu>
                    )}
                </Group>
            </Paper>
        );
    };

    return (
        <Container size="lg" py="xl">
            {/* Header */}
            <Group justify="space-between" align="center" mb="md" wrap="wrap" gap="sm">
                <Group gap="sm">
                    <ThemeIcon variant="light" color="violet" radius="md" size="lg">
                        <IconListCheck size={20} />
                    </ThemeIcon>
                    <Group gap="xs">
                        <Title order={2}>{t('tasks.pageTitle', 'İşlerim')}</Title>
                        <Badge size="lg" variant="light" color="violet" radius="xl">{total}</Badge>
                    </Group>
                </Group>

                {canEdit && (
                    <Button
                        color="violet"
                        leftSection={<IconPlus size={16} />}
                        onClick={openCreate}
                    >
                        {t('tasks.create', 'Görev oluştur')}
                    </Button>
                )}
            </Group>

            {/* Tabs */}
            <SegmentedControl
                mb="md"
                value={activeTab}
                onChange={(v) => changeTab(v as TaskTab)}
                data={tabs.map((tab) => ({ value: tab.value, label: tab.label }))}
            />

            {/* Filters */}
            <Group justify="space-between" mb="md" wrap="wrap" gap="sm">
                <Group gap="sm" wrap="wrap" align="center">
                    <SegmentedControl
                        size="sm"
                        value={assigneeScope}
                        onChange={(v) => changeAssignee(v as AssigneeScope)}
                        data={[
                            { value: 'me', label: t('tasks.assigneeMe', 'Bana atanan') },
                            { value: 'created', label: t('tasks.assigneeCreated', 'Oluşturduğum') },
                            { value: 'all', label: t('tasks.assigneeAll', 'Tümü') },
                        ]}
                    />

                    <Combobox
                        store={companyCombobox}
                        width={280}
                        position="bottom-start"
                        onOptionSubmit={(val) => {
                            const picked = companyOptions?.data.find((c) => c.id === val);
                            if (picked) pickCompany({ id: picked.id, name: picked.name });
                            setCompanySearch('');
                            companyCombobox.closeDropdown();
                        }}
                    >
                        <Combobox.Target>
                            <InputBase
                                component="button"
                                type="button"
                                pointer
                                size="sm"
                                rightSection={
                                    companyFilter ? (
                                        <ActionIcon
                                            variant="transparent"
                                            color="gray"
                                            size="sm"
                                            aria-label={t('tasks.clearCompanyFilter', 'Firma filtresini temizle')}
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={() => pickCompany(null)}
                                        >
                                            <IconX size={14} />
                                        </ActionIcon>
                                    ) : (
                                        <Combobox.Chevron />
                                    )
                                }
                                rightSectionPointerEvents={companyFilter ? 'all' : 'none'}
                                onClick={() => companyCombobox.toggleDropdown()}
                                style={{ minWidth: 200 }}
                            >
                                {companyFilter?.name ?? (
                                    <Input.Placeholder>{t('tasks.filterCompany', 'Firmaya göre')}</Input.Placeholder>
                                )}
                            </InputBase>
                        </Combobox.Target>
                        <Combobox.Dropdown>
                            <Combobox.Search
                                value={companySearch}
                                onChange={(e) => setCompanySearch(e.currentTarget.value)}
                                placeholder={t('tasks.searchCompanyPlaceholder', 'Firma ara...')}
                            />
                            <Combobox.Options mah={280} style={{ overflowY: 'auto' }}>
                                {companyOptionsLoading ? (
                                    <Combobox.Empty><Loader size="xs" color="violet" /></Combobox.Empty>
                                ) : (companyOptions?.data?.length ?? 0) === 0 ? (
                                    <Combobox.Empty>
                                        {debouncedCompanySearch
                                            ? t('filter.noResults', 'Sonuç yok')
                                            : t('tasks.searchCompanyHint', 'Aramaya başlayın')}
                                    </Combobox.Empty>
                                ) : (
                                    companyOptions!.data.map((c) => (
                                        <Combobox.Option value={c.id} key={c.id}>{c.name}</Combobox.Option>
                                    ))
                                )}
                            </Combobox.Options>
                        </Combobox.Dropdown>
                    </Combobox>
                </Group>

                <Select
                    size="sm"
                    placeholder={t('tasks.filterPriority', 'Öncelik')}
                    clearable
                    value={priorityFilter || null}
                    onChange={(v) => changePriority(v || '')}
                    data={[
                        { value: 'high', label: t('tasks.priorities.high', 'Yüksek') },
                        { value: 'normal', label: t('tasks.priorities.normal', 'Normal') },
                        { value: 'low', label: t('tasks.priorities.low', 'Düşük') },
                    ]}
                    style={{ minWidth: 150 }}
                />
            </Group>

            {/* List */}
            {isLoading ? (
                <Stack gap="xs">
                    <Skeleton height={72} radius="md" />
                    <Skeleton height={72} radius="md" />
                    <Skeleton height={72} radius="md" />
                </Stack>
            ) : isError ? (
                <Center py="xl">
                    <Text size="sm" c="red">{t('tasks.loadError', 'Görevler yüklenemedi')}</Text>
                </Center>
            ) : tasks.length === 0 ? (
                <Paper radius="lg" p="xl" withBorder>
                    <Stack gap="sm" align="center" ta="center">
                        <ThemeIcon variant="light" color="violet" radius="xl" size={48}>
                            <IconListCheck size={26} />
                        </ThemeIcon>
                        <Text fw={650}>{emptyCopy[activeTab].title}</Text>
                        <Text size="sm" c="dimmed" maw={420}>{emptyCopy[activeTab].description}</Text>
                        {canEdit && (
                            <Button
                                mt="xs"
                                variant="light"
                                color="violet"
                                leftSection={<IconPlus size={16} />}
                                onClick={openCreate}
                            >
                                {t('tasks.create', 'Görev oluştur')}
                            </Button>
                        )}
                    </Stack>
                </Paper>
            ) : (
                <Stack gap="xs">
                    {tasks.map(renderTask)}

                    {(hasPrev || hasNext) && (
                        <Group justify="center" mt="sm" gap="xs">
                            <ActionIcon
                                variant="light"
                                color="gray"
                                disabled={!hasPrev}
                                aria-label={t('pagination.prev', 'Önceki')}
                                onClick={() => setPage((p) => Math.max(1, p - 1))}
                            >
                                <IconChevronLeft size={16} />
                            </ActionIcon>
                            <Text size="sm" c="dimmed">{page}</Text>
                            <ActionIcon
                                variant="light"
                                color="gray"
                                disabled={!hasNext}
                                aria-label={t('pagination.next', 'Sonraki')}
                                onClick={() => setPage((p) => p + 1)}
                            >
                                <IconChevronRight size={16} />
                            </ActionIcon>
                        </Group>
                    )}
                </Stack>
            )}

            <TaskForm
                opened={formOpened}
                onClose={() => { setFormOpened(false); setEditingTask(null); }}
                enableCompanyPicker
                task={editingTask}
            />

            <Modal
                opened={!!reassignTask}
                onClose={() => setReassignTask(null)}
                title={t('owner.reassign')}
                size="sm"
                radius="lg"
                centered
                overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
                styles={{ title: { fontWeight: 700 } }}
            >
                <Stack gap="md">
                    <OwnerSelect
                        label={t('owner.assignee')}
                        value={reassignValue}
                        onChange={setReassignValue}
                    />
                    <Group justify="flex-end">
                        <Button variant="default" radius="md" onClick={() => setReassignTask(null)}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            color="violet"
                            radius="md"
                            loading={reassignMutation.isPending}
                            onClick={() => reassignTask && reassignMutation.mutate({ id: reassignTask.id, assigned_to: reassignValue })}
                        >
                            {t('common.save')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Container>
    );
}
