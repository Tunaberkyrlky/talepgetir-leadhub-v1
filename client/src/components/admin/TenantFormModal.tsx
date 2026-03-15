import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal, TextInput, Select, Switch, Stack, Button, Group } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';

interface Tenant {
    id: string;
    name: string;
    slug: string;
    tier: string;
    is_active: boolean;
}

interface TenantFormModalProps {
    opened: boolean;
    onClose: () => void;
    tenant?: Tenant | null;
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim();
}

export default function TenantFormModal({ opened, onClose, tenant }: TenantFormModalProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const isEdit = !!tenant;

    const [name, setName] = useState('');
    const [slug, setSlug] = useState('');
    const [tier, setTier] = useState<string | null>('basic');
    const [isActive, setIsActive] = useState(true);
    const [autoSlug, setAutoSlug] = useState(true);

    useEffect(() => {
        if (opened) {
            setName(tenant?.name || '');
            setSlug(tenant?.slug || '');
            setTier(tenant?.tier || 'basic');
            setIsActive(tenant?.is_active !== false);
            setAutoSlug(!isEdit);
        }
    }, [opened, tenant, isEdit]);

    const handleNameChange = (value: string) => {
        setName(value);
        if (autoSlug && !isEdit) {
            setSlug(slugify(value));
        }
    };

    const handleSlugChange = (value: string) => {
        setAutoSlug(false);
        setSlug(value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
    };

    const tierOptions = [
        { value: 'basic', label: 'Basic' },
        { value: 'pro', label: 'Pro' },
    ];

    const mutation = useMutation({
        mutationFn: async () => {
            if (isEdit) {
                return api.put(`/admin/tenants/${tenant.id}`, { name, slug, tier, is_active: isActive });
            } else {
                return api.post('/admin/tenants', { name, slug, tier, is_active: isActive });
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'tenants'] });
            notifications.show({
                message: isEdit ? t('admin.tenantUpdated') : t('admin.tenantCreated'),
                color: 'green',
            });
            onClose();
        },
        onError: (err: any) => {
            notifications.show({
                message: err.response?.data?.error || t('common.error'),
                color: 'red',
            });
        },
    });

    const canSubmit = name.trim().length > 0 && slug.length > 0;

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={isEdit ? t('admin.editTenant') : t('admin.createTenant')}
            size="md"
        >
            <Stack gap="md">
                <TextInput
                    label={t('admin.tenantName')}
                    placeholder="Acme Corp"
                    value={name}
                    onChange={(e) => handleNameChange(e.currentTarget.value)}
                    required
                />
                <TextInput
                    label={t('admin.tenantSlug')}
                    placeholder="acme-corp"
                    value={slug}
                    onChange={(e) => handleSlugChange(e.currentTarget.value)}
                    required
                    description={t('admin.slugDescription')}
                />
                <Select
                    label={t('admin.tenantTier')}
                    data={tierOptions}
                    value={tier}
                    onChange={setTier}
                />
                <Switch
                    label={t('admin.tenantActive')}
                    checked={isActive}
                    onChange={(e) => setIsActive(e.currentTarget.checked)}
                />
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
