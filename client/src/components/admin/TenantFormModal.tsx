import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal, TextInput, Select, Switch, Stack, Button, Group } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';

interface Tenant {
    id: string;
    name: string;
    slug: string;
    tier: string;
    is_active: boolean;
    settings?: Record<string, unknown> | null;
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
    const [dailyDigestEnabled, setDailyDigestEnabled] = useState(false);
    const [autoSlug, setAutoSlug] = useState(true);

    useEffect(() => {
        if (opened) {
            // The modal stays mounted; opening it is the reset boundary for its draft fields.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setName(tenant?.name || '');
            setSlug(tenant?.slug || '');
            setTier(tenant?.tier || 'basic');
            setIsActive(tenant?.is_active !== false);
            setDailyDigestEnabled(tenant?.settings?.daily_digest_enabled === true);
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
                return api.put(`/admin/tenants/${tenant.id}`, {
                    name,
                    slug,
                    tier,
                    is_active: isActive,
                    settings: {
                        ...(tenant.settings ?? {}),
                        daily_digest_enabled: dailyDigestEnabled,
                    },
                });
            } else {
                return api.post('/admin/tenants', { name, slug, tier, is_active: isActive });
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin', 'tenants'] });
            showSuccess(isEdit ? t('admin.tenantUpdated') : t('admin.tenantCreated'));
            onClose();
        },
        onError: (err) => {
            showErrorFromApi(err);
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
                {isEdit && (
                    <Switch
                        label={t('admin.dailyDigestEnabled')}
                        description={t('admin.dailyDigestDescription')}
                        checked={dailyDigestEnabled}
                        onChange={(e) => setDailyDigestEnabled(e.currentTarget.checked)}
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
