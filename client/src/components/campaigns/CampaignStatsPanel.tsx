import { useQuery } from '@tanstack/react-query';
import { SimpleGrid, Paper, Text, Loader, Center, Progress, Stack } from '@mantine/core';
import { IconSend, IconEye, IconClick, IconMessageReply } from '@tabler/icons-react';
import api from '../../lib/api';
import type { CampaignStats } from '../../types/campaign';

function StatCard({ title, value, icon, color, subtitle }: {
    title: string; value: number; icon: React.ReactNode; color: string; subtitle: string;
}) {
    return (
        <Paper shadow="xs" radius="md" p="md" withBorder ta="center">
            <div style={{
                width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center',
                justifyContent: 'center', margin: '0 auto 8px',
                background: `var(--mantine-color-${color}-0)`, color: `var(--mantine-color-${color}-6)`,
            }}>{icon}</div>
            <Text size="xl" fw={800} c={`${color}.6`}>{value}</Text>
            <Text size="xs" c="dimmed" fw={600}>{title}</Text>
            <Text size="xs" c="dimmed" mt={2}>{subtitle}</Text>
        </Paper>
    );
}

const fmt = (r: number) => `${(r * 100).toFixed(1)}%`;

export default function CampaignStatsPanel({ campaignId }: { campaignId: string }) {
    const { data: stats, isLoading } = useQuery<CampaignStats>({
        queryKey: ['campaign-stats', campaignId],
        queryFn: async () => { const r = await api.get(`/campaigns/${campaignId}/stats`); return r.data; },
        refetchInterval: 30_000,
    });

    if (isLoading) return <Center py="md"><Loader size="sm" color="violet" /></Center>;
    if (!stats) return null;

    // total available: stats.emails_sent + (stats.total_enrolled - stats.completed - stats.replied)

    return (
        <Stack gap="md">
            <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
                <StatCard title="Sent" value={stats.emails_sent} icon={<IconSend size={20} />} color="blue" subtitle={`${stats.active} active`} />
                <StatCard title="Opens" value={stats.opens} icon={<IconEye size={20} />} color="green" subtitle={fmt(stats.open_rate)} />
                <StatCard title="Clicks" value={stats.clicks} icon={<IconClick size={20} />} color="orange" subtitle={fmt(stats.click_rate)} />
                <StatCard title="Replies" value={stats.replies} icon={<IconMessageReply size={20} />} color="violet" subtitle={fmt(stats.reply_rate)} />
            </SimpleGrid>

            <Paper p="sm" radius="md" withBorder>
                <Text size="xs" fw={600} mb="xs" c="dimmed">Enrollment Status ({stats.total_enrolled} total)</Text>
                <Progress.Root size="lg" radius="md">
                    {stats.completed > 0 && <Progress.Section value={(stats.completed / stats.total_enrolled) * 100} color="green"><Progress.Label>{stats.completed} done</Progress.Label></Progress.Section>}
                    {stats.active > 0 && <Progress.Section value={(stats.active / stats.total_enrolled) * 100} color="blue"><Progress.Label>{stats.active} active</Progress.Label></Progress.Section>}
                    {stats.replied > 0 && <Progress.Section value={(stats.replied / stats.total_enrolled) * 100} color="violet"><Progress.Label>{stats.replied} replied</Progress.Label></Progress.Section>}
                    {stats.paused > 0 && <Progress.Section value={(stats.paused / stats.total_enrolled) * 100} color="gray"><Progress.Label>{stats.paused} paused</Progress.Label></Progress.Section>}
                </Progress.Root>
            </Paper>
        </Stack>
    );
}
