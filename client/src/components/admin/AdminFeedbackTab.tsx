import { Fragment, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Stack, Group, Text, Badge, Table, Select, Loader, Center,
    TextInput, ActionIcon, Tooltip, Paper, Pagination,
} from '@mantine/core';
import { IconSearch, IconTrash } from '@tabler/icons-react';
import { useDebouncedValue } from '@mantine/hooks';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';

interface Feedback {
    id: string;
    tenant_id: string;
    user_id: string;
    user_email: string;
    type: 'feature_request' | 'bug_report';
    title: string;
    description: string | null;
    status: 'open' | 'in_progress' | 'resolved' | 'closed';
    created_at: string;
}

interface FeedbackResponse {
    data: Feedback[];
    pagination: {
        total: number;
        page: number;
        limit: number;
        hasNext: boolean;
    };
}

function typeColor(type: string): string {
    return type === 'bug_report' ? 'red' : 'violet';
}

function statusColor(status: string): string {
    switch (status) {
        case 'open': return 'blue';
        case 'in_progress': return 'yellow';
        case 'resolved': return 'green';
        case 'closed': return 'gray';
        default: return 'gray';
    }
}

export default function AdminFeedbackTab() {
    const { t, i18n } = useTranslation();
    const queryClient = useQueryClient();
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';

    const [page, setPage] = useState(1);
    const [typeFilter, setTypeFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 300);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    const { data, isLoading } = useQuery<FeedbackResponse>({
        queryKey: ['admin-feedback', page, typeFilter, statusFilter, debouncedSearch],
        queryFn: async () => {
            const params: Record<string, string> = { page: String(page), limit: '20' };
            if (typeFilter) params.type = typeFilter;
            if (statusFilter) params.status = statusFilter;
            if (debouncedSearch) params.search = debouncedSearch;
            return (await api.get('/feedback', { params })).data;
        },
    });

    const statusMutation = useMutation({
        mutationFn: async ({ id, status }: { id: string; status: string }) => {
            return (await api.patch(`/feedback/${id}/status`, { status })).data;
        },
        onSuccess: () => {
            showSuccess(t('feedback.admin.statusUpdated'));
            queryClient.invalidateQueries({ queryKey: ['admin-feedback'] });
        },
        onError: (err) => {
            showErrorFromApi(err, t('feedback.errors.updateFailed'));
        },
    });

    const deleteMutation = useMutation({
        mutationFn: async (id: string) => {
            await api.delete(`/feedback/${id}`);
        },
        onSuccess: () => {
            showSuccess(t('feedback.admin.deleted'));
            queryClient.invalidateQueries({ queryKey: ['admin-feedback'] });
        },
        onError: (err) => {
            showErrorFromApi(err, t('feedback.errors.deleteFailed'));
        },
    });

    const formatDate = (iso: string) =>
        new Date(iso).toLocaleDateString(locale, {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });

    const totalPages = data ? Math.ceil(data.pagination.total / data.pagination.limit) : 1;

    return (
        <Stack gap="md" mt="md">
            {/* Filters */}
            <Group gap="sm" wrap="wrap">
                <TextInput
                    size="sm"
                    placeholder={t('feedback.admin.search')}
                    leftSection={<IconSearch size={16} />}
                    value={search}
                    onChange={(e) => { setSearch(e.currentTarget.value); setPage(1); }}
                    style={{ flex: 1, minWidth: 200 }}
                />
                <Select
                    size="sm"
                    placeholder={t('feedback.admin.allTypes')}
                    clearable
                    value={typeFilter || null}
                    onChange={(v) => { setTypeFilter(v || ''); setPage(1); }}
                    data={[
                        { value: 'feature_request', label: t('feedback.types.featureRequest') },
                        { value: 'bug_report', label: t('feedback.types.bugReport') },
                    ]}
                    style={{ minWidth: 160 }}
                />
                <Select
                    size="sm"
                    placeholder={t('feedback.admin.allStatuses')}
                    clearable
                    value={statusFilter || null}
                    onChange={(v) => { setStatusFilter(v || ''); setPage(1); }}
                    data={[
                        { value: 'open', label: t('feedback.statuses.open') },
                        { value: 'in_progress', label: t('feedback.statuses.inProgress') },
                        { value: 'resolved', label: t('feedback.statuses.resolved') },
                        { value: 'closed', label: t('feedback.statuses.closed') },
                    ]}
                    style={{ minWidth: 160 }}
                />
            </Group>

            {/* Table */}
            {isLoading ? (
                <Center py="xl"><Loader size="md" color="violet" /></Center>
            ) : !data?.data.length ? (
                <Center py="xl">
                    <Text c="dimmed" fs="italic">{t('feedback.admin.noData')}</Text>
                </Center>
            ) : (
                <>
                    <Paper radius="md" withBorder style={{ overflow: 'auto' }}>
                        <Table highlightOnHover striped>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('feedback.admin.table.type')}</Table.Th>
                                    <Table.Th>{t('feedback.admin.table.title')}</Table.Th>
                                    <Table.Th>{t('feedback.admin.table.user')}</Table.Th>
                                    <Table.Th>{t('feedback.admin.table.status')}</Table.Th>
                                    <Table.Th>{t('feedback.admin.table.date')}</Table.Th>
                                    <Table.Th style={{ width: 40 }} />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {data.data.map((fb) => (
                                    <Fragment key={fb.id}>
                                        <Table.Tr
                                            style={{ cursor: 'pointer' }}
                                            onClick={() => setExpandedId(expandedId === fb.id ? null : fb.id)}
                                        >
                                            <Table.Td>
                                                <Badge size="sm" variant="light" color={typeColor(fb.type)}>
                                                    {t(`feedback.types.${fb.type === 'bug_report' ? 'bugReport' : 'featureRequest'}`)}
                                                </Badge>
                                            </Table.Td>
                                            <Table.Td>
                                                <Text size="sm" fw={500} lineClamp={1}>{fb.title}</Text>
                                            </Table.Td>
                                            <Table.Td>
                                                <Text size="xs" c="dimmed">{fb.user_email}</Text>
                                            </Table.Td>
                                            <Table.Td>
                                                <Select
                                                    size="xs"
                                                    value={fb.status}
                                                    onChange={(v) => {
                                                        if (v) statusMutation.mutate({ id: fb.id, status: v });
                                                    }}
                                                    data={[
                                                        { value: 'open', label: t('feedback.statuses.open') },
                                                        { value: 'in_progress', label: t('feedback.statuses.inProgress') },
                                                        { value: 'resolved', label: t('feedback.statuses.resolved') },
                                                        { value: 'closed', label: t('feedback.statuses.closed') },
                                                    ]}
                                                    styles={{
                                                        input: {
                                                            color: `var(--mantine-color-${statusColor(fb.status)}-6)`,
                                                            fontWeight: 600,
                                                            fontSize: '0.75rem',
                                                        },
                                                    }}
                                                    onClick={(e) => e.stopPropagation()}
                                                    w={130}
                                                />
                                            </Table.Td>
                                            <Table.Td>
                                                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                                                    {formatDate(fb.created_at)}
                                                </Text>
                                            </Table.Td>
                                            <Table.Td>
                                                <Tooltip label={t('feedback.admin.delete')}>
                                                    <ActionIcon
                                                        variant="subtle"
                                                        color="red"
                                                        size="sm"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            deleteMutation.mutate(fb.id);
                                                        }}
                                                    >
                                                        <IconTrash size={14} />
                                                    </ActionIcon>
                                                </Tooltip>
                                            </Table.Td>
                                        </Table.Tr>
                                        {expandedId === fb.id && fb.description && (
                                            <Table.Tr key={`${fb.id}-desc`}>
                                                <Table.Td colSpan={6}>
                                                    <Paper p="sm" bg="gray.0" radius="sm">
                                                        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                                                            {fb.description}
                                                        </Text>
                                                    </Paper>
                                                </Table.Td>
                                            </Table.Tr>
                                        )}
                                    </Fragment>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </Paper>

                    {totalPages > 1 && (
                        <Center>
                            <Pagination
                                value={page}
                                onChange={setPage}
                                total={totalPages}
                                size="sm"
                            />
                        </Center>
                    )}
                </>
            )}
        </Stack>
    );
}
