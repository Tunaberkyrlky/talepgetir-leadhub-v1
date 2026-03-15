import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Table, Select, Button, Group, Badge, Text,
    ActionIcon, Pagination, Flex, Stack, Center, Loader, Paper, Box, Menu,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconPencil, IconTrash, IconDotsVertical } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import MembershipFormModal from './MembershipFormModal';

interface Membership {
    id: string;
    user_id: string;
    user_email: string;
    tenant_id: string;
    tenant_name: string;
    tenant_slug: string;
    role: string;
    is_active: boolean;
    created_at: string;
}

const ROLE_COLORS: Record<string, string> = {
    superadmin: 'red',
    ops_agent: 'orange',
    client_admin: 'blue',
    client_viewer: 'gray',
};

export default function AdminMembershipsTab() {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const [page, setPage] = useState(1);
    const [tenantFilter, setTenantFilter] = useState<string | null>(null);
    const [roleFilter, setRoleFilter] = useState<string | null>(null);
    const [activeFilter, setActiveFilter] = useState<string | null>(null);
    const [modalOpened, { open: openModal, close: closeModal }] = useDisclosure(false);
    const [editingMembership, setEditingMembership] = useState<Membership | null>(null);

    // Fetch tenants for filter
    const { data: tenantsData } = useQuery({
        queryKey: ['admin', 'tenants', 'all'],
        queryFn: async () => {
            const res = await api.get('/admin/tenants?limit=100');
            return res.data;
        },
    });

    const tenantOptions = (tenantsData?.data || []).map((t: any) => ({
        value: t.id,
        label: t.name,
    }));

    const roleOptions = [
        { value: 'superadmin', label: 'Superadmin' },
        { value: 'ops_agent', label: 'Ops Agent' },
        { value: 'client_admin', label: 'Client Admin' },
        { value: 'client_viewer', label: 'Client Viewer' },
    ];

    const { data, isLoading } = useQuery({
        queryKey: ['admin', 'memberships', page, tenantFilter, roleFilter, activeFilter],
        queryFn: async () => {
            const params = new URLSearchParams();
            params.set('page', String(page));
            params.set('limit', '25');
            if (tenantFilter) params.set('tenant_id', tenantFilter);
            if (roleFilter) params.set('role', roleFilter);
            if (activeFilter) params.set('is_active', activeFilter);
            const res = await api.get(`/admin/memberships?${params}`);
            return res.data;
        },
    });

    const deleteMutation = useMutation({
        mutationFn: async (id: string) => api.delete(`/admin/memberships/${id}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'memberships'] });
            queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
            notifications.show({ message: t('admin.membershipRemoved'), color: 'green' });
        },
        onError: (err: any) => {
            notifications.show({ message: err.response?.data?.error || t('common.error'), color: 'red' });
        },
    });

    const handleEdit = (membership: Membership) => {
        setEditingMembership(membership);
        openModal();
    };

    const handleCreate = () => {
        setEditingMembership(null);
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
                        <Select
                            placeholder={t('admin.filterByTenant')}
                            data={tenantOptions}
                            value={tenantFilter}
                            onChange={(v) => { setTenantFilter(v); setPage(1); }}
                            clearable
                            searchable
                            radius="md"
                            w={220}
                        />
                        <Select
                            placeholder={t('admin.filterByRole')}
                            data={roleOptions}
                            value={roleFilter}
                            onChange={(v) => { setRoleFilter(v); setPage(1); }}
                            clearable
                            radius="md"
                            w={180}
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
                        {t('admin.assignUser')}
                    </Button>
                </Flex>
            </Paper>

            <Paper shadow="sm" radius="lg" withBorder style={{ overflow: 'hidden' }}>
                {isLoading ? (
                    <Center py={80}><Loader size="lg" color="violet" /></Center>
                ) : (data?.data || []).length === 0 ? (
                    <Center py={80}>
                        <Text c="dimmed">{t('admin.noMemberships')}</Text>
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
                                    <Table.Th>{t('admin.userEmail')}</Table.Th>
                                    <Table.Th>{t('admin.tenantName')}</Table.Th>
                                    <Table.Th>{t('admin.membershipRole')}</Table.Th>
                                    <Table.Th>{t('admin.status')}</Table.Th>
                                    <Table.Th>{t('company.createdAt')}</Table.Th>
                                    <Table.Th style={{ width: 50 }} />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {(data?.data || []).map((m: Membership) => (
                                    <Table.Tr key={m.id}>
                                        <Table.Td><Text size="sm" fw={500}>{m.user_email}</Text></Table.Td>
                                        <Table.Td><Text size="sm">{m.tenant_name}</Text></Table.Td>
                                        <Table.Td>
                                            <Badge size="sm" variant="light" color={ROLE_COLORS[m.role] || 'gray'}>
                                                {m.role}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>
                                            <Badge size="sm" variant="light" color={m.is_active ? 'green' : 'red'}>
                                                {m.is_active ? t('admin.tenantActive') : t('admin.tenantInactive')}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td><Text size="xs" c="dimmed">{formatDate(m.created_at)}</Text></Table.Td>
                                        <Table.Td>
                                            <Menu withinPortal position="bottom-end" shadow="sm">
                                                <Menu.Target>
                                                    <ActionIcon variant="subtle" color="gray">
                                                        <IconDotsVertical size={16} />
                                                    </ActionIcon>
                                                </Menu.Target>
                                                <Menu.Dropdown>
                                                    <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => handleEdit(m)}>
                                                        {t('admin.editMembership')}
                                                    </Menu.Item>
                                                    <Menu.Divider />
                                                    <Menu.Item
                                                        leftSection={<IconTrash size={14} />}
                                                        color="red"
                                                        onClick={() => {
                                                            if (window.confirm(t('admin.membershipRemoveConfirm'))) {
                                                                deleteMutation.mutate(m.id);
                                                            }
                                                        }}
                                                    >
                                                        {t('admin.removeMembership')}
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

            <MembershipFormModal
                opened={modalOpened}
                onClose={() => { closeModal(); setEditingMembership(null); }}
                membership={editingMembership}
            />
        </Stack>
    );
}
