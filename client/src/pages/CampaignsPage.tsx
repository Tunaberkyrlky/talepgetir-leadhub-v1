import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
    Container, Title, Group, Stack, Paper, Text, Badge, Table, Tabs,
    Loader, SimpleGrid, Button, TextInput, Select, Menu, ActionIcon, Modal, Alert, Tooltip, Switch, Skeleton, Pagination,
} from '@mantine/core';
import {
    IconSpeakerphone, IconMail, IconEye, IconMessageReply, IconCheck,
    IconPlus, IconMailForward, IconLink, IconSearch, IconFilter, IconDots,
    IconCopy, IconTrash, IconPencil, IconAlertCircle, IconSend, IconUsers, IconArrowsSort,
    IconFileImport, IconWand, IconChevronRight,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import StatCard from '../components/StatCard';
import { TierGate } from '../components/FeatureGate';
import { useAuth } from '../contexts/AuthContext';
import CampaignAssignmentTab from '../components/campaigns/CampaignAssignmentTab';
import CampaignImportModal from '../components/campaigns/CampaignImportModal';
import type { CampaignsResponse, PlusVibeCampaign } from '../types/plusvibe';
import type { Campaign } from '../types/campaign';

function pct(val: number): string {
    return `${(val * 100).toFixed(1)}%`;
}

// Liste yüklenirken spinner yerine düzenle benzeyen iskelet — algılanan hızı artırır.
function CampaignListSkeleton({ stats = 0 }: { stats?: number }) {
    return (
        <>
            {stats > 0 && (
                <SimpleGrid cols={{ base: 3, sm: 3 }} mb="lg">
                    {Array.from({ length: stats }).map((_, i) => <Skeleton key={i} height={90} radius="md" />)}
                </SimpleGrid>
            )}
            <Paper radius="md" withBorder p="sm">
                <Stack gap="xs">
                    {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} height={40} radius="sm" />)}
                </Stack>
            </Paper>
        </>
    );
}

// ── PlusVibe tab (mevcut içerik) ───────────────────────────────────────────

