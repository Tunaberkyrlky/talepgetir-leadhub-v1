import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Stack, Group, Text, Badge, Table, Select, Button, Alert,
    Loader, Center, UnstyledButton, TextInput, Paper, ActionIcon,
} from '@mantine/core';
import {
    IconRefresh, IconAlertCircle, IconArrowUp, IconArrowDown, IconArrowsSort,
    IconSearch, IconPlus, IconTrash,
} from '@tabler/icons-react';
import { useDebouncedValue } from '@mantine/hooks';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';
import { useAuth } from '../../contexts/AuthContext';
import type { CampaignsResponse, PlusVibeCampaign, PlusVibeStatus } from '../../types/plusvibe';

interface PrefixRule {
    id: string;
    prefix: string;
    tenant_id: string;
    created_at: string;
    tenants?: { name: string } | null;
}

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

/**
 * Resolve which rule a campaign name matches (longest boundary-aware prefix wins) —
 * mirrors the server's matchTenant so the UI can show the assigning prefix + counts.
 */
function matchRule(name: string, rules: PrefixRule[]): PrefixRule | null {
    const n = (name ?? '').trim().toUpperCase();
    if (!n) return null;
    let best: PrefixRule | null = null;
    let bestLen = -1;
    for (const r of rules) {
        const p = r.prefix.trim().toUpperCase();
        if (!p) continue;
        const next = n[p.length];
        const boundary = next === undefined || !/[A-Z0-9]/.test(next);
        if (n.startsWith(p) && boundary && p.length > bestLen) {
            best = r;
            bestLen = p.length;
        }
    }
    return best;
}

