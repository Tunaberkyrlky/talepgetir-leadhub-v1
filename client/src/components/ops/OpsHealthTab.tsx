import { SimpleGrid, Center, Loader, Alert, Table, Badge, Text, Title, Stack, Paper, Group } from '@mantine/core';
import { IconServer, IconDatabase, IconTag, IconClock } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import StatCard from '../StatCard';
import { formatListDate } from '../../lib/formatDate';

// superadmin rows carry lastError (full detail); ops_agent rows carry only ok
interface SchedulerBeat {
    lastTickAt: string;
    lastOkAt: string | null;
    ok?: boolean;
    lastError?: string | null;
}

interface StaleMailbox {
    tenantId: string;
    tenantName: string | null;
    emailAddress: string;
    provider: string | null;
    lastPolledAt: string | null;
}

interface OpsHealthResponse {
    status: string;
    database: string;
    version: string;
    startedAt: string;
    uptimeSec: number;
    schedulers: Record<string, SchedulerBeat>;
    mailboxes: { total: number; active: number; stale: StaleMailbox[] };
    timestamp: string;
}

function formatUptime(sec: number): string {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function beatOk(b: SchedulerBeat): boolean {
    return typeof b.ok === 'boolean' ? b.ok : b.lastError == null;
}

export default function OpsHealthTab() {
    const { t, i18n } = useTranslation();
    const { data, isLoading, error } = useQuery<OpsHealthResponse>({
        queryKey: ['ops', 'health'],
        queryFn: async () => (await api.get('/ops/health')).data,
        refetchInterval: 30_000,
    });

    if (isLoading) {
        return (
            <Center py="xl">
                <Loader />
            </Center>
        );
    }
    if (error || !data) {
        return (
            <Alert color="red" mt="md">
                {t('ops.loadError')}
            </Alert>
        );
    }

    const healthy = data.status === 'ok';
    const dbConnected = data.database === 'connected';
    const schedulerEntries = Object.entries(data.schedulers);
    const showErrorColumn = schedulerEntries.some(([, b]) => b.lastError != null);
    const locale = i18n.language;

    return (
        <Stack gap="lg" mt="md">
            <SimpleGrid cols={{ base: 2, md: 4 }}>
                <StatCard
                    title={t('ops.health.status')}
                    value={healthy ? t('ops.health.statusOk') : t('ops.health.statusDegraded')}
                    icon={<IconServer size={22} />}
                    color={healthy ? 'green' : 'red'}
                    compact
                />
                <StatCard
                    title={t('ops.health.database')}
                    value={dbConnected ? t('ops.health.dbConnected') : t('ops.health.dbUnreachable')}
                    icon={<IconDatabase size={22} />}
                    color={dbConnected ? 'green' : 'red'}
                    compact
                />
                <StatCard
                    title={t('ops.health.version')}
                    value={data.version}
                    icon={<IconTag size={22} />}
                    color="violet"
                    compact
                />
                <StatCard
                    title={t('ops.health.uptime')}
                    value={formatUptime(data.uptimeSec)}
                    icon={<IconClock size={22} />}
                    color="blue"
                    compact
                    description={formatListDate(data.startedAt, locale)}
                />
            </SimpleGrid>

            <div>
                <Title order={4} mb="xs">
                    {t('ops.health.schedulers')}
                </Title>
                <Paper withBorder radius="md" p={0} style={{ overflowX: 'auto' }}>
                    <Table striped highlightOnHover>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>{t('ops.health.scheduler')}</Table.Th>
                                <Table.Th>{t('ops.health.lastTick')}</Table.Th>
                                <Table.Th>{t('ops.health.lastOk')}</Table.Th>
                                <Table.Th>{t('ops.health.status')}</Table.Th>
                                {showErrorColumn && <Table.Th>{t('ops.health.lastError')}</Table.Th>}
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {schedulerEntries.map(([name, beat]) => (
                                <Table.Tr key={name}>
                                    <Table.Td fw={600}>{name}</Table.Td>
                                    <Table.Td>{formatListDate(beat.lastTickAt, locale)}</Table.Td>
                                    <Table.Td>
                                        {beat.lastOkAt ? formatListDate(beat.lastOkAt, locale) : '—'}
                                    </Table.Td>
                                    <Table.Td>
                                        <Badge color={beatOk(beat) ? 'green' : 'red'} variant="light">
                                            {beatOk(beat) ? t('ops.health.ok') : t('ops.health.failing')}
                                        </Badge>
                                    </Table.Td>
                                    {showErrorColumn && (
                                        <Table.Td>
                                            <Text size="xs" c="red" style={{ wordBreak: 'break-word' }}>
                                                {beat.lastError ?? ''}
                                            </Text>
                                        </Table.Td>
                                    )}
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                </Paper>
            </div>

            <div>
                <Group justify="space-between" mb="xs">
                    <Title order={4}>{t('ops.health.staleMailboxes')}</Title>
                    <Text size="sm" c="dimmed">
                        {t('ops.health.total')}: {data.mailboxes.total} · {t('ops.health.active')}:{' '}
                        {data.mailboxes.active}
                    </Text>
                </Group>
                {data.mailboxes.stale.length === 0 ? (
                    <Text size="sm" c="green">
                        {t('ops.health.noStale')}
                    </Text>
                ) : (
                    <Paper withBorder radius="md" p={0} style={{ overflowX: 'auto' }}>
                        <Table striped>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('tenant.tenant', 'Tenant')}</Table.Th>
                                    <Table.Th>Email</Table.Th>
                                    <Table.Th>Provider</Table.Th>
                                    <Table.Th>{t('ops.health.lastPolled')}</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {data.mailboxes.stale.map((mb) => (
                                    <Table.Tr key={`${mb.tenantId}-${mb.emailAddress}`}>
                                        <Table.Td>{mb.tenantName ?? mb.tenantId}</Table.Td>
                                        <Table.Td>{mb.emailAddress}</Table.Td>
                                        <Table.Td>{mb.provider ?? '—'}</Table.Td>
                                        <Table.Td>
                                            {mb.lastPolledAt
                                                ? formatListDate(mb.lastPolledAt, locale)
                                                : '—'}
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </Paper>
                )}
            </div>
        </Stack>
    );
}
