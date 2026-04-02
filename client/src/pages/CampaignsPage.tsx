import { useQuery } from '@tanstack/react-query';
import {
    Container, Title, Group, Stack, Paper, Text, Badge, Table,
    Loader, Center, SimpleGrid,
} from '@mantine/core';
import {
    IconSpeakerphone, IconMail, IconEye, IconMessageReply,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import StatCard from '../components/StatCard';
import type { CampaignsResponse, PlusVibeCampaign } from '../types/plusvibe';

function pct(val: number): string {
    return `${(val * 100).toFixed(1)}%`;
}

export default function CampaignsPage() {
    const { t } = useTranslation();

    // Only fetch ACTIVE campaigns assigned to this tenant
    const { data: campaignsData, isLoading } = useQuery<CampaignsResponse>({
        queryKey: ['plusvibe', 'campaigns', 'active'],
        queryFn: async () => (await api.get('/plusvibe/campaigns', { params: { status: 'ACTIVE' } })).data,
    });

    const campaigns = campaignsData?.data || [];

    const totalSent = campaigns.reduce((sum, c) => sum + c.emails_sent, 0);
    const totalOpens = campaigns.reduce((sum, c) => sum + c.opens, 0);
    const totalReplies = campaigns.reduce((sum, c) => sum + c.replies, 0);

    if (isLoading && campaigns.length === 0) {
        return <Center py="xl"><Loader size="md" color="violet" /></Center>;
    }

    if (!isLoading && campaigns.length === 0) {
        return (
            <Container size="xl" py="xl">
                <Stack align="center" gap="md" py="xl">
                    <IconSpeakerphone size={48} style={{ opacity: 0.3 }} />
                    <Title order={3} c="dimmed">{t('campaigns.noData')}</Title>
                    <Text size="sm" c="dimmed" ta="center" maw={400}>
                        {t('campaigns.noAssignedDesc')}
                    </Text>
                </Stack>
            </Container>
        );
    }

    return (
        <Container size="xl" py="xl">
            <Group justify="space-between" mb="lg">
                <Group gap="xs">
                    <Title order={2}>{t('campaigns.pageTitle')}</Title>
                    <Badge size="lg" variant="light" color="violet" circle>
                        {campaigns.length}
                    </Badge>
                </Group>
            </Group>

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
                                <Table.Td ta="right"><Text size="sm">{c.total_leads}</Text></Table.Td>
                                <Table.Td ta="right"><Text size="sm">{c.emails_sent}</Text></Table.Td>
                                <Table.Td ta="right"><Text size="sm" c="blue">{pct(c.open_rate)}</Text></Table.Td>
                                <Table.Td ta="right"><Text size="sm" c="orange">{pct(c.reply_rate)}</Text></Table.Td>
                            </Table.Tr>
                        ))}
                    </Table.Tbody>
                </Table>
            </Paper>
        </Container>
    );
}
