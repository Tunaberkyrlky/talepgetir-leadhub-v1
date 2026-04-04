import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Modal, TextInput, PasswordInput, Select, Stack, Button, Group,
    Text, Badge, ActionIcon, Tooltip, Divider, Paper,
} from '@mantine/core';
import { IconTrash, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';

interface UserMembership {
    id: string;
    tenant_id: string;
    tenant_name: string;
    role: string;
    is_active: boolean;
}

interface UserFormModalProps {
    opened: boolean;
    onClose: () => void;
    user?: { id: string; email: string; memberships?: UserMembership[] } | null;
}

const ROLE_COLORS: Record<string, string> = {
    superadmin: 'red',
    ops_agent: 'orange',
    client_admin: 'blue',
    client_viewer: 'gray',
};

const ROLE_OPTIONS = [
    { value: 'superadmin', label: 'Superadmin' },
    { value: 'ops_agent', label: 'Ops Agent' },
    { value: 'client_admin', label: 'Client Admin' },
    { value: 'client_viewer', label: 'Client Viewer' },
];

export default function UserFormModal({ opened, onClose, user }: UserFormModalProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const isEdit = !!user;

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    // Create mode: single tenant+role
    const [tenantId, setTenantId] = useState<string | null>(null);
    const [role, setRole] = useState<string | null>(null);
    // Edit mode: add new membership
    const [addTenantId, setAddTenantId] = useState<string | null>(null);
    const [addRole, setAddRole] = useState<string | null>('ops_agent');

    useEffect(() => {
        if (opened) {
            setEmail(user?.email || '');
            setPassword('');
            setTenantId(null);
            setRole(null);
            setAddTenantId(null);
            setAddRole('ops_agent');
        }
    }, [opened, user]);

    // Fetch tenants for selects
    const { data: tenantsData } = useQuery({
        queryKey: ['admin', 'tenants', 'all'],
        queryFn: async () => {
            const res = await api.get('/admin/tenants?limit=100');
            return res.data;
        },
        enabled: opened,
    });

    const allTenants = (tenantsData?.data || []) as { id: string; name: string; tier: string }[];
    const existingTenantIds = new Set((user?.memberships || []).map(m => m.tenant_id));

    const tenantOptions = allTenants.map((tn) => ({
        value: tn.id,
        label: `${tn.name} (${tn.tier})`,
    }));

    // For edit mode "add tenant" - filter out already assigned tenants
    const availableTenantOptions = allTenants
        .filter((tn) => !existingTenantIds.has(tn.id))
        .map((tn) => ({
            value: tn.id,
            label: `${tn.name} (${tn.tier})`,
        }));

    // Save user (email/password)
    const saveMutation = useMutation({
        mutationFn: async () => {
            if (isEdit) {
                const body: Record<string, string> = {};
                if (email !== user.email) body.email = email;
                if (password) body.password = password;
                return api.put(`/admin/users/${user.id}`, body);
            } else {
                return api.post('/admin/users', {
                    email,
                    password,
                    tenantId: tenantId || undefined,
                    role: role || undefined,
                });
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
            queryClient.invalidateQueries({ queryKey: ['admin', 'memberships'] });
            showSuccess(isEdit ? t('admin.userUpdated') : t('admin.userCreated'));
            onClose();
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    // Add membership (edit mode)
    const addMembershipMutation = useMutation({
        mutationFn: async () => {
            return api.post('/admin/memberships', {
                user_id: user!.id,
                tenant_id: addTenantId,
                role: addRole,
            });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
            queryClient.invalidateQueries({ queryKey: ['admin', 'memberships'] });
            showSuccess(t('admin.membershipCreated', 'Tenant atandı'));
            setAddTenantId(null);
            setAddRole('ops_agent');
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    // Remove membership (edit mode)
    const removeMembershipMutation = useMutation({
        mutationFn: async (membershipId: string) => {
            return api.delete(`/admin/memberships/${membershipId}`);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
            queryClient.invalidateQueries({ queryKey: ['admin', 'memberships'] });
            showSuccess(t('admin.membershipRemoved', 'Tenant kaldırıldı'));
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const canSubmitUser = isEdit
        ? (email !== user?.email || password.length > 0)
        : (emailValid && password.length >= 8 && (!tenantId || !!role));
    const canAddMembership = addTenantId && addRole;

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={isEdit ? t('admin.editUser') : t('admin.createUser')}
            size="lg"
        >
            <Stack gap="md">
                {/* Email & Password */}
                <TextInput
                    label={t('admin.userEmail')}
                    placeholder="user@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.currentTarget.value)}
                    required
                />
                <PasswordInput
                    label={t('admin.userPassword')}
                    placeholder={isEdit ? t('admin.userPasswordHint') : ''}
                    value={password}
                    onChange={(e) => setPassword(e.currentTarget.value)}
                    required={!isEdit}
                    description={isEdit ? t('admin.userPasswordHint') : undefined}
                />

                {/* Create mode: single tenant assignment */}
                {!isEdit && (
                    <>
                        <Select
                            label={t('admin.tenantSelect')}
                            placeholder={t('admin.tenantSelectPlaceholder')}
                            data={tenantOptions}
                            value={tenantId}
                            onChange={(v) => { setTenantId(v); if (!v) setRole(null); }}
                            clearable
                            searchable
                        />
                        {tenantId && (
                            <Select
                                label={t('admin.membershipRole')}
                                data={ROLE_OPTIONS}
                                value={role}
                                onChange={setRole}
                            />
                        )}
                    </>
                )}

                {/* Edit mode: membership management */}
                {isEdit && (
                    <>
                        <Divider
                            label={
                                <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.5px' }}>
                                    {t('admin.userTenants', 'Tenant Atamaları')}
                                </Text>
                            }
                            labelPosition="left"
                        />

                        {/* Current memberships */}
                        {(user.memberships || []).length === 0 ? (
                            <Text size="sm" c="dimmed">{t('admin.noMemberships', 'Henüz tenant atanmamış')}</Text>
                        ) : (
                            <Stack gap={6}>
                                {(user.memberships || []).map((m) => (
                                    <Paper key={m.id} px="sm" py={6} radius="md" withBorder
                                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                                    >
                                        <Group gap="xs">
                                            <Text size="sm" fw={500}>{m.tenant_name}</Text>
                                            <Badge size="xs" variant="light" color={ROLE_COLORS[m.role] || 'gray'}>
                                                {m.role}
                                            </Badge>
                                            {!m.is_active && (
                                                <Badge size="xs" variant="outline" color="red">
                                                    {t('admin.tenantInactive', 'Pasif')}
                                                </Badge>
                                            )}
                                        </Group>
                                        <Tooltip label={t('admin.removeMembership', 'Kaldır')} withArrow>
                                            <ActionIcon
                                                variant="subtle"
                                                color="red"
                                                size="sm"
                                                loading={removeMembershipMutation.isPending}
                                                onClick={() => {
                                                    if (window.confirm(t('admin.membershipRemoveConfirm', `${m.tenant_name} tenant ataması kaldırılsın mı?`))) {
                                                        removeMembershipMutation.mutate(m.id);
                                                    }
                                                }}
                                            >
                                                <IconTrash size={14} />
                                            </ActionIcon>
                                        </Tooltip>
                                    </Paper>
                                ))}
                            </Stack>
                        )}

                        {/* Add new membership */}
                        {availableTenantOptions.length > 0 && (
                            <Paper px="sm" py="xs" radius="md" withBorder bg="var(--mantine-color-default-hover)">
                                <Group gap="sm" align="flex-end">
                                    <Select
                                        label={t('admin.addTenant', 'Tenant Ekle')}
                                        placeholder={t('admin.tenantSelectPlaceholder', 'Tenant seçin')}
                                        data={availableTenantOptions}
                                        value={addTenantId}
                                        onChange={setAddTenantId}
                                        searchable
                                        style={{ flex: 1 }}
                                        size="xs"
                                    />
                                    <Select
                                        label={t('admin.membershipRole', 'Rol')}
                                        data={ROLE_OPTIONS}
                                        value={addRole}
                                        onChange={setAddRole}
                                        size="xs"
                                        w={150}
                                    />
                                    <Button
                                        size="xs"
                                        leftSection={<IconPlus size={14} />}
                                        disabled={!canAddMembership}
                                        loading={addMembershipMutation.isPending}
                                        onClick={() => addMembershipMutation.mutate()}
                                    >
                                        {t('common.add', 'Ekle')}
                                    </Button>
                                </Group>
                            </Paper>
                        )}
                    </>
                )}

                {/* Save button */}
                <Group justify="flex-end" mt="sm">
                    <Button variant="subtle" onClick={onClose}>{t('common.cancel')}</Button>
                    <Button
                        onClick={() => saveMutation.mutate()}
                        loading={saveMutation.isPending}
                        disabled={!canSubmitUser}
                    >
                        {isEdit ? t('common.save') : t('admin.createUser')}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
}
