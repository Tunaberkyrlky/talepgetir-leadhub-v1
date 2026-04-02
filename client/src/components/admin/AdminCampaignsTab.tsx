import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Stack, Group, Text, Badge, Table, Select, Button, Alert,
    Loader, Center, UnstyledButton, TextInput,
} from '@mantine/core';
import { IconRefresh, IconAlertCircle, IconArrowUp, IconArrowDown, IconArrowsSort, IconSearch } from '@tabler/icons-react';
import { useDebouncedValue } from '@mantine/hooks';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';
import { useAuth } from '../../contexts/AuthContext';
import type { CampaignsResponse, PlusVibeCampaign, PlusVibeStatus } from '../../types/plusvibe';

function statusColor(status: string | null): string {
    switch (status?.toUpperCase()) {
        case 'ACTIVE': return 'green';
        case 'PAUSED': return 'yellow';
        case 'DRAFT': return 'gray';
        case 'COMPLETED': return 'blue';
        default: return 'gray';
    }
}

// Status sort priority: ACTIVE first, then PAUSED, COMPLETED, DRAFT
const STATUS_ORDER: Record<string, number> = { ACTIVE: 0, PAUSED: 1, COMPLETED: 2, DRAFT: 3 };

type SortField = 'name' | 'status' | 'emails_sent' | 'replies';
type SortDir = 'asc' | 'desc';

