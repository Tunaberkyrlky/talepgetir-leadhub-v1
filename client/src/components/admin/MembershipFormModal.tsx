import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal, Select, Switch, Stack, Button, Group } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';

interface Membership {
    id: string;
    user_id: string;
    user_email: string;
    tenant_id: string;
    tenant_name: string;
    role: string;
    is_active: boolean;
}

interface MembershipFormModalProps {
    opened: boolean;
    onClose: () => void;
    membership?: Membership | null;
}

export default function MembershipFormModal({ opened, onClose, membership }: MembershipFormModalProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const isEdit = !!membership;

    const [userId, setUserId] = useState<string | null>(null);
    const [tenantId, setTenantId] = useState<string | null>(null);
    const [role, setRole] = useState<string | null>('client_viewer');
    const [isActive, setIsActive] = useState(true);

    useEffect(() => {
        if (opened) {
            setUserId(membership?.user_id || null);
            setTenantId(membership?.tenant_id || null);
            setRole(membership?.role || 'client_viewer');
            setIsActive(membership?.is_active !== false);
        }
    }, [opened, membership]);

    // Fetch users for select
    const { data: usersData } = useQuery({
        queryKey: ['admin', 'users', 'all'],
        queryFn: async () => {
            const res = await api.get('/admin/users?limit=100');
            return res.data;
        },
        enabled: opened && !isEdit,
    });

    // Fetch tenants for select
    const { data: tenantsData } = useQuery({
        queryKey: ['admin', 'tenants', 'all'],
        queryFn: async () => {
            const res = await api.get('/admin/tenants?limit=100');
            return res.data;
        },
        enabled: opened && !isEdit,
    });

    const userOptions = (usersData?.data || []).map((u: any) => ({
        value: u.id,
        label: u.email,
    }));

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
                return api.put(`/admin/memberships/${membership.id}`, { role, is_active: isActive });
            } else {
                return api.post('/admin/memberships', { user_id: userId, tenant_id: tenantId, role });
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'memberships'] });
            queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
            showSuccess(isEdit ? t('admin.membershipUpdated') : t('admin.membershipCreated'));
            onClose();
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    const canSubmit = isEdit ? true : (userId && tenantId && role);

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={isEdit ? t('admin.editMembership') : t('admin.assignUser')}
            size="md"
        >
            <Stack gap="md">
                {!isEdit ? (
                    <>
                        <Select
                            label={t('admin.userEmail')}
                            data={userOptions}
                            value={userId}
                            onChange={setUserId}
                            searchable
                            required
                        />
                        <Select
                            label={t('admin.tenantSelect')}
                            data={tenantOptions}
                            value={tenantId}
                            onChange={setTenantId}
                            searchable
                            required
                        />
                    </>
                ) : null}
                <Select
                    label={t('admin.membershipRole')}
                    data={roleOptions}
                    value={role}
                    onChange={setRole}
                    required
                />
                {isEdit && (
                    <Switch
                        label={t('admin.membershipActive')}
                        checked={isActive}
                        onChange={(e) => setIsActive(e.currentTarget.checked)}
                    />
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
