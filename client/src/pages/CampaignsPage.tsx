import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
    Container, Title, Group, Stack, Paper, Text, Badge, Table, Tabs,
    Loader, Center, SimpleGrid, Button, TextInput, Select, Menu, ActionIcon, Modal, Alert,
} from '@mantine/core';
import {
    IconSpeakerphone, IconMail, IconEye, IconMessageReply, IconCheck,
    IconPlus, IconMailForward, IconLink, IconSearch, IconFilter, IconDots,
    IconCopy, IconTrash, IconPencil, IconAlertCircle,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import StatCard from '../components/StatCard';
import { TierGate } from '../components/FeatureGate';
import { useAuth } from '../contexts/AuthContext';
import CampaignAssignmentTab from '../components/campaigns/CampaignAssignmentTab';
import type { CampaignsResponse, PlusVibeCampaign } from '../types/plusvibe';
import type { Campaign } from '../types/campaign';

function pct(val: number): string {
    return `${(val * 100).toFixed(1)}%`;
}

const STATUS_COLORS: Record<string, string> = {
    draft: 'gray', active: 'green', paused: 'yellow', completed: 'blue',
};

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

    if (isLoading) return <Center py="xl"><Loader size="sm" color="violet" /></Center>;

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
                            <Table.Th ta="right">{t('campaigns.table.leads')}</Table.Th>
                            <Table.Th ta="right">{t('campaigns.table.sent')}</Table.Th>
                            <Table.Th ta="right">{t('campaigns.table.openRate')}</Table.Th>
                            <Table.Th ta="right">{t('campaigns.table.replyRate')}</Table.Th>
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
                                <Table.Td ta="right"><Text size="sm">{c.total_leads}</Text></Table.Td>
                                <Table.Td ta="right"><Text size="sm">{c.emails_sent}</Text></Table.Td>
                                <Table.Td ta="right"><Text size="sm" c="blue">{pct(c.open_rate)}</Text></Table.Td>
                                <Table.Td ta="right"><Text size="sm" c="orange">{pct(c.reply_rate)}</Text></Table.Td>
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
    const { t } = useTranslation();
    const navigate = useNavigate();
    const qc = useQueryClient();
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState<string | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<Campaign | null>(null);

    const { data, isLoading } = useQuery<{ data: Campaign[]; pagination: { page: number; limit: number; total: number; totalPages: number; hasNext: boolean } }>({
        queryKey: ['campaigns', search, status],
        queryFn: async () => (await api.get('/campaigns', {
            params: { search: search || undefined, status: status || undefined },
        })).data,
    });

    const campaigns = data?.data || [];
    const hasFilters = !!search || !!status;

    const statusLabel = (s: string) => t(`campaign.list.status.${s}`, s.toUpperCase());

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

    return (
        <>
            <Group justify="space-between" mb="md" wrap="wrap" gap="sm">
                <Group gap="sm">
                    <TextInput placeholder={t('campaign.list.search', 'Search campaigns...')}
                        leftSection={<IconSearch size={14} />} radius="md" size="sm" w={240}
                        value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
                    <Select placeholder={t('campaign.list.filterStatus', 'Status')}
                        data={STATUS_OPTIONS} value={status} onChange={setStatus}
                        clearable radius="md" size="sm" w={170}
                        leftSection={<IconFilter size={14} />} />
                </Group>
                <Button size="sm" leftSection={<IconPlus size={16} />}
                    variant="gradient" gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                    radius="md" onClick={() => navigate('/campaigns/drip/new')}
                >
                    {t('campaign.new', 'New Campaign')}
                </Button>
            </Group>

            {isLoading ? (
                <Center py="xl"><Loader size="sm" color="violet" /></Center>
            ) : campaigns.length === 0 ? (
                hasFilters ? (
                    <Text size="sm" c="dimmed" ta="center" py="xl">{t('campaign.list.noResults', 'No matching campaigns.')}</Text>
                ) : (
                    <Stack align="center" gap="md" py="xl">
                        <IconMailForward size={48} style={{ opacity: 0.3 }} />
                        <Title order={3} c="dimmed">{t('campaign.noCampaigns', 'No drip campaigns yet')}</Title>
                        <Text size="sm" c="dimmed" ta="center" maw={400}>
                            {t('campaign.createFirst', 'Create your first campaign to start sending automated email sequences.')}
                        </Text>
                    </Stack>
                )
            ) : (
                <>
                    <Text size="xs" c="dimmed" mb="xs">{t('campaign.list.metricsSoon', 'Open and reply metrics will be added in the next step.')}</Text>
                    <Paper radius="md" withBorder style={{ overflow: 'auto' }}>
                        <Table highlightOnHover striped>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('campaigns.table.name', 'Name')}</Table.Th>
                                    <Table.Th>{t('campaigns.table.status', 'Status')}</Table.Th>
                                    <Table.Th ta="right">{t('campaign.enrolled', 'Enrolled')}</Table.Th>
                                    <Table.Th ta="right">{t('campaign.list.colSent', 'Sent')}</Table.Th>
                                    <Table.Th ta="right">{t('campaign.list.colOpen', 'Opens')}</Table.Th>
                                    <Table.Th ta="right">{t('campaign.list.colReply', 'Replies')}</Table.Th>
                                    <Table.Th ta="right" w={60} />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {campaigns.map((c) => (
                                    <Table.Tr key={c.id} style={{ cursor: 'pointer' }}
                                        onClick={() => navigate(`/campaigns/drip/${c.id}/edit`)}
                                    >
                                        <Table.Td><Text size="sm" fw={500}>{c.name}</Text></Table.Td>
                                        <Table.Td>
                                            <Badge size="sm" variant="light" color={STATUS_COLORS[c.status]}>
                                                {statusLabel(c.status)}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td ta="right"><Text size="sm">{c.total_enrolled}</Text></Table.Td>
                                        <Table.Td ta="right"><Text size="sm" c="dimmed">—</Text></Table.Td>
                                        <Table.Td ta="right"><Text size="sm" c="dimmed">—</Text></Table.Td>
                                        <Table.Td ta="right"><Text size="sm" c="dimmed">—</Text></Table.Td>
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
                </>
            )}

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
                    <PlusVibeTab />
                </Tabs.Panel>

                <Tabs.Panel value="drip" pt="md">
                    <TierGate feature="drip_campaigns" fallback={
                        <Stack align="center" gap="md" py="xl">
                            <Text size="sm" c="dimmed">{t('campaign.proRequired', 'Drip campaigns require Pro tier.')}</Text>
                        </Stack>
                    }>
                        <DripTab />
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