export default function AdminCampaignsTab() {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const { accessibleTenants } = useAuth();

    const [sortField, setSortField] = useState<SortField>('status');
    const [sortDir, setSortDir] = useState<SortDir>('asc');
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 200);

    const { data: pvStatus } = useQuery<PlusVibeStatus>({
        queryKey: ['plusvibe', 'status'],
        queryFn: async () => (await api.get('/plusvibe/status')).data,
    });

    const { data: campaignsData, isLoading } = useQuery<CampaignsResponse>({
        queryKey: ['plusvibe', 'admin-campaigns'],
        queryFn: async () => (await api.get('/plusvibe/campaigns', { params: { admin: 'true' } })).data,
        enabled: !!pvStatus?.configured,
    });

    const syncMutation = useMutation({
        mutationFn: async () => (await api.post('/plusvibe/sync')).data,
        onSuccess: () => {
            showSuccess(t('campaigns.synced'));
            queryClient.invalidateQueries({ queryKey: ['plusvibe'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    const assignMutation = useMutation({
        mutationFn: async ({ id, tenantId }: { id: string; tenantId: string | null }) => {
            if (tenantId) {
                return (await api.patch(`/plusvibe/campaigns/${id}/assign`, { tenant_id: tenantId })).data;
            } else {
                return (await api.patch(`/plusvibe/campaigns/${id}/unassign`)).data;
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['plusvibe'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    const campaigns = useMemo(() => campaignsData?.data || [], [campaignsData]);

    const tenantSelectData = useMemo(() => (accessibleTenants || []).map((t) => ({
        value: t.id,
        label: t.name,
    })), [accessibleTenants]);

    // Filter + sort campaigns
    const sorted = useMemo(() => {
        const q = debouncedSearch.toLowerCase();
        const copy = q ? campaigns.filter((c) => c.name.toLowerCase().includes(q)) : [...campaigns];
        copy.sort((a, b) => {
            let cmp = 0;
            switch (sortField) {
                case 'name':
                    cmp = a.name.localeCompare(b.name);
                    break;
                case 'status':
                    cmp = (STATUS_ORDER[a.status?.toUpperCase() || ''] ?? 9) - (STATUS_ORDER[b.status?.toUpperCase() || ''] ?? 9);
                    break;
                case 'emails_sent':
                    cmp = a.emails_sent - b.emails_sent;
                    break;
                case 'replies':
                    cmp = a.replies - b.replies;
                    break;
            }
            return sortDir === 'asc' ? cmp : -cmp;
        });
        return copy;
    }, [campaigns, sortField, sortDir, debouncedSearch]);

    const toggleSort = useCallback((field: SortField) => {
        setSortField((prev) => {
            if (prev === field) {
                setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
                return prev;
            }
            setSortDir('asc');
            return field;
        });
    }, []);

    function sortIcon(field: SortField) {
        if (sortField !== field) return <IconArrowsSort size={14} style={{ opacity: 0.3 }} />;
        return sortDir === 'asc' ? <IconArrowUp size={14} /> : <IconArrowDown size={14} />;
    }

    function thButton(field: SortField, label: string) {
        return (
            <UnstyledButton onClick={() => toggleSort(field)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {label}
                {sortIcon(field)}
            </UnstyledButton>
        );
    }

    if (!pvStatus?.configured) {
        return (
            <Alert icon={<IconAlertCircle size={16} />} color="yellow" variant="light" mt="md">
                {t('campaigns.notConfiguredDesc')}
            </Alert>
        );
    }

    return (
        <Stack gap="md" mt="md">
            <Group justify="space-between">
                <Group gap="xs">
                    <Text fw={600}>{t('campaigns.pageTitle')}</Text>
                    <Badge size="sm" variant="light" color="violet">{sorted.length}/{campaigns.length}</Badge>
                </Group>
                <Group gap="sm">
                    <TextInput
                        size="xs"
                        placeholder={t('campaigns.searchPlaceholder')}
                        leftSection={<IconSearch size={14} />}
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        style={{ width: 220 }}
                    />
                    <Button
                        variant="light"
                        leftSection={<IconRefresh size={16} />}
                        onClick={() => syncMutation.mutate()}
                        loading={syncMutation.isPending}
                        size="xs"
                    >
                        {t('campaigns.sync')}
                    </Button>
                </Group>
            </Group>

            {!pvStatus.connected && (
                <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light" size="sm">
                    {t('campaigns.connectionError')}
                </Alert>
            )}

            {isLoading ? (
                <Center py="md"><Loader size="sm" /></Center>
            ) : campaigns.length === 0 ? (
                <Text c="dimmed" size="sm" ta="center" py="md">{t('campaigns.noData')}</Text>
            ) : (
                <Table highlightOnHover striped>
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>{thButton('name', t('campaigns.table.name'))}</Table.Th>
                            <Table.Th>{thButton('status', t('campaigns.table.status'))}</Table.Th>
                            <Table.Th>{t('campaigns.table.assignedTo')}</Table.Th>
                            <Table.Th ta="right">{thButton('emails_sent', t('campaigns.table.sent'))}</Table.Th>
                            <Table.Th ta="right">{thButton('replies', t('campaigns.stats.replies'))}</Table.Th>
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {sorted.map((c: PlusVibeCampaign) => (
                            <Table.Tr key={c.id}>
                                <Table.Td>
                                    <Text size="sm" fw={500}>{c.name}</Text>
                                </Table.Td>
                                <Table.Td>
                                    <Badge size="sm" variant="light" color={statusColor(c.status)}>
                                        {c.status || '-'}
                                    </Badge>
                                </Table.Td>
                                <Table.Td>
                                    <Select
                                        size="xs"
                                        placeholder={t('campaigns.table.unassigned')}
                                        clearable
                                        data={tenantSelectData}
                                        value={c.tenant_id || null}
                                        onChange={(v) => assignMutation.mutate({ id: c.id, tenantId: v })}
                                        style={{ minWidth: 180 }}
                                    />
                                </Table.Td>
                                <Table.Td ta="right">
                                    <Text size="sm">{c.emails_sent}</Text>
                                </Table.Td>
                                <Table.Td ta="right">
                                    <Text size="sm">{c.replies}</Text>
                                </Table.Td>
                            </Table.Tr>
                        ))}
                    </Table.Tbody>
                </Table>
            )}
        </Stack>
    );
}
