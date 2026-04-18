import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
    Container, Title, Group, Stack, Paper, Text, Badge, Table, Tabs,
    Loader, Center, SimpleGrid, Button,
} from '@mantine/core';
import {
    IconSpeakerphone, IconMail, IconEye, IconMessageReply, IconCheck,
    IconPlus, IconMailForward,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import StatCard from '../components/StatCard';
import { TierGate } from '../components/FeatureGate';
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

    const { data, isLoading } = useQuery<{ data: Campaign[]; pagination: { page: number; limit: number; total: number; totalPages: number; hasNext: boolean } }>({
        queryKey: ['campaigns'],
        queryFn: async () => (await api.get('/campaigns')).data,
    });

    const campaigns = data?.data || [];

    if (isLoading) return <Center py="xl"><Loader size="sm" color="violet" /></Center>;
    if (!data && !isLoading) return <Center py="xl"><Text c="red" size="sm">{t('common.error', 'Failed to load data')}</Text></Center>;

    return (
        <>
            <Group justify="flex-end" mb="md">
                <Button size="sm" leftSection={<IconPlus size={16} />}
                    variant="gradient" gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                    radius="md" onClick={() => navigate('/campaigns/drip/new')}
                >
                    {t('campaign.new', 'New Campaign')}
                </Button>
            </Group>

            {campaigns.length === 0 ? (
                <Stack align="center" gap="md" py="xl">
                    <IconMailForward size={48} style={{ opacity: 0.3 }} />
                    <Title order={3} c="dimmed">{t('campaign.noCampaigns', 'No drip campaigns yet')}</Title>
                    <Text size="sm" c="dimmed" ta="center" maw={400}>
                        {t('campaign.createFirst', 'Create your first campaign to start sending automated email sequences.')}
                    </Text>
                </Stack>
            ) : (
                <Paper radius="md" withBorder style={{ overflow: 'auto' }}>
                    <Table highlightOnHover striped>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>{t('campaigns.table.name', 'Name')}</Table.Th>
                                <Table.Th>{t('campaigns.table.status', 'Status')}</Table.Th>
                                <Table.Th ta="right">{t('campaign.enrolled', 'Enrolled')}</Table.Th>
                                <Table.Th ta="right">{t('common.actions', 'Actions')}</Table.Th>
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
                                            {c.status.toUpperCase()}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td ta="right"><Text size="sm">{c.total_enrolled}</Text></Table.Td>
                                    <Table.Td ta="right">
                                        <Button size="xs" variant="light" color="violet" radius="md"
                                            onClick={(e) => { e.stopPropagation(); navigate(`/campaigns/drip/${c.id}/edit`); }}
                                        >{t('common.edit', 'Edit')}</Button>
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                </Paper>
            )}
        </>
    );
}

// ── Main ───────────────────────────────────────────────────────────────────

export default function CampaignsPage() {
    const { t } = useTranslation();

    return (
        <Container size="xl" py="xl">
            <Group justify="space-between" mb="lg">
                <Title order={2}>{t('campaigns.pageTitle')}</Title>
            </Group>

            <Tabs defaultValue="plusvibe" radius="md">
                <Tabs.List>
                    <Tabs.Tab value="plusvibe" leftSection={<IconSpeakerphone size={14} />}>PlusVibe</Tabs.Tab>
                    <Tabs.Tab value="drip" leftSection={<IconMailForward size={14} />}>Drip</Tabs.Tab>
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
            </Tabs>
        </Container>
    );
}
