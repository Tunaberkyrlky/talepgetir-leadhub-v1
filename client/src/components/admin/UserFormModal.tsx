import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal, TextInput, PasswordInput, Select, Stack, Button, Group } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';

interface UserFormModalProps {
    opened: boolean;
    onClose: () => void;
    user?: { id: string; email: string } | null;
}

export default function UserFormModal({ opened, onClose, user }: UserFormModalProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const isEdit = !!user;

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [tenantId, setTenantId] = useState<string | null>(null);
    const [role, setRole] = useState<string | null>(null);

    useEffect(() => {
        if (opened) {
            setEmail(user?.email || '');
            setPassword('');
            setTenantId(null);
            setRole(null);
        }
    }, [opened, user]);

    // Fetch tenants for the select
    const { data: tenantsData } = useQuery({
        queryKey: ['admin', 'tenants', 'all'],
        queryFn: async () => {
            const res = await api.get('/admin/tenants?limit=100');
            return res.data;
        },
        enabled: opened && !isEdit,
    });

    const tenantOptions = (tenantsData?.data || []).map((tn: any) => ({
        value: tn.id,
        label: `${tn.name} (${tn.tier})`,
    }));

    const roleOptions = [
        { value: 'superadmin', label: 'Superadmin' },
        { value: 'ops_agent', label: 'Ops Agent' },
        { value: 'client_admin', label: 'Client Admin' },
        { value: 'client_viewer', label: 'Client Viewer' },
    ];

    const mutation = useMutation({
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
            showSuccess(isEdit ? t('admin.userUpdated') : t('admin.userCreated'));
            onClose();
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    const canSubmit = isEdit
        ? (email !== user?.email || password.length > 0)
        : (email.length > 0 && password.length >= 8 && (!tenantId || !!role));

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={isEdit ? t('admin.editUser') : t('admin.createUser')}
            size="md"
        >
            <Stack gap="md">
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
                {!isEdit && (
                    <>
                        <Select
                            label={t('admin.tenantSelect')}
                            placeholder={t('admin.tenantSelectPlaceholder')}
                            data={tenantOptions}
                            value={tenantId}
                            onChange={setTenantId}
                            clearable
                            searchable
                        />
                        {tenantId && (
                            <Select
                                label={t('admin.membershipRole')}
                                data={roleOptions}
                                value={role}
                                onChange={setRole}
                            />
                        )}
                    </>
                )}
                <Group justify="flex-end" mt="sm">
                    <Button variant="subtle" onClick={onClose}>{t('common.cancel')}</Button>
                    <Button
                        onClick={() => mutation.mutate()}
                        loading={mutation.isPending}
                        disabled={!canSubmit}
                    >
                        {t('common.save')}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
}