export default function CampaignAssignmentTab() {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const { accessibleTenants } = useAuth();

    const [sortField, setSortField] = useState<SortField>('status');
    const [sortDir, setSortDir] = useState<SortDir>('asc');
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 200);

    const [newPrefix, setNewPrefix] = useState('');
    const [newTenant, setNewTenant] = useState<string | null>(null);

    const { data: pvStatus } = useQuery<PlusVibeStatus>({
        queryKey: ['plusvibe', 'status'],
        queryFn: async () => (await api.get('/plusvibe/status')).data,
    });

    const { data: campaignsData, isLoading } = useQuery<CampaignsResponse>({
        queryKey: ['plusvibe', 'admin-campaigns'],
        queryFn: async () => (await api.get('/plusvibe/campaigns', { params: { admin: 'true' } })).data,
        enabled: !!pvStatus?.configured,
    });

    const { data: rulesData, isLoading: rulesLoading } = useQuery<{ data: PrefixRule[] }>({
        queryKey: ['plusvibe', 'prefix-rules'],
        queryFn: async () => (await api.get('/plusvibe/prefix-rules')).data,
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

    const addRuleMutation = useMutation({
        mutationFn: async ({ prefix, tenant_id }: { prefix: string; tenant_id: string }) =>
            (await api.post('/plusvibe/prefix-rules', { prefix, tenant_id })).data,
        onSuccess: () => {
            showSuccess(t('campaigns.prefixRules.added'));
            setNewPrefix('');
            setNewTenant(null);
            queryClient.invalidateQueries({ queryKey: ['plusvibe'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    const deleteRuleMutation = useMutation({
        mutationFn: async (id: string) => (await api.delete(`/plusvibe/prefix-rules/${id}`)).data,
        onSuccess: () => {
            showSuccess(t('campaigns.prefixRules.deleted'));
            queryClient.invalidateQueries({ queryKey: ['plusvibe'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    const campaigns = useMemo(() => campaignsData?.data || [], [campaignsData]);
    const rules = useMemo(() => rulesData?.data || [], [rulesData]);

    const tenantSelectData = useMemo(() => (accessibleTenants || []).map((tn) => ({
        value: tn.id,
        label: tn.name,
    })), [accessibleTenants]);

    const tenantNameById = useMemo(
        () => new Map((accessibleTenants || []).map((tn) => [tn.id, tn.name])),
        [accessibleTenants],
    );

    // Campaign count matched by each rule (longest-prefix wins, so counts don't overlap).
    const matchCountByRule = useMemo(() => {
        const counts = new Map<string, number>();
        for (const c of campaigns) {
            const r = matchRule(c.name, rules);
            if (r) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
        }
        return counts;
    }, [campaigns, rules]);

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

    const canAdd = newPrefix.trim().length > 0 && !!newTenant;
    const onAddRule = useCallback(() => {
        if (!newPrefix.trim() || !newTenant) return;
        addRuleMutation.mutate({ prefix: newPrefix.trim(), tenant_id: newTenant });
    }, [newPrefix, newTenant, addRuleMutation]);

    if (!pvStatus?.configured) {
        return (
            <Alert icon={<IconAlertCircle size={16} />} color="yellow" variant="light" mt="md">
                {t('campaigns.notConfiguredDesc')}
            </Alert>
        );
    }

    return (
        <Stack gap="md" mt="md">
            {/* ── Prefix rules — assignment is fully prefix-driven ── */}
            <Paper withBorder p="md" radius="md">
                <Text fw={600}>{t('campaigns.prefixRules.title')}</Text>
                <Text size="xs" c="dimmed" mb="sm">{t('campaigns.prefixRules.desc')}</Text>

                <Group align="flex-end" gap="sm" mb="sm">
                    <TextInput
                        label={t('campaigns.prefixRules.prefix')}
                        placeholder="NTR"
                        value={newPrefix}
                        onChange={(e) => setNewPrefix(e.currentTarget.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && canAdd) onAddRule(); }}
                        style={{ width: 160 }}
                    />
                    <Select
                        label={t('campaigns.prefixRules.tenant')}
                        placeholder={t('campaigns.table.unassigned')}
                        data={tenantSelectData}
                        value={newTenant}
                        onChange={setNewTenant}
                        searchable
                        style={{ minWidth: 220 }}
                    />
                    <Button
                        leftSection={<IconPlus size={16} />}
                        onClick={onAddRule}
                        loading={addRuleMutation.isPending}
                        disabled={!canAdd}
                    >
                        {t('campaigns.prefixRules.add')}
                    </Button>
                </Group>

                {rulesLoading ? (
                    <Center py="sm"><Loader size="sm" /></Center>
                ) : rules.length === 0 ? (
                    <Text size="sm" c="dimmed" py="xs">{t('campaigns.prefixRules.empty')}</Text>
                ) : (
                    <Table>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>{t('campaigns.prefixRules.prefix')}</Table.Th>
                                <Table.Th>{t('campaigns.prefixRules.tenant')}</Table.Th>
                                <Table.Th ta="right">{t('campaigns.prefixRules.matched')}</Table.Th>
                                <Table.Th />
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {rules.map((r) => (
                                <Table.Tr key={r.id}>
                                    <Table.Td>
                                        <Badge variant="light" color="violet">{r.prefix}</Badge>
                                    </Table.Td>
                                    <Table.Td>
                                        <Text size="sm">{r.tenants?.name ?? tenantNameById.get(r.tenant_id) ?? r.tenant_id}</Text>
                                    </Table.Td>
                                    <Table.Td ta="right">
                                        <Text size="sm" c="dimmed">{matchCountByRule.get(r.id) ?? 0}</Text>
                                    </Table.Td>
                                    <Table.Td ta="right">
                                        <ActionIcon
                                            color="red"
                                            variant="subtle"
                                            onClick={() => deleteRuleMutation.mutate(r.id)}
                                            loading={deleteRuleMutation.isPending && deleteRuleMutation.variables === r.id}
                                            aria-label={t('common.delete')}
                                        >
                                            <IconTrash size={16} />
                                        </ActionIcon>
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                )}
            </Paper>

            {/* ── Campaign list (read-only assignment — derived from prefixes) ── */}
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
                <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
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
                        {sorted.map((c: PlusVibeCampaign) => {
                            const matched = matchRule(c.name, rules);
                            return (
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
                                        {c.tenant_id ? (
                                            <Group gap={6} wrap="nowrap">
                                                <Text size="sm">{tenantNameById.get(c.tenant_id) ?? '—'}</Text>
                                                {matched && (
                                                    <Badge size="xs" variant="outline" color="violet">{matched.prefix}</Badge>
                                                )}
                                            </Group>
                                        ) : (
                                            <Text size="sm" c="dimmed">{t('campaigns.table.unassigned')}</Text>
                                        )}
                                    </Table.Td>
                                    <Table.Td ta="right">
                                        <Text size="sm">{c.emails_sent}</Text>
                                    </Table.Td>
                                    <Table.Td ta="right">
                                        <Text size="sm">{c.replies}</Text>
                                    </Table.Td>
                                </Table.Tr>
                            );
                        })}
                    </Table.Tbody>
                </Table>
            )}
        </Stack>
    );
}
