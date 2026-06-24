import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal, TextInput, Select, Switch, Stack, Button, Group, Chip, Text } from '@mantine/core';
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
    const { t, i18n } = useTranslation();
    const queryClient = useQueryClient();
    const isEdit = !!tenant;

    const [name, setName] = useState('');
    const [slug, setSlug] = useState('');
    const [tier, setTier] = useState<string | null>('basic');
    const [isActive, setIsActive] = useState(true);
    const [dailyDigestEnabled, setDailyDigestEnabled] = useState(false);
    const [digestDays, setDigestDays] = useState<string[]>(['1', '4']);
    const [autoSlug, setAutoSlug] = useState(true);

    useEffect(() => {
        if (opened) {
            setName(tenant?.name || '');
            setSlug(tenant?.slug || '');
            setTier(tenant?.tier || 'basic');
            setIsActive(tenant?.is_active !== false);
            setDailyDigestEnabled(Boolean((tenant?.settings as Record<string, unknown>)?.daily_digest_enabled));
            const dd = (tenant?.settings as Record<string, unknown>)?.digest_days;
            setDigestDays(Array.isArray(dd) && dd.length ? dd.map((d) => String(d)) : ['1', '4']);
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

    // Weekday short label from the current i18n locale (0=Sun … 6=Sat). 2024-01-07 is a Sunday.
    const dayLabel = (wd: number) =>
        new Intl.DateTimeFormat(i18n.language, { weekday: 'short' }).format(new Date(2024, 0, 7 + wd));

    const mutation = useMutation({
        mutationFn: async () => {
            if (isEdit) {
                // Preserve other settings keys (cc_addresses, custom_field labels...) — only merge our key.
                const mergedSettings = {
                    ...(tenant.settings as Record<string, unknown> ?? {}),
                    daily_digest_enabled: dailyDigestEnabled,
                    digest_days: digestDays.map(Number).sort((a, b) => a - b),
                };
                return api.put(`/admin/tenants/${tenant.id}`, {
                    name, slug, tier, is_active: isActive, settings: mergedSettings,
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
                {isEdit && dailyDigestEnabled && (
                    <Stack gap={4}>
                        <Text size="sm" fw={500}>{t('admin.digestDays')}</Text>
                        <Text size="xs" c="dimmed">{t('admin.digestDaysDescription')}</Text>
                        <Chip.Group multiple value={digestDays} onChange={setDigestDays}>
                            <Group gap="xs" mt={4}>
                                {[1, 2, 3, 4, 5, 6, 0].map((wd) => (
                                    <Chip key={wd} value={String(wd)} size="sm">{dayLabel(wd)}</Chip>
                                ))}
                            </Group>
                        </Chip.Group>
                    </Stack>
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
