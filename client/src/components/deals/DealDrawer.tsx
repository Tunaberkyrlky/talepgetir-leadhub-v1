/**
 * Firsat detay çekmecesi — bilgiler + durum rozeti, kişi rolleri (ekle/çıkar) ve
 * firsata bağlı görev listesi (TaskForm ile deal_id geçirilerek oluşturulur).
 * Kapat (won/lost; lost'ta neden zorunlu) / Yeniden Aç / Düzenle / Sil aksiyonları.
 */
import { useState } from 'react';
import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    Divider,
    Drawer,
    Group,
    Loader,
    Menu,
    Modal,
    Paper,
    Select,
    Stack,
    Text,
    Textarea,
    ThemeIcon,
    Title,
    Tooltip,
} from '@mantine/core';
import {
    IconBuildingStore,
    IconCalendarDue,
    IconCheck,
    IconDotsVertical,
    IconPencil,
    IconPlus,
    IconRotateClockwise,
    IconTrash,
    IconUserPlus,
    IconX,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';
import { useAuth } from '../../contexts/AuthContext';
import { useStages } from '../../contexts/StagesContext';
import type { CrmTask, TasksResponse } from '../../types/task';
import type { DealContactRole, DealDetail } from '../../types/deal';
import DealFormModal from './DealFormModal';
import TaskForm from '../tasks/TaskForm';

interface DealContact {
    id: string;
    first_name: string;
    last_name?: string | null;
}

interface DealDrawerProps {
    dealId: string | null;
    onClose: () => void;
    companyId: string;
    // Firmanın kişileri — kişi rolleri ve görev kişi seçici için kaynak.
    contacts?: DealContact[];
    canEdit: boolean;
}

const CONTACT_ROLES: DealContactRole[] = ['decision_maker', 'influencer', 'champion', 'user', 'blocker'];

function statusColor(status: DealDetail['status']): string {
    if (status === 'won') return 'green';
    if (status === 'lost') return 'red';
    return 'blue';
}

export default function DealDrawer({ dealId, onClose, companyId, contacts = [], canEdit }: DealDrawerProps) {
    const { t, i18n } = useTranslation();
    const { activeTenantId } = useAuth();
    const queryClient = useQueryClient();
    const { getStageColor, getStageLabel } = useStages();

    const [editOpen, setEditOpen] = useState(false);
    const [taskFormOpen, setTaskFormOpen] = useState(false);
    const [lossModalOpen, setLossModalOpen] = useState(false);
    const [lossReason, setLossReason] = useState('');
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [newContactId, setNewContactId] = useState<string | null>(null);
    const [newRole, setNewRole] = useState<string | null>(null);

    // Deal değişince (aynı çekmece farklı firsata geçince) taslak/aksiyon state'lerini sıfırla,
    // aksi halde önceki firsatın kişi-ekle taslağı ya da açık modalları yeni firsata sızar.
    // React'in "prop değişince state ayarla" deseni: render sırasında (effect'te değil).
    const [prevDealId, setPrevDealId] = useState<string | null>(dealId);
    if (dealId !== prevDealId) {
        setPrevDealId(dealId);
        setEditOpen(false);
        setTaskFormOpen(false);
        setLossModalOpen(false);
        setLossReason('');
        setDeleteConfirmOpen(false);
        setNewContactId(null);
        setNewRole(null);
    }

    const detailQuery = useQuery<DealDetail>({
        // Tenant-scoped key + pinned header so a tenant switch never surfaces another tenant's deal.
        queryKey: ['deals', activeTenantId, 'detail', dealId],
        queryFn: async ({ queryKey, signal }) => {
            const tid = queryKey[1] as string;
            return (await api.get(`/deals/${dealId}`, { headers: { 'X-Tenant-Id': tid }, signal })).data.data;
        },
        enabled: !!dealId && !!activeTenantId,
    });

    const tasksQuery = useQuery<TasksResponse>({
        queryKey: ['tasks', activeTenantId, 'deal', dealId],
        queryFn: async ({ queryKey, signal }) => {
            const tid = queryKey[1] as string;
            return (await api.get('/tasks', {
                params: { deal_id: dealId, limit: '50' },
                headers: { 'X-Tenant-Id': tid },
                signal,
            })).data;
        },
        enabled: !!dealId && !!activeTenantId,
    });

    const deal = detailQuery.data;
    const tasks = tasksQuery.data?.data || [];
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';

    const refreshDetail = () => {
        queryClient.invalidateQueries({ queryKey: ['deals', activeTenantId] });
    };

    const closeMutation = useMutation({
        mutationFn: async (body: { status: 'won' | 'lost'; loss_reason?: string }) =>
            (await api.post(`/deals/${dealId}/close`, body)).data,
        onSuccess: (_data, body) => {
            refreshDetail();
            setLossModalOpen(false);
            setLossReason('');
            showSuccess(body.status === 'won'
                ? t('deals.markedWon', 'Firsat kazanıldı olarak işaretlendi')
                : t('deals.markedLost', 'Firsat kaybedildi olarak işaretlendi'));
        },
        onError: (error) => showErrorFromApi(error),
    });

    const reopenMutation = useMutation({
        mutationFn: async () => (await api.post(`/deals/${dealId}/reopen`, {})).data,
        onSuccess: () => {
            refreshDetail();
            showSuccess(t('deals.reopened', 'Firsat yeniden açıldı'));
        },
        onError: (error) => showErrorFromApi(error),
    });

    const deleteMutation = useMutation({
        mutationFn: async () => api.delete(`/deals/${dealId}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['deals', activeTenantId] });
            // Silinen firsatın görevleri tasks.deal_id SET NULL olur; ilişkili tüm görev
            // listelerinin güncellenmesi için görev cache'lerini geniş anahtarla tazele.
            queryClient.invalidateQueries({ queryKey: ['tasks'] });
            setDeleteConfirmOpen(false);
            showSuccess(t('deals.deleted', 'Firsat silindi'));
            onClose();
        },
        onError: (error) => showErrorFromApi(error),
    });

    const addContactMutation = useMutation({
        mutationFn: async () => (await api.post(`/deals/${dealId}/contacts`, {
            contact_id: newContactId,
            role: newRole || null,
        })).data,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['deals', activeTenantId, 'detail', dealId] });
            setNewContactId(null);
            setNewRole(null);
            showSuccess(t('deals.contactAdded', 'Kişi firsata eklendi'));
        },
        onError: (error) => showErrorFromApi(error),
    });

    const removeContactMutation = useMutation({
        mutationFn: async (contactId: string) => api.delete(`/deals/${dealId}/contacts/${contactId}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['deals', activeTenantId, 'detail', dealId] });
            showSuccess(t('deals.contactRemoved', 'Kişi firsattan çıkarıldı'));
        },
        onError: (error) => showErrorFromApi(error),
    });

    // Zaten bağlı olmayan firma kişileri (rol ekleme seçicisi için).
    const linkedIds = new Set((deal?.contacts || []).map((c) => c.contact_id));
    const availableContacts = contacts.filter((c) => !linkedIds.has(c.id));

    const handleClose = () => {
        if (closeMutation.isPending || reopenMutation.isPending || deleteMutation.isPending) return;
        onClose();
    };

    return (
        <>
            <Drawer
                opened={!!dealId}
                onClose={handleClose}
                position="right"
                size="lg"
                title={t('deals.detailTitle', 'Firsat detayı')}
                styles={{ title: { fontWeight: 700, fontSize: '1.1rem' } }}
            >
                {detailQuery.isLoading || !deal ? (
                    detailQuery.isError ? (
                        <Alert color="red" variant="light">{t('deals.loadError', 'Firsat yüklenemedi')}</Alert>
                    ) : (
                        <Group justify="center" p="xl"><Loader color="violet" /></Group>
                    )
                ) : (
                    <Stack gap="md">
                        {/* Başlık + aksiyonlar */}
                        <Group justify="space-between" align="flex-start" wrap="nowrap">
                            <div style={{ minWidth: 0 }}>
                                <Title order={4} fw={650}>{deal.title}</Title>
                                <Group gap={6} mt={4}>
                                    <Badge variant="light" color={getStageColor(deal.stage)} radius="sm">
                                        {getStageLabel(deal.stage)}
                                    </Badge>
                                    <Badge variant="filled" color={statusColor(deal.status)} radius="sm">
                                        {t(`deals.status.${deal.status}`, deal.status)}
                                    </Badge>
                                </Group>
                            </div>
                            {canEdit && (
                                <Menu withinPortal position="bottom-end" shadow="sm">
                                    <Menu.Target>
                                        <ActionIcon variant="subtle" color="gray"><IconDotsVertical size={18} /></ActionIcon>
                                    </Menu.Target>
                                    <Menu.Dropdown>
                                        <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => setEditOpen(true)}>
                                            {t('deals.edit', 'Firsatı düzenle')}
                                        </Menu.Item>
                                        <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => setDeleteConfirmOpen(true)}>
                                            {t('deals.delete', 'Firsatı sil')}
                                        </Menu.Item>
                                    </Menu.Dropdown>
                                </Menu>
                            )}
                        </Group>

                        {/* Özet bilgiler */}
                        <Paper withBorder p="md" radius="md">
                            <Stack gap="xs">
                                <Group justify="space-between">
                                    <Text size="sm" c="dimmed">{t('deals.company', 'Firma')}</Text>
                                    <Group gap={6}><IconBuildingStore size={14} /><Text size="sm" fw={600}>{deal.company_name || '—'}</Text></Group>
                                </Group>
                                <Group justify="space-between">
                                    <Text size="sm" c="dimmed">{t('deals.amount', 'Tutar')}</Text>
                                    <Text size="sm" fw={600}>
                                        {deal.amount != null ? `${deal.amount.toLocaleString(locale)} ${deal.currency}` : '—'}
                                    </Text>
                                </Group>
                                <Group justify="space-between">
                                    <Text size="sm" c="dimmed">{t('deals.expectedClose', 'Tahmini kapanış')}</Text>
                                    <Text size="sm">
                                        {deal.expected_close
                                            ? new Date(`${deal.expected_close}T00:00:00`).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' })
                                            : '—'}
                                    </Text>
                                </Group>
                                <Group justify="space-between">
                                    <Text size="sm" c="dimmed">{t('owner.label')}</Text>
                                    <Text size="sm">{deal.owner_user ? (deal.owner_user.name || deal.owner_user.email) : t('owner.unassigned')}</Text>
                                </Group>
                                {deal.description && (
                                    <>
                                        <Divider my={2} />
                                        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{deal.description}</Text>
                                    </>
                                )}
                                {deal.status === 'lost' && deal.loss_reason && (
                                    <Alert color="red" variant="light" title={t('deals.lossReason', 'Kayıp nedeni')} mt={4}>
                                        {deal.loss_reason}
                                    </Alert>
                                )}
                            </Stack>
                        </Paper>

                        {/* Durum aksiyonları */}
                        {canEdit && (
                            <Group>
                                {deal.status === 'open' ? (
                                    <>
                                        <Button
                                            variant="light"
                                            color="green"
                                            leftSection={<IconCheck size={16} />}
                                            loading={closeMutation.isPending && closeMutation.variables?.status === 'won'}
                                            onClick={() => closeMutation.mutate({ status: 'won' })}
                                        >
                                            {t('deals.markWon', 'Kazanıldı')}
                                        </Button>
                                        <Button
                                            variant="light"
                                            color="red"
                                            leftSection={<IconX size={16} />}
                                            onClick={() => { setLossReason(''); setLossModalOpen(true); }}
                                        >
                                            {t('deals.markLost', 'Kaybedildi')}
                                        </Button>
                                    </>
                                ) : (
                                    <Button
                                        variant="light"
                                        color="violet"
                                        leftSection={<IconRotateClockwise size={16} />}
                                        loading={reopenMutation.isPending}
                                        onClick={() => reopenMutation.mutate()}
                                    >
                                        {t('deals.reopen', 'Yeniden aç')}
                                    </Button>
                                )}
                            </Group>
                        )}

                        <Divider />

                        {/* Kişi rolleri */}
                        <div>
                            <Group justify="space-between" mb="xs">
                                <Text fw={650} size="sm">{t('deals.contactRoles', 'Kişi rolleri')}</Text>
                                {deal.contacts.length > 0 && (
                                    <Badge variant="light" color="violet" radius="xl">{deal.contacts.length}</Badge>
                                )}
                            </Group>
                            {deal.contacts.length === 0 ? (
                                <Text size="sm" c="dimmed">{t('deals.noContacts', 'Bu firsata henüz kişi eklenmedi.')}</Text>
                            ) : (
                                <Stack gap="xs">
                                    {deal.contacts.map((dc) => (
                                        <Paper key={dc.id} withBorder p="xs" radius="md">
                                            <Group justify="space-between" wrap="nowrap">
                                                <div style={{ minWidth: 0 }}>
                                                    <Text size="sm" fw={550}>{dc.contact_name || '—'}</Text>
                                                    {dc.contact_title && <Text size="xs" c="dimmed">{dc.contact_title}</Text>}
                                                </div>
                                                <Group gap={6} wrap="nowrap">
                                                    {dc.role && (
                                                        <Badge variant="outline" color="gray" radius="sm">
                                                            {t(`deals.roles.${dc.role}`, dc.role)}
                                                        </Badge>
                                                    )}
                                                    {canEdit && (
                                                        <Tooltip label={t('deals.removeContact', 'Kişiyi çıkar')} withArrow>
                                                            <ActionIcon
                                                                variant="subtle"
                                                                color="red"
                                                                size="sm"
                                                                loading={removeContactMutation.isPending && removeContactMutation.variables === dc.contact_id}
                                                                onClick={() => removeContactMutation.mutate(dc.contact_id)}
                                                            >
                                                                <IconX size={15} />
                                                            </ActionIcon>
                                                        </Tooltip>
                                                    )}
                                                </Group>
                                            </Group>
                                        </Paper>
                                    ))}
                                </Stack>
                            )}
                            {canEdit && availableContacts.length > 0 && (
                                <Group gap="xs" mt="xs" align="flex-end">
                                    <Select
                                        style={{ flex: 1 }}
                                        size="xs"
                                        placeholder={t('deals.selectContact', 'Kişi seçin')}
                                        data={availableContacts.map((c) => ({
                                            value: c.id,
                                            label: [c.first_name, c.last_name].filter(Boolean).join(' '),
                                        }))}
                                        searchable
                                        radius="md"
                                        value={newContactId}
                                        onChange={setNewContactId}
                                    />
                                    <Select
                                        w={150}
                                        size="xs"
                                        placeholder={t('deals.selectRole', 'Rol')}
                                        data={CONTACT_ROLES.map((r) => ({ value: r, label: t(`deals.roles.${r}`, r) }))}
                                        clearable
                                        radius="md"
                                        value={newRole}
                                        onChange={setNewRole}
                                    />
                                    <Button
                                        size="xs"
                                        variant="light"
                                        color="violet"
                                        leftSection={<IconUserPlus size={14} />}
                                        disabled={!newContactId}
                                        loading={addContactMutation.isPending}
                                        onClick={() => addContactMutation.mutate()}
                                    >
                                        {t('deals.link', 'Ekle')}
                                    </Button>
                                </Group>
                            )}
                        </div>

                        <Divider />

                        {/* Firsat görevleri */}
                        <div>
                            <Group justify="space-between" mb="xs">
                                <Group gap="sm">
                                    <ThemeIcon variant="light" color="violet" radius="md" size="md"><IconCalendarDue size={16} /></ThemeIcon>
                                    <Text fw={650} size="sm">{t('deals.tasks', 'Firsat görevleri')}</Text>
                                    {tasks.length > 0 && <Badge variant="light" color="violet" radius="xl">{tasks.length}</Badge>}
                                </Group>
                                {canEdit && (
                                    <Button size="compact-sm" variant="light" color="violet" leftSection={<IconPlus size={14} />} onClick={() => setTaskFormOpen(true)}>
                                        {t('tasks.add', 'Görev ekle')}
                                    </Button>
                                )}
                            </Group>
                            {tasksQuery.isLoading ? (
                                <Group gap="xs"><Loader size="xs" color="violet" /><Text size="sm" c="dimmed">{t('common.loading')}</Text></Group>
                            ) : tasksQuery.isError ? (
                                <Text size="sm" c="red">{t('tasks.loadError', 'Görevler yüklenemedi')}</Text>
                            ) : tasks.length === 0 ? (
                                <Text size="sm" c="dimmed">{t('deals.noTasks', 'Bu firsata bağlı görev yok.')}</Text>
                            ) : (
                                <Stack gap="xs">
                                    {tasks.map((task: CrmTask) => (
                                        <Paper key={task.id} withBorder p="xs" radius="md">
                                            <Group justify="space-between" wrap="nowrap" align="flex-start">
                                                <div style={{ minWidth: 0 }}>
                                                    <Text size="sm" fw={550}>{task.title}</Text>
                                                    <Text size="xs" c="dimmed">
                                                        {new Date(task.due_at).toLocaleString(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                                        {task.assigned_user ? ` · ${task.assigned_user.name || task.assigned_user.email}` : ''}
                                                    </Text>
                                                </div>
                                                <Badge
                                                    size="xs"
                                                    variant="light"
                                                    color={task.status === 'completed' ? 'green' : task.status === 'cancelled' ? 'gray' : 'blue'}
                                                >
                                                    {t(`deals.taskStatus.${task.status}`, task.status)}
                                                </Badge>
                                            </Group>
                                        </Paper>
                                    ))}
                                </Stack>
                            )}
                        </div>
                    </Stack>
                )}
            </Drawer>

            {/* Kayıp nedeni modalı (lost'ta zorunlu) */}
            <Modal
                opened={lossModalOpen}
                onClose={() => setLossModalOpen(false)}
                title={t('deals.markLost', 'Kaybedildi')}
                size="md"
                radius="lg"
                centered
            >
                <Stack gap="md">
                    <Textarea
                        label={t('deals.lossReason', 'Kayıp nedeni')}
                        placeholder={t('deals.lossReasonPlaceholder', 'Bu firsat neden kaybedildi?')}
                        required
                        autosize
                        minRows={3}
                        radius="md"
                        value={lossReason}
                        onChange={(e) => setLossReason(e.currentTarget.value)}
                    />
                    <Group justify="flex-end">
                        <Button variant="default" radius="md" onClick={() => setLossModalOpen(false)}>{t('common.cancel')}</Button>
                        <Button
                            color="red"
                            radius="md"
                            disabled={!lossReason.trim()}
                            loading={closeMutation.isPending && closeMutation.variables?.status === 'lost'}
                            onClick={() => closeMutation.mutate({ status: 'lost', loss_reason: lossReason.trim() })}
                        >
                            {t('deals.confirmLost', 'Kaybedildi olarak kapat')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            {/* Silme onayı */}
            <Modal
                opened={deleteConfirmOpen}
                onClose={() => setDeleteConfirmOpen(false)}
                title={t('deals.delete', 'Firsatı sil')}
                size="sm"
                radius="lg"
                centered
            >
                <Stack gap="md">
                    <Text size="sm">{t('deals.deleteConfirm', 'Bu firsatı silmek istediğinize emin misiniz? Bu işlem geri alınamaz.')}</Text>
                    <Group justify="flex-end">
                        <Button variant="default" radius="md" onClick={() => setDeleteConfirmOpen(false)}>{t('common.cancel')}</Button>
                        <Button color="red" radius="md" loading={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
                            {t('deals.delete', 'Firsatı sil')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            {/* Düzenleme modalı */}
            {deal && (
                <DealFormModal
                    opened={editOpen}
                    onClose={() => setEditOpen(false)}
                    companyId={companyId}
                    contacts={contacts}
                    deal={deal}
                    onSuccess={() => queryClient.invalidateQueries({ queryKey: ['deals', activeTenantId, 'detail', dealId] })}
                />
            )}

            {/* Firsat-kapsamlı görev oluşturma */}
            <TaskForm
                opened={taskFormOpen}
                onClose={() => setTaskFormOpen(false)}
                companyId={companyId}
                contacts={contacts}
                dealId={dealId || undefined}
            />
        </>
    );
}
