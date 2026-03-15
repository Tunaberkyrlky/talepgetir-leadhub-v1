import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Table, TextInput, Select, Button, Group, Badge, Text,
    ActionIcon, Pagination, Flex, Stack, Center, Loader, Paper, Box, Menu, Tooltip,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconSearch, IconPlus, IconPencil, IconTrash, IconX, IconDotsVertical, IconUserOff, IconUserCheck } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import UserFormModal from './UserFormModal';

interface UserMembership {
    id: string;
    tenant_id: string;
    tenant_name: string;
    role: string;
    is_active: boolean;
}

interface AdminUser {
    id: string;
    email: string;
    created_at: string;
    last_sign_in_at: string | null;
    memberships: UserMembership[];
}

const ROLE_COLORS: Record<string, string> = {
    superadmin: 'red',
    ops_agent: 'orange',
    client_admin: 'blue',
    client_viewer: 'gray',
};

export default function AdminUsersTab() {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 300);
    const [roleFilter, setRoleFilter] = useState<string | null>(null);
    const [modalOpened, { open: openModal, close: closeModal }] = useDisclosure(false);
    const [editingUser, setEditingUser] = useState<AdminUser | null>(null);

    const roleOptions = [
        { value: 'superadmin', label: 'Superadmin' },
        { value: 'ops_agent', label: 'Ops Agent' },
        { value: 'client_admin', label: 'Client Admin' },
        { value: 'client_viewer', label: 'Client Viewer' },
    ];

    const { data, isLoading } = useQuery({
        queryKey: ['admin', 'users', page, debouncedSearch, roleFilter],
        queryFn: async () => {
            const params = new URLSearchParams();
            params.set('page', String(page));
            params.set('limit', '25');
            if (debouncedSearch) params.set('search', debouncedSearch);
            if (roleFilter) params.set('role', roleFilter);
            const res = await api.get(`/admin/users?${params}`);
            return res.data;
        },
    });

    const deactivateMutation = useMutation({
        mutationFn: async (id: string) => api.delete(`/admin/users/${id}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
            notifications.show({ message: t('admin.userDeactivated'), color: 'green' });
        },
    });

    const deleteMutation = useMutation({
        mutationFn: async (id: string) => api.delete(`/admin/users/${id}?hard=true`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
            notifications.show({ message: t('admin.userDeleted'), color: 'green' });
        },
    });

    const handleEdit = (user: AdminUser) => {
        setEditingUser(user);
        openModal();
    };

    const handleCreate = () => {
        setEditingUser(null);
        openModal();
    };

    const formatDate = (dateStr: string | null) => {
        if (!dateStr) return '—';
        return new Date(dateStr).toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', year: 'numeric',
        });
    };

    return (
        <Stack gap="md" mt="md">
            {/* Toolbar */}
            <Paper shadow="sm" radius="lg" p="md" withBorder>
                <Flex justify="space-between" align="center" wrap="wrap" gap="sm">
                    <Group gap="sm" style={{ flex: 1 }}>
                        <TextInput
                            placeholder={t('admin.searchUsers')}
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
                            placeholder={t('admin.filterByRole')}
                            data={roleOptions}
                            value={roleFilter}
                            onChange={(v) => { setRoleFilter(v); setPage(1); }}
                            clearable
                            radius="md"
                            w={180}
                        />
                    </Group>
                    <Button
                        leftSection={<IconPlus size={18} />}
                        onClick={handleCreate}
                        gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                        variant="gradient"
                        radius="md"
                    >
                        {t('admin.createUser')}
                    </Button>
                </Flex>
            </Paper>

            {/* Table */}
            <Paper shadow="sm" radius="lg" withBorder style={{ overflow: 'hidden' }}>
                {isLoading ? (
                    <Center py={80}><Loader size="lg" color="violet" /></Center>
                ) : (data?.data || []).length === 0 ? (
                    <Center py={80}>
                        <Text c="dimmed">{t('admin.noUsers')}</Text>
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
                                    <Table.Th>{t('admin.userRoles')}</Table.Th>
                                    <Table.Th>{t('admin.userTenants')}</Table.Th>
                                    <Table.Th>{t('admin.userLastSignIn')}</Table.Th>
                                    <Table.Th style={{ width: 50 }} />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {(data?.data || []).map((user: AdminUser) => (
                                    <Table.Tr key={user.id}>
                                        <Table.Td>
                                            <Text size="sm" fw={500}>{user.email}</Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Group gap={4}>
                                                {user.memberships.length === 0 ? (
                                                    <Badge size="xs" variant="light" color="gray">{t('admin.noMemberships')}</Badge>
                                                ) : (
                                                    [...new Set(user.memberships.map(m => m.role))].map(role => (
                                                        <Badge key={role} size="xs" variant="light" color={ROLE_COLORS[role] || 'gray'}>
                                                            {role}
                                                        </Badge>
                                                    ))
                                                )}
                                            </Group>
                                        </Table.Td>
                                        <Table.Td>
                                            <Group gap={4}>
                                                {user.memberships.map(m => (
                                                    <Tooltip key={m.id} label={`${m.role} — ${m.is_active ? t('admin.tenantActive') : t('admin.tenantInactive')}`} withArrow>
                                                        <Badge size="xs" variant={m.is_active ? 'light' : 'outline'} color={m.is_active ? 'violet' : 'gray'}>
                                                            {m.tenant_name}
                                                        </Badge>
                                                    </Tooltip>
                                                ))}
                                            </Group>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="xs" c="dimmed">{formatDate(user.last_sign_in_at)}</Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Menu withinPortal position="bottom-end" shadow="sm">
                                                <Menu.Target>
                                                    <ActionIcon variant="subtle" color="gray">
                                                        <IconDotsVertical size={16} />
                                                    </ActionIcon>
                                                </Menu.Target>
                                                <Menu.Dropdown>
                                                    <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => handleEdit(user)}>
                                                        {t('admin.editUser')}
                                                    </Menu.Item>
                                                    <Menu.Item
                                                        leftSection={<IconUserOff size={14} />}
                                                        color="orange"
                                                        onClick={() => {
                                                            if (window.confirm(t('admin.userDeactivateConfirm'))) {
                                                                deactivateMutation.mutate(user.id);
                                                            }
                                                        }}
                                                    >
                                                        {t('admin.deactivateUser')}
                                                    </Menu.Item>
                                                    <Menu.Divider />
                                                    <Menu.Item
                                                        leftSection={<IconTrash size={14} />}
                                                        color="red"
                                                        onClick={() => {
                                                            if (window.confirm(t('admin.userDeleteConfirm'))) {
                                                                deleteMutation.mutate(user.id);
                                                            }
                                                        }}
                                                    >
                                                        {t('admin.deleteUser')}
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

            <UserFormModal
                opened={modalOpened}
                onClose={() => { closeModal(); setEditingUser(null); }}
                user={editingUser}
            />
        </Stack>
    );
}
