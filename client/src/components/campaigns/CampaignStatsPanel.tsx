import { useQuery } from '@tanstack/react-query';
import { SimpleGrid, Paper, Text, Loader, Center, Progress, Stack, Alert, Group } from '@mantine/core';
import { IconSend, IconEye, IconClick, IconMessageReply, IconEyeOff, IconInbox } from '@tabler/icons-react';
import {
    AreaChart, Area, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { useTranslation } from 'react-i18next';
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
    const { t } = useTranslation();
    const { data: stats, isLoading } = useQuery<CampaignStats>({
        queryKey: ['campaign-stats', campaignId],
        queryFn: async () => { const r = await api.get(`/campaigns/${campaignId}/stats`); return r.data; },
        refetchInterval: 30_000,
    });

    if (isLoading) return <Center py="md"><Loader size="sm" color="violet" /></Center>;
    if (!stats) return null;

    const total = stats.total_enrolled || 1; // 0'a bölme koruması
    const seg = (n: number) => (n / total) * 100;
    // Dayanıklılık: eski/kısmi API yanıtında bu alanlar olmayabilir.
    const byAccount = stats.by_account ?? [];
    const daily = stats.daily ?? [];
    const maxAccount = Math.max(1, ...byAccount.map((a) => a.sent));

    return (
        <Stack gap="md">
            {!stats.tracking_enabled && (
                <Alert icon={<IconEyeOff size={16} />} color="yellow" variant="light" radius="md" p="xs">
                    <Text size="xs">
                        {t('campaign.stats.trackingOff', 'Open and click tracking is not configured, so these counts may stay at zero. Replies are still tracked.')}
                    </Text>
                </Alert>
            )}
            <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
                <StatCard title={t('campaign.stats.sent', 'Sent')} value={stats.emails_sent} icon={<IconSend size={20} />} color="blue" subtitle={t('campaign.stats.activeSub', { count: stats.active, defaultValue: '{{count}} active' })} />
                <StatCard title={t('campaign.stats.opens', 'Opens')} value={stats.opens} icon={<IconEye size={20} />} color="green" subtitle={fmt(stats.open_rate)} />
                <StatCard title={t('campaign.stats.clicks', 'Clicks')} value={stats.clicks} icon={<IconClick size={20} />} color="orange" subtitle={fmt(stats.click_rate)} />
                <StatCard title={t('campaign.stats.replies', 'Replies')} value={stats.replies} icon={<IconMessageReply size={20} />} color="violet" subtitle={fmt(stats.reply_rate)} />
            </SimpleGrid>

            <Paper p="sm" radius="md" withBorder>
                <Text size="xs" fw={600} mb="xs" c="dimmed">{t('campaign.stats.enrollTitle', { count: stats.total_enrolled, defaultValue: 'Enrollment Status ({{count}} total)' })}</Text>
                <Progress.Root size="lg" radius="md">
                    {stats.completed > 0 && <Progress.Section value={seg(stats.completed)} color="green"><Progress.Label>{t('campaign.stats.segDone', { count: stats.completed, defaultValue: '{{count}} done' })}</Progress.Label></Progress.Section>}
                    {stats.active > 0 && <Progress.Section value={seg(stats.active)} color="blue"><Progress.Label>{t('campaign.stats.segActive', { count: stats.active, defaultValue: '{{count}} active' })}</Progress.Label></Progress.Section>}
                    {stats.replied > 0 && <Progress.Section value={seg(stats.replied)} color="violet"><Progress.Label>{t('campaign.stats.segReplied', { count: stats.replied, defaultValue: '{{count}} replied' })}</Progress.Label></Progress.Section>}
                    {stats.paused > 0 && <Progress.Section value={seg(stats.paused)} color="gray"><Progress.Label>{t('campaign.stats.segPaused', { count: stats.paused, defaultValue: '{{count}} paused' })}</Progress.Label></Progress.Section>}
                    {stats.bounced > 0 && <Progress.Section value={seg(stats.bounced)} color="red"><Progress.Label>{t('campaign.stats.segBounced', { count: stats.bounced, defaultValue: '{{count}} bounced' })}</Progress.Label></Progress.Section>}
                    {stats.unsubscribed > 0 && <Progress.Section value={seg(stats.unsubscribed)} color="dark"><Progress.Label>{t('campaign.stats.segUnsub', { count: stats.unsubscribed, defaultValue: '{{count}} unsubscribed' })}</Progress.Label></Progress.Section>}
                </Progress.Root>
            </Paper>

            {daily.length >= 2 && (
                <Paper p="sm" radius="md" withBorder>
                    <Text size="xs" fw={600} mb="xs" c="dimmed">{t('campaign.stats.overTime', 'Activity over time')}</Text>
                    <ResponsiveContainer width="100%" height={160}>
                        <AreaChart data={daily} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
                            <defs>
                                <linearGradient id="cs-sent" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#339af0" stopOpacity={0.35} />
                                    <stop offset="95%" stopColor="#339af0" stopOpacity={0} />
                                </linearGradient>
                                <linearGradient id="cs-opens" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#51cf66" stopOpacity={0.35} />
                                    <stop offset="95%" stopColor="#51cf66" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--mantine-color-gray-2)" />
                            <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} fontSize={10} tickLine={false} axisLine={false} />
                            <YAxis allowDecimals={false} fontSize={10} tickLine={false} axisLine={false} width={28} />
                            <RTooltip />
                            <Area type="monotone" dataKey="sent" stroke="#339af0" strokeWidth={2} fill="url(#cs-sent)" name={t('campaign.stats.sent', 'Sent')} />
                            <Area type="monotone" dataKey="opens" stroke="#51cf66" strokeWidth={2} fill="url(#cs-opens)" name={t('campaign.stats.opens', 'Opens')} />
                        </AreaChart>
                    </ResponsiveContainer>
                </Paper>
            )}

            {byAccount.length > 0 && stats.emails_sent > 0 && (
                <Paper p="sm" radius="md" withBorder>
                    <Group gap="xs" mb="xs">
                        <IconInbox size={14} color="var(--mantine-color-indigo-6)" />
                        <Text size="xs" fw={600} c="dimmed">{t('campaign.stats.byInbox', 'Sent per inbox')}</Text>
                    </Group>
                    <Stack gap={8}>
                        {byAccount.map((a) => (
                            <div key={a.account}>
                                <Group justify="space-between" gap="xs" wrap="nowrap">
                                    <Text size="xs" lineClamp={1}>{a.account}</Text>
                                    <Text size="xs" c="dimmed">{a.sent}</Text>
                                </Group>
                                <Progress value={(a.sent / maxAccount) * 100} size="xs" radius="xl" color="indigo" mt={2} />
                            </div>
                        ))}
                    </Stack>
                </Paper>
            )}
        </Stack>
    );
}