function PlusVibeTab() {
    const { t } = useTranslation();
    const { data: campaignsData, isLoading } = useQuery<CampaignsResponse>({
        queryKey: ['plusvibe', 'campaigns', 'all'],
        queryFn: async () => (await api.get('/plusvibe/campaigns')).data,
    });

    const campaigns = campaignsData?.data || [];
    const totalSent = campaigns.reduce((sum, c) => sum + c.emails_sent, 0);
    const totalOpens = campaigns.reduce((sum, c) => sum + c.opens, 0);
    const totalReplies = campaigns.reduce((sum, c) => sum + c.replies, 0);

    if (isLoading) return <CampaignListSkeleton stats={3} />;

    if (campaigns.length === 0) {
        return (
            <Stack align="center" gap="md" py="xl">
                <IconSpeakerphone size={48} style={{ opacity: 0.3 }} />
                <Title order={3} c="dimmed">{t('campaigns.noData')}</Title>
                <Text size="sm" c="dimmed" ta="center" maw={400}>{t('campaigns.noAssignedDesc')}</Text>
            </Stack>
        );
    }

    return (
        <>
            <SimpleGrid cols={{ base: 3, sm: 3 }} mb="lg">
                <StatCard title={t('campaigns.stats.sent')} value={totalSent} icon={<IconMail size={22} />} color="violet" />
                <StatCard title={t('campaigns.stats.opens')} value={totalOpens} icon={<IconEye size={22} />} color="blue" />
                <StatCard title={t('campaigns.stats.replies')} value={totalReplies} icon={<IconMessageReply size={22} />} color="orange" />
            </SimpleGrid>

            <Paper radius="md" withBorder style={{ overflow: 'auto' }}>
                <Table highlightOnHover striped>
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>{t('campaigns.table.name')}</Table.Th>
                            <Table.Th>{t('campaigns.table.status')}</Table.Th>
                            <Table.Th>{t('campaign.list.metrics', 'Metrics')}</Table.Th>
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {campaigns.map((c: PlusVibeCampaign) => (
                            <Table.Tr key={c.id}>
                                <Table.Td><Text size="sm" fw={500}>{c.name}</Text></Table.Td>
                                <Table.Td>
                                    {c.status === 'COMPLETED'
                                        ? <Badge size="sm" variant="light" color="gray" leftSection={<IconCheck size={10} />}>{t('campaigns.filters.completed')}</Badge>
                                        : <Badge size="sm" variant="light" color="green">{t('campaigns.filters.active')}</Badge>
                                    }
                                </Table.Td>
                                <Table.Td>
                                    <Group gap="lg" wrap="nowrap">
                                        <Tooltip label={t('campaigns.table.leads', 'Leads')} withArrow>
                                            <Group gap={4} wrap="nowrap"><IconUsers size={14} color="var(--mantine-color-gray-6)" /><Text size="xs" c="dimmed">{c.total_leads}</Text></Group>
                                        </Tooltip>
                                        <Tooltip label={t('campaigns.table.sent', 'Sent')} withArrow>
                                            <Group gap={4} wrap="nowrap"><IconSend size={14} color="var(--mantine-color-gray-6)" /><Text size="xs" c="dimmed">{c.emails_sent}</Text></Group>
                                        </Tooltip>
                                        <Tooltip label={`${t('campaigns.table.openRate', 'Open rate')} · ${pct(c.open_rate)}`} withArrow>
                                            <Group gap={4} wrap="nowrap"><IconEye size={14} color="var(--mantine-color-blue-5)" /><Text size="xs" c="dimmed">{c.opens}</Text></Group>
                                        </Tooltip>
                                        <Tooltip label={`${t('campaigns.table.replyRate', 'Reply rate')} · ${pct(c.reply_rate)}`} withArrow>
                                            <Group gap={4} wrap="nowrap"><IconMessageReply size={14} color="var(--mantine-color-violet-5)" /><Text size="xs" c="dimmed">{c.replies}</Text></Group>
                                        </Tooltip>
                                    </Group>
                                </Table.Td>
                            </Table.Tr>
                        ))}
                    </Table.Tbody>
                </Table>
            </Paper>
        </>
    );
}

// ── Drip Campaigns tab (yeni) ──────────────────────────────────────────────

