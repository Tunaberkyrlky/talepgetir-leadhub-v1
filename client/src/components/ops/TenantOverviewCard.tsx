import { Paper, Group, Text, Badge, SimpleGrid, Stack, Tooltip, Box } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { formatListDate } from '../../lib/formatDate';

export interface OpsTenantOverview {
    id: string;
    name: string;
    slug: string;
    tier: string | null;
    companies: number;
    contacts: number;
    activeCampaigns: number;
    totalCampaigns: number;
    unreadInbound: number;
    lastActivityAt: string | null;
    mailboxes: {
        total: number;
        active: number;
        stale: number;
        lastPolledAt: string | null;
    };
}

function mailboxColor(m: OpsTenantOverview['mailboxes']): string {
    if (m.total === 0) return 'gray';
    if (m.stale > 0) return 'red';
    if (m.active < m.total) return 'yellow';
    return 'green';
}

export default function TenantOverviewCard({ tenant }: { tenant: OpsTenantOverview }) {
    const { t, i18n } = useTranslation();
    const m = tenant.mailboxes;

    const stats: { label: string; value: number }[] = [
        { label: t('ops.overview.companies'), value: tenant.companies },
        { label: t('ops.overview.contacts'), value: tenant.contacts },
        { label: t('ops.overview.activeCampaigns'), value: tenant.activeCampaigns },
        { label: t('ops.overview.totalCampaigns'), value: tenant.totalCampaigns },
    ];

    const mailboxLabel =
        `${t('ops.overview.mailboxes')}: ${m.active}/${m.total}` +
        (m.stale > 0 ? ` (${m.stale} ${t('ops.overview.mailboxStale')})` : '');

    return (
        <Paper shadow="sm" radius="lg" p="md" withBorder h="100%">
            <Stack gap="sm">
                <Group justify="space-between" wrap="nowrap">
                    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                        <Tooltip label={mailboxLabel} withArrow>
                            <Box
                                w={10}
                                h={10}
                                style={{
                                    borderRadius: '50%',
                                    flexShrink: 0,
                                    backgroundColor: `var(--mantine-color-${mailboxColor(m)}-6)`,
                                }}
                            />
                        </Tooltip>
                        <Text fw={700} truncate>
                            {tenant.name}
                        </Text>
                    </Group>
                    <Group gap={6} wrap="nowrap">
                        {tenant.unreadInbound > 0 && (
                            <Tooltip label={t('ops.overview.unreadInbound')} withArrow>
                                <Badge color="blue" variant="filled" radius="sm">
                                    {tenant.unreadInbound}
                                </Badge>
                            </Tooltip>
                        )}
                        {tenant.tier && (
                            <Badge
                                color={tenant.tier === 'pro' ? 'violet' : 'gray'}
                                variant="light"
                                radius="sm"
                            >
                                {tenant.tier}
                            </Badge>
                        )}
                    </Group>
                </Group>

                <SimpleGrid cols={2} spacing="xs">
                    {stats.map((s) => (
                        <Group key={s.label} gap={6} wrap="nowrap" justify="space-between">
                            <Text size="xs" c="dimmed" truncate>
                                {s.label}
                            </Text>
                            <Text size="sm" fw={600}>
                                {s.value}
                            </Text>
                        </Group>
                    ))}
                </SimpleGrid>

                <Text size="xs" c="dimmed">
                    {t('ops.overview.lastActivity')}:{' '}
                    {tenant.lastActivityAt
                        ? formatListDate(tenant.lastActivityAt, i18n.language)
                        : t('ops.overview.noActivity')}
                </Text>
            </Stack>
        </Paper>
    );
}
