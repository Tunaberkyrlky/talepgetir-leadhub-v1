import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Table, TextInput, Select, Button, Group, Badge, Text,
    ActionIcon, Pagination, Flex, Stack, Center, Loader, Paper, Box, Menu,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconSearch, IconPlus, IconPencil, IconTrash, IconX, IconDotsVertical } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import TenantFormModal from './TenantFormModal';

interface Tenant {
    id: string;
    name: string;
    slug: string;
    tier: string;
    is_active: boolean;
    member_count: number;
    created_at: string;
    updated_at: string;
}

export default function AdminTenantsTab() {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 300);
    const [tierFilter, setTierFilter] = useState<string | null>(null);
    const [activeFilter, setActiveFilter] = useState<string | null>(null);
    const [modalOpened, { open: openModal, close: closeModal }] = useDisclosure(false);
    const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);

    const { data, isLoading } = useQuery({
        queryKey: ['admin', 'tenants', page, debouncedSearch, tierFilter, activeFilter],
        queryFn: async () => {
            const params = new URLSearchParams();
            params.set('page', String(page));
            params.set('limit', '25');
            if (debouncedSearch) params.set('search', debouncedSearch);
            if (tierFilter) params.set('tier', tierFilter);
            if (activeFilter) params.set('is_active', activeFilter);
            const res = await api.get(`/admin/tenants?${params}`);
            return res.data;
        },
    });

    const deleteMutation = useMutation({
        mutationFn: async (id: string) => api.delete(`/admin/tenants/${id}?confirm=true`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'tenants'] });
            notifications.show({ message: t('admin.tenantDeleted'), color: 'green' });
        },
        onError: (err: any) => {
            notifications.show({ message: err.response?.data?.error || t('common.error'), color: 'red' });
        },
    });

    const toggleActiveMutation = useMutation({
        mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) =>
            api.put(`/admin/tenants/${id}`, { is_active }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'tenants'] });
            notifications.show({ message: t('admin.tenantUpdated'), color: 'green' });
        },
    });

    const handleEdit = (tenant: Tenant) => {
        setEditingTenant(tenant);
        openModal();
    };

    const handleCreate = () => {
        setEditingTenant(null);
        openModal();
    };

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', year: 'numeric',
        });
    };

    return (
        <Stack gap="md" mt="md">
            <Paper shadow="sm" radius="lg" p="md" withBorder>
                <Flex justify="space-between" align="center" wrap="wrap" gap="sm">
                    <Group gap="sm" style={{ flex: 1 }}>
                        <TextInput
                            placeholder={t('admin.searchTenants')}
                            leftSection={<IconSearch size={16} />}
                            value={search}
                            onChange={(e) => { setSearch(e.currentTarget.value); setPage(1); }}
                            radius="md"
                            style={{ minWidth: 250 }}
                            rightSection={search && (
                                <ActionIcon variant="subtle" size="sm" onClick={() => setSearch('')}>
                                    <IconX size={14} />
                                </ActionIcon>
                            )}
                        />
                        <Select
                            placeholder={t('admin.filterByTier')}
                            data={[{ value: 'basic', label: 'Basic' }, { value: 'pro', label: 'Pro' }]}
                            value={tierFilter}
                            onChange={(v) => { setTierFilter(v); setPage(1); }}
                            clearable
                            radius="md"
                            w={150}
                        />
                        <Select
                            placeholder={t('admin.filterByStatus')}
                            data={[{ value: 'true', label: t('admin.tenantActive') }, { value: 'false', label: t('admin.tenantInactive') }]}
                            value={activeFilter}
                            onChange={(v) => { setActiveFilter(v); setPage(1); }}
                            clearable
                            radius="md"
                            w={150}
                        />
                    </Group>
                    <Button
                        leftSection={<IconPlus size={18} />}
                        onClick={handleCreate}
                        gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                        variant="gradient"
                        radius="md"
                    >
                        {t('admin.createTenant')}
                    </Button>
                </Flex>
            </Paper>

            <Paper shadow="sm" radius="lg" withBorder style={{ overflow: 'hidden' }}>
                {isLoading ? (
                    <Center py={80}><Loader size="lg" color="violet" /></Center>
                ) : (data?.data || []).length === 0 ? (
                    <Center py={80}>
                        <Text c="dimmed">{t('admin.noTenants')}</Text>
                    </Center>
                ) : (
                    <>
                        <Table.ScrollContainer minWidth={800}>
                        <Table striped highlightOnHover verticalSpacing="sm" horizontalSpacing="md"
                            styles={{
                                thead: { background: 'linear-gradient(135deg, #1a1b2e 0%, #16213e 100%)' },
                                th: { fontWeight: 600, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '12px 16px', whiteSpace: 'nowrap', color: 'white' },
                            }}
                        >
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('admin.tenantName')}</Table.Th>
                                    <Table.Th>{t('admin.tenantSlug')}</Table.Th>
                                    <Table.Th>{t('admin.tenantTier')}</Table.Th>
                                    <Table.Th>{t('admin.status')}</Table.Th>
                                    <Table.Th>{t('admin.tenantMembers')}</Table.Th>
                                    <Table.Th>{t('company.createdAt')}</Table.Th>
                                    <Table.Th style={{ width: 50 }} />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {(data?.data || []).map((tenant: Tenant) => (
                                    <Table.Tr key={tenant.id}>
                                        <Table.Td><Text size="sm" fw={500}>{tenant.name}</Text></Table.Td>
                                        <Table.Td><Text size="xs" c="dimmed" ff="monospace">{tenant.slug}</Text></Table.Td>
                                        <Table.Td>
                                            <Badge size="sm" variant="light" color={tenant.tier === 'pro' ? 'violet' : 'blue'}>
                                                {tenant.tier}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>
                                            <Badge size="sm" variant="light" color={tenant.is_active ? 'green' : 'red'}>
                                                {tenant.is_active ? t('admin.tenantActive') : t('admin.tenantInactive')}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>
                                            <Badge size="sm" variant="light" color="gray">{tenant.member_count}</Badge>
                                        </Table.Td>
                                        <Table.Td><Text size="xs" c="dimmed">{formatDate(tenant.created_at)}</Text></Table.Td>
                                        <Table.Td>
                                            <Menu withinPortal position="bottom-end" shadow="sm">
                                                <Menu.Target>
                                                    <ActionIcon variant="subtle" color="gray">
                                                        <IconDotsVertical size={16} />
                                                    </ActionIcon>
                                                </Menu.Target>
                                                <Menu.Dropdown>
                                                    <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => handleEdit(tenant)}>
                                                        {t('admin.editTenant')}
                                                    </Menu.Item>
                                                    <Menu.Item
                                                        onClick={() => toggleActiveMutation.mutate({ id: tenant.id, is_active: !tenant.is_active })}
                                                    >
                                                        {tenant.is_active ? t('admin.deactivateTenant') : t('admin.activateTenant')}
                                                    </Menu.Item>
                                                    <Menu.Divider />
                                                    <Menu.Item
                                                        leftSection={<IconTrash size={14} />}
                                                        color="red"
                                                        onClick={() => {
                                                            if (window.confirm(t('admin.tenantDeleteConfirm'))) {
                                                                deleteMutation.mutate(tenant.id);
                                                            }
                                                        }}
                                                    >
                                                        {t('admin.deleteTenant')}
                                                    </Menu.Item>
                                                </Menu.Dropdown>
                                            </Menu>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                        </Table.ScrollContainer>

                        {data && data.pagination.totalPages > 1 && (
                            <Box p="md">
                                <Flex justify="space-between" align="center">
                                    <Text size="sm" c="dimmed">
                                        {t('pagination.showing')} {((page - 1) * 25) + 1}–{Math.min(page * 25, data.pagination.total)} {t('pagination.of')} {data.pagination.total}
                                    </Text>
                                    <Pagination total={data.pagination.totalPages} value={page} onChange={setPage} color="violet" radius="md" size="sm" />
                                </Flex>
                            </Box>
                        )}
                    </>
                )}
            </Paper>

            <TenantFormModal
                opened={modalOpened}
                onClose={() => { closeModal(); setEditingTenant(null); }}
                tenant={editingTenant}
            />
        </Stack>
    );
}