function DripTab() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const qc = useQueryClient();
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState<string | null>(null);
    const [sortValue, setSortValue] = useState('created_at:desc');
    const [page, setPage] = useState(1);
    const [deleteTarget, setDeleteTarget] = useState<Campaign | null>(null);
    const [pendingId, setPendingId] = useState<string | null>(null); // toggle yükleme halkası için
    const [newChoice, setNewChoice] = useState(false); // "New Campaign" → yol seçimi modalı
    const [csvWizard, setCsvWizard] = useState(false); // CSV'den kampanya sihirbazı

    const [sortCol, sortDir] = sortValue.split(':');

    const { data, isLoading } = useQuery<{ data: (Campaign & { stats?: { sent: number; opens: number; replies: number }; last_sent_at?: string | null })[]; pagination: { page: number; limit: number; total: number; totalPages: number; hasNext: boolean } }>({
        queryKey: ['campaigns', search, status, sortValue, page],
        queryFn: async () => (await api.get('/campaigns', {
            params: { search: search || undefined, status: status || undefined, sort: sortCol, dir: sortDir, page },
        })).data,
    });

    const campaigns = data?.data || [];
    const totalPages = data?.pagination.totalPages || 1;
    const hasFilters = !!search || !!status;

    const statusLabel = (s: string) => t(`campaign.list.status.${s}`, s.toUpperCase());

    // Kısa tarih (gün + ay) — aktif dile göre.
    const fmtDate = (iso: string | null | undefined) =>
        iso ? new Date(iso).toLocaleDateString(i18n.language, { day: '2-digit', month: 'short' }) : null;

    // Filtre/sıralama değişince ilk sayfaya dön.
    const resetTo = (fn: () => void) => { fn(); setPage(1); };

    const STATUS_OPTIONS = ['draft', 'active', 'paused', 'completed']
        .map((s) => ({ value: s, label: statusLabel(s) }));

    // Kopyala: tam kampanyayı (adımlarıyla) çek, yeni taslak oluştur, adımları kaydet.
    // Mevcut uçlarla yapılır; ayrı "duplicate" API'sine gerek yok.
    const duplicateMut = useMutation({
        mutationFn: async (c: Campaign) => {
            const full = (await api.get(`/campaigns/${c.id}`)).data.data as Campaign;
            const created = (await api.post('/campaigns', {
                name: `${full.name} ${t('campaign.list.copySuffix', '(copy)')}`,
                from_name: full.from_name || undefined,
                settings: full.settings || {},
            })).data.data as Campaign;
            if (full.steps?.length) {
                const steps = full.steps.map((s) => ({
                    step_type: s.step_type, subject: s.subject, body_html: s.body_html,
                    body_text: s.body_text, delay_days: s.delay_days, delay_hours: s.delay_hours,
                }));
                await api.put(`/campaigns/${created.id}/steps`, { steps });
            }
            return created;
        },
        onSuccess: () => {
            showSuccess(t('campaign.list.duplicated', 'Campaign duplicated'));
            qc.invalidateQueries({ queryKey: ['campaigns'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    const deleteMut = useMutation({
        mutationFn: async (id: string) => { await api.delete(`/campaigns/${id}`); },
        onSuccess: () => {
            showSuccess(t('campaign.list.deleted', 'Campaign deleted'));
            setDeleteTarget(null);
            qc.invalidateQueries({ queryKey: ['campaigns'] });
        },
        onError: (err) => { showErrorFromApi(err); setDeleteTarget(null); },
    });

    // Listeden hızlı aksiyon — backend aktive şartlarını (email adımı + bağlı kutu)
    // yine doğrular; eksikse hata bildirimi gösterilir.
    const activateMut = useMutation({
        mutationFn: (id: string) => api.post(`/campaigns/${id}/activate`),
        // refetch bitene kadar pending kalsın → halka, toggle yeni duruma geçince kaybolur
        onSuccess: async () => { showSuccess(t('campaign.activated', 'Campaign activated')); await qc.invalidateQueries({ queryKey: ['campaigns'] }); },
        onError: (err) => showErrorFromApi(err),
        onSettled: () => setPendingId(null),
    });
    const pauseMut = useMutation({
        mutationFn: (id: string) => api.post(`/campaigns/${id}/pause`),
        onSuccess: async () => { showSuccess(t('campaign.paused', 'Campaign paused')); await qc.invalidateQueries({ queryKey: ['campaigns'] }); },
        onError: (err) => showErrorFromApi(err),
        onSettled: () => setPendingId(null),
    });

    return (
        <>
            <Group justify="space-between" mb="md" wrap="wrap" gap="sm">
                <Group gap="sm">
                    <TextInput placeholder={t('campaign.list.search', 'Search campaigns...')}
                        leftSection={<IconSearch size={14} />} radius="md" size="sm" w={240}
                        value={search} onChange={(e) => resetTo(() => setSearch(e.currentTarget.value))} />
                    <Select placeholder={t('campaign.list.filterStatus', 'Status')}
                        data={STATUS_OPTIONS} value={status} onChange={(v) => resetTo(() => setStatus(v))}
                        clearable radius="md" size="sm" w={170}
                        leftSection={<IconFilter size={14} />} />
                    <Select aria-label={t('campaign.list.sortBy', 'Sort')}
                        data={[
                            { value: 'created_at:desc', label: t('campaign.list.sortNewest', 'Newest') },
                            { value: 'created_at:asc', label: t('campaign.list.sortOldest', 'Oldest') },
                            { value: 'name:asc', label: t('campaign.list.sortName', 'Name (A-Z)') },
                            { value: 'status:asc', label: t('campaign.list.sortStatus', 'By status') },
                        ]}
                        value={sortValue} onChange={(v) => resetTo(() => setSortValue(v || 'created_at:desc'))}
                        radius="md" size="sm" w={160}
                        leftSection={<IconArrowsSort size={14} />} />
                </Group>
                <Button size="sm" leftSection={<IconPlus size={16} />}
                    variant="gradient" gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                    radius="md" onClick={() => setNewChoice(true)}
                >
                    {t('campaign.new', 'New Campaign')}
                </Button>
            </Group>

            {isLoading ? (
                <CampaignListSkeleton />
            ) : campaigns.length === 0 ? (
                hasFilters ? (
                    <Stack align="center" gap="xs" py="xl">
                        <Text size="sm" c="dimmed">{t('campaign.list.noResults', 'No matching campaigns.')}</Text>
                        <Button size="xs" variant="subtle" color="gray"
                            onClick={() => resetTo(() => { setSearch(''); setStatus(null); })}>
                            {t('campaign.list.clearFilters', 'Clear filters')}
                        </Button>
                    </Stack>
                ) : (
                    <Stack align="center" gap="md" py="xl">
                        <IconMailForward size={48} style={{ opacity: 0.3 }} />
                        <Title order={3} c="dimmed">{t('campaign.noCampaigns', 'No drip campaigns yet')}</Title>
                        <Text size="sm" c="dimmed" ta="center" maw={400}>
                            {t('campaign.createFirst', 'Create your first campaign to start sending automated email sequences.')}
                        </Text>
                        <Button leftSection={<IconPlus size={16} />}
                            variant="gradient" gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                            radius="md" mt="xs" onClick={() => setNewChoice(true)}
                        >
                            {t('campaign.new', 'New Campaign')}
                        </Button>
                    </Stack>
                )
            ) : (
                <>
                <Paper radius="md" withBorder style={{ overflow: 'auto' }}>
                        <Table highlightOnHover striped>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('campaigns.table.name', 'Name')}</Table.Th>
                                    <Table.Th>{t('campaigns.table.status', 'Status')}</Table.Th>
                                    <Table.Th>{t('campaign.list.metrics', 'Metrics')}</Table.Th>
                                    <Table.Th>{t('campaign.list.colLastSent', 'Last sent')}</Table.Th>
                                    <Table.Th ta="right" w={60} />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {campaigns.map((c) => (
                                    <Table.Tr key={c.id} style={{ cursor: 'pointer' }}
                                        onClick={() => navigate(`/campaigns/drip/${c.id}/edit`)}
                                    >
                                        <Table.Td><Text size="sm" fw={500}>{c.name}</Text></Table.Td>
                                        <Table.Td onClick={(e) => e.stopPropagation()}>
                                            <Tooltip
                                                label={c.status === 'active' ? t('campaign.list.togglePause', 'Click to pause') : t('campaign.list.toggleActivate', 'Click to activate')}
                                                withArrow position="top" disabled={c.status === 'completed'}
                                            >
                                                <Switch
                                                    size="sm" color="green" radius="xl"
                                                    checked={c.status === 'active'}
                                                    disabled={c.status === 'completed' || pendingId === c.id}
                                                    thumbIcon={pendingId === c.id ? <Loader size={10} color="gray" /> : undefined}
                                                    onChange={(e) => {
                                                        setPendingId(c.id);
                                                        (e.currentTarget.checked ? activateMut : pauseMut).mutate(c.id);
                                                    }}
                                                    label={statusLabel(c.status)}
                                                    styles={{ label: {
                                                        fontWeight: 500,
                                                        paddingInlineStart: 8,
                                                        color: c.status === 'active' ? 'var(--mantine-color-green-7)' : 'var(--mantine-color-gray-6)',
                                                    } }}
                                                />
                                            </Tooltip>
                                        </Table.Td>
                                        <Table.Td>
                                            <Group gap="lg" wrap="nowrap">
                                                <Tooltip label={t('campaign.enrolled', 'Enrolled')} withArrow>
                                                    <Group gap={4} wrap="nowrap"><IconUsers size={14} color="var(--mantine-color-gray-6)" /><Text size="xs" c="dimmed">{c.total_enrolled}</Text></Group>
                                                </Tooltip>
                                                <Tooltip label={t('campaign.list.colSent', 'Sent')} withArrow>
                                                    <Group gap={4} wrap="nowrap"><IconSend size={14} color="var(--mantine-color-gray-6)" /><Text size="xs" c="dimmed">{c.stats?.sent ?? 0}</Text></Group>
                                                </Tooltip>
                                                <Tooltip label={t('campaign.list.colOpen', 'Opens')} withArrow>
                                                    <Group gap={4} wrap="nowrap"><IconEye size={14} color="var(--mantine-color-blue-5)" /><Text size="xs" c="dimmed">{c.stats?.opens ?? 0}</Text></Group>
                                                </Tooltip>
                                                <Tooltip label={t('campaign.list.colReply', 'Replies')} withArrow>
                                                    <Group gap={4} wrap="nowrap"><IconMessageReply size={14} color="var(--mantine-color-violet-5)" /><Text size="xs" c="dimmed">{c.stats?.replies ?? 0}</Text></Group>
                                                </Tooltip>
                                            </Group>
                                        </Table.Td>
                                        <Table.Td>
                                            <Tooltip
                                                label={c.last_sent_at
                                                    ? t('campaign.list.createdOn', { date: fmtDate(c.created_at), defaultValue: 'Created: {{date}}' })
                                                    : `${t('campaign.list.neverSent', 'Not sent yet')} · ${t('campaign.list.createdOn', { date: fmtDate(c.created_at), defaultValue: 'Created: {{date}}' })}`}
                                                withArrow>
                                                <Text size="xs" c="dimmed">{c.last_sent_at ? fmtDate(c.last_sent_at) : '—'}</Text>
                                            </Tooltip>
                                        </Table.Td>
                                        <Table.Td ta="right" onClick={(e) => e.stopPropagation()}>
                                            <Menu shadow="md" width={180} position="bottom-end">
                                                <Menu.Target>
                                                    <ActionIcon variant="subtle" color="gray" radius="md">
                                                        <IconDots size={16} />
                                                    </ActionIcon>
                                                </Menu.Target>
                                                <Menu.Dropdown>
                                                    <Menu.Item leftSection={<IconPencil size={14} />}
                                                        onClick={() => navigate(`/campaigns/drip/${c.id}/edit`)}>
                                                        {t('common.edit', 'Edit')}
                                                    </Menu.Item>
                                                    <Menu.Item leftSection={<IconCopy size={14} />}
                                                        onClick={() => duplicateMut.mutate(c)}>
                                                        {t('campaign.list.duplicate', 'Duplicate')}
                                                    </Menu.Item>
                                                    <Menu.Divider />
                                                    <Menu.Item color="red" leftSection={<IconTrash size={14} />}
                                                        disabled={c.status !== 'draft'}
                                                        onClick={() => setDeleteTarget(c)}>
                                                        {t('campaign.list.delete', 'Delete')}
                                                    </Menu.Item>
                                                </Menu.Dropdown>
                                            </Menu>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </Paper>
                {totalPages > 1 && (
                    <Group justify="center" mt="md">
                        <Pagination value={page} onChange={setPage} total={totalPages} radius="md" size="sm" color="violet" />
                    </Group>
                )}
                </>
            )}

            {/* "New Campaign" → yol seçimi: hazır CSV listesi mi, sıfırdan mı */}
            <Modal opened={newChoice} onClose={() => setNewChoice(false)} centered radius="lg" size="md"
                title={t('campaign.new', 'New Campaign')} overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}>
                <Stack gap="sm">
                    <Paper withBorder radius="md" p="md" style={{ cursor: 'pointer' }}
                        onClick={() => { setNewChoice(false); setCsvWizard(true); }}>
                        <Group wrap="nowrap" justify="space-between">
                            <Group wrap="nowrap" gap="sm">
                                <IconFileImport size={26} color="var(--mantine-color-grape-6)" />
                                <div>
                                    <Text size="sm" fw={600}>{t('campaign.newChoice.csvTitle', 'Upload a ready list (CSV)')}</Text>
                                    <Text size="xs" c="dimmed">{t('campaign.newChoice.csvDesc', 'Recipients with per-row messages become a drip campaign in one flow.')}</Text>
                                </div>
                            </Group>
                            <IconChevronRight size={18} color="var(--mantine-color-gray-5)" />
                        </Group>
                    </Paper>
                    <Paper withBorder radius="md" p="md" style={{ cursor: 'pointer' }}
                        onClick={() => { setNewChoice(false); navigate('/campaigns/drip/new'); }}>
                        <Group wrap="nowrap" justify="space-between">
                            <Group wrap="nowrap" gap="sm">
                                <IconWand size={26} color="var(--mantine-color-violet-6)" />
                                <div>
                                    <Text size="sm" fw={600}>{t('campaign.newChoice.scratchTitle', 'Create from scratch')}</Text>
                                    <Text size="xs" c="dimmed">{t('campaign.newChoice.scratchDesc', 'Build the sequence and add recipients from your CRM.')}</Text>
                                </div>
                            </Group>
                            <IconChevronRight size={18} color="var(--mantine-color-gray-5)" />
                        </Group>
                    </Paper>
                </Stack>
            </Modal>

            <CampaignImportModal
                createMode
                opened={csvWizard}
                onClose={() => setCsvWizard(false)}
                onCreated={(id) => navigate(`/campaigns/drip/${id}/edit`)}
            />

            <Modal opened={!!deleteTarget} onClose={() => setDeleteTarget(null)}
                title={t('campaign.list.deleteConfirmTitle', 'Delete campaign')} radius="lg" centered size="sm"
                overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}>
                <Stack gap="md">
                    <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
                        <Text size="sm">{t('campaign.list.deleteConfirm', { name: deleteTarget?.name, defaultValue: 'This will be permanently deleted.' })}</Text>
                    </Alert>
                    <Group justify="flex-end">
                        <Button variant="default" radius="md" onClick={() => setDeleteTarget(null)}>
                            {t('common.cancel', 'Cancel')}
                        </Button>
                        <Button color="red" radius="md" loading={deleteMut.isPending}
                            onClick={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}>
                            {t('campaign.list.delete', 'Delete')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
}

// ── Main ───────────────────────────────────────────────────────────────────

export default function CampaignsPage() {
    const { t } = useTranslation();
    const { user } = useAuth();
    const isSuperadmin = user?.role === 'superadmin';

    return (
        <Container size="xl" py="xl">
            <Group justify="space-between" mb="lg">
                <Title order={2}>{t('campaigns.pageTitle')}</Title>
            </Group>

            <Tabs defaultValue="plusvibe" radius="md">
                <Tabs.List>
                    <Tabs.Tab value="plusvibe" leftSection={<IconSpeakerphone size={14} />}>PlusVibe</Tabs.Tab>
                    <Tabs.Tab value="drip" leftSection={<IconMailForward size={14} />}>Drip</Tabs.Tab>
                    {isSuperadmin && (
                        <Tabs.Tab value="assign" leftSection={<IconLink size={14} />}>
                            {t('campaigns.assignTab', 'Atama')}
                        </Tabs.Tab>
                    )}
                </Tabs.List>

                <Tabs.Panel value="plusvibe" pt="md">
                    <Text size="xs" c="dimmed" mb="sm">{t('campaigns.plusvibeDesc', 'Campaigns run through PlusVibe (view only).')}</Text>
                    <PlusVibeTab />
                </Tabs.Panel>

                <Tabs.Panel value="drip" pt="md">
                    <TierGate feature="drip_campaigns" fallback={
                        <Stack align="center" gap="md" py="xl">
                            <Text size="sm" c="dimmed">{t('campaign.proRequired', 'Drip campaigns require Pro tier.')}</Text>
                        </Stack>
                    }>
                        <>
                            <Text size="xs" c="dimmed" mb="sm">{t('campaigns.dripDesc', 'Automated email sequences you build inside the app.')}</Text>
                            <DripTab />
                        </>
                    </TierGate>
                </Tabs.Panel>

                {isSuperadmin && (
                    <Tabs.Panel value="assign" pt="md">
                        <CampaignAssignmentTab />
                    </Tabs.Panel>
                )}
            </Tabs>
        </Container>
    );
}
