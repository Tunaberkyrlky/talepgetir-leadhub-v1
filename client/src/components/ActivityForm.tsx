import { useEffect, useState } from 'react';
import { useForm } from '@mantine/form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Modal,
    Select,
    TextInput,
    Textarea,
    Button,
    Stack,
    Group,
    Text,
    Alert,
    Collapse,
    UnstyledButton,
} from '@mantine/core';
import { IconAlertCircle, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { DateTimePicker } from '@mantine/dates';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import { useAuth } from '../contexts/AuthContext';
import { isInternal } from '../lib/permissions';
import type { Activity, ActivityType } from '../types/activity';

interface ActivityFormProps {
    opened: boolean;
    onClose: () => void;
    companyId: string;
    contactId?: string;
    contacts?: { id: string; first_name: string; last_name?: string | null }[];
    activity?: Activity | null; // null/undefined = create mode
    inline?: boolean; // render inside Collapse instead of Modal
}

const TYPE_CONFIG: { value: ActivityType; emoji: string; labelKey: string; showDate: boolean }[] = [
    { value: 'follow_up', emoji: '\u{1F4DE}', labelKey: 'activity.types.follow_up', showDate: true },
    { value: 'meeting',   emoji: '\u{1F91D}', labelKey: 'activity.types.meeting',   showDate: true },
    { value: 'not',       emoji: '\u{1F4DD}', labelKey: 'activity.types.not',       showDate: false },
];

export default function ActivityForm({ opened, onClose, companyId, contactId, contacts, activity, inline }: ActivityFormProps) {
    const { t } = useTranslation();
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const isEdit = !!activity;

    const [moreOpen, setMoreOpen] = useState(false);

    const form = useForm({
        initialValues: {
            type: 'follow_up' as string,
            summary: '',
            detail: '',
            outcome: '',
            visibility: 'client' as string,
            occurred_at: new Date(),
            contact_id: '' as string,
        },
        validate: {
            summary: (v: string) => (v.trim() ? null : t('validation.required', { field: t('activity.summary') })),
            occurred_at: (value, values) => {
                const cfg = TYPE_CONFIG.find(tc => tc.value === values.type);
                if (!cfg?.showDate && !isEdit) return null;
                if (!value) return t('activity.dateRequired');
                const date = new Date(value);
                if (isNaN(date.getTime())) return t('activity.invalidDate');
                return null;
            },
        },
    });

    const currentType = form.values.type;
    const showDate = TYPE_CONFIG.find(tc => tc.value === currentType)?.showDate ?? false;

    // When a future date is picked, auto-set time to 09:00 if it's still at midnight
    const handleDateChange = (value: Date | string | null) => {
        if (!value) return;
        const date = typeof value === 'string' ? new Date(value) : value;
        if (isNaN(date.getTime())) return;
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();
        const isFuture = date.getTime() > now.getTime();
        // If user picked a future day and time is 00:00 (default from date picker), set to 09:00
        if (!isToday && isFuture && date.getHours() === 0 && date.getMinutes() === 0) {
            date.setHours(9, 0, 0, 0);
        }
        form.setFieldValue('occurred_at', date);
    };

    useEffect(() => {
        if (opened) {
            setMoreOpen(false);
            if (activity) {
                form.setValues({
                    type: activity.type,
                    summary: activity.summary,
                    detail: activity.detail || '',
                    outcome: activity.outcome || '',
                    visibility: activity.visibility,
                    occurred_at: new Date(activity.occurred_at),
                    contact_id: activity?.contact_id || contactId || '',
                });
                form.resetDirty();
                if (activity.detail || activity.outcome) setMoreOpen(true);
            } else {
                form.reset();
                form.setFieldValue('type', 'follow_up');
                form.setFieldValue('occurred_at', new Date());
                form.setFieldValue('contact_id', contactId || '');
                form.resetDirty();
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened, activity]);

    const createMutation = useMutation({
        mutationFn: async (values: typeof form.values) => {
            const cfg = TYPE_CONFIG.find(tc => tc.value === values.type);
            const res = await api.post('/activities', {
                company_id: companyId,
                contact_id: contacts ? (values.contact_id || null) : (contactId || null),
                type: values.type,
                summary: values.summary,
                detail: values.detail || null,
                outcome: values.outcome || null,
                visibility: values.visibility,
                occurred_at: cfg?.showDate ? new Date(values.occurred_at).toISOString() : new Date().toISOString(),
            });
            return res.data;
        },
        onSuccess: () => {
            showSuccess(t('activity.created'));
            queryClient.invalidateQueries({ queryKey: ['activities', companyId] });
            onClose();
            form.reset();
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    const updateMutation = useMutation({
        mutationFn: async (values: typeof form.values) => {
            const res = await api.put(`/activities/${activity!.id}`, {
                contact_id: contacts ? (values.contact_id || null) : (contactId || null),
                summary: values.summary,
                detail: values.detail || null,
                outcome: values.outcome || null,
                visibility: values.visibility,
                occurred_at: new Date(values.occurred_at).toISOString(),
            });
            return res.data;
        },
        onSuccess: () => {
            showSuccess(t('activity.updated'));
            queryClient.invalidateQueries({ queryKey: ['activities', companyId] });
            onClose();
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    const handleSubmit = form.onSubmit((values) => {
        if (isEdit) {
            updateMutation.mutate(values);
        } else {
            createMutation.mutate(values);
        }
    });

    const isSaving = createMutation.isPending || updateMutation.isPending;

    const [confirmOpen, setConfirmOpen] = useState(false);

    const visibilityOptions = [
        { value: 'client', label: t('activity.visibility_options.client') },
        ...(isInternal(user?.role || '') ? [{ value: 'internal', label: t('activity.visibility_options.internal') }] : []),
    ];

    const handleClose = () => {
        if (form.isDirty()) {
            setConfirmOpen(true);
            return;
        }
        onClose();
    };

    const handleConfirmDiscard = () => {
        setConfirmOpen(false);
        onClose();
    };

    const formContent = (
        <form onSubmit={handleSubmit}>
            <Stack gap="sm">
                {/* Type chips */}
                {!isEdit && (
                    <Group gap={6}>
                        {TYPE_CONFIG.map(({ value, emoji, labelKey }) => (
                            <Button
                                key={value}
                                size="xs"
                                variant={currentType === value ? 'filled' : 'default'}
                                color="violet"
                                radius="xl"
                                fw={currentType === value ? 600 : 400}
                                onClick={() => form.setFieldValue('type', value)}
                            >
                                {emoji} {t(labelKey)}
                            </Button>
                        ))}
                    </Group>
                )}

                {/* Summary — always visible */}
                <Textarea
                    placeholder={t('activity.summaryPlaceholder')}
                    required
                    radius="md"
                    autosize
                    minRows={2}
                    maxRows={5}
                    styles={{ input: { fontSize: 14 } }}
                    {...form.getInputProps('summary')}
                />

                {/* Date — only for meeting/follow_up */}
                {(showDate || isEdit) && (
                    <DateTimePicker
                        label={t('activity.dateTime')}
                        radius="md"
                        size="sm"
                        valueFormat="DD MMM YYYY HH:mm"
                        value={form.values.occurred_at}
                        onChange={handleDateChange}
                        error={form.errors.occurred_at}
                    />
                )}

                {/* More fields toggle */}
                <UnstyledButton onClick={() => setMoreOpen(v => !v)}>
                    <Group gap={4}>
                        {moreOpen ? <IconChevronDown size={14} color="gray" /> : <IconChevronRight size={14} color="gray" />}
                        <Text size="xs" c="dimmed">{t('activity.moreFields')}</Text>
                    </Group>
                </UnstyledButton>

                <Collapse in={moreOpen}>
                    <Stack gap="sm">
                        {contacts && contacts.length > 0 && (
                            <Select
                                label={t('activities.contact')}
                                placeholder={t('activities.selectContact')}
                                size="sm"
                                data={contacts.map(c => ({
                                    value: c.id,
                                    label: [c.first_name, c.last_name].filter(Boolean).join(' '),
                                }))}
                                value={form.values.contact_id || null}
                                onChange={(v) => form.setFieldValue('contact_id', v || '')}
                                clearable
                                searchable
                            />
                        )}

                        <TextInput
                            label={t('activity.detail')}
                            size="sm"
                            radius="md"
                            {...form.getInputProps('detail')}
                        />

                        <TextInput
                            label={t('activity.outcome')}
                            size="sm"
                            radius="md"
                            {...form.getInputProps('outcome')}
                        />

                        {isInternal(user?.role || '') && (
                            <Select
                                label={t('activity.visibility')}
                                data={visibilityOptions}
                                size="sm"
                                radius="md"
                                {...form.getInputProps('visibility')}
                            />
                        )}
                    </Stack>
                </Collapse>

                <Group justify="flex-end" mt="xs">
                    <Button variant="default" radius="md" size="sm" onClick={inline ? onClose : handleClose}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        radius="md"
                        size="sm"
                        gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                        variant="gradient"
                        loading={isSaving}
                    >
                        {t('common.save')}
                    </Button>
                </Group>
            </Stack>
        </form>
    );

    // Inline mode: render inside a styled box (for embedding in panels)
    if (inline) {
        return (
            <Collapse in={opened}>
                <Stack gap={0} mx={24} mb={12} style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                    <Group
                        px={14} py={10}
                        style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}
                        justify="space-between"
                    >
                        <Text size="xs" fw={600} c="#334155">
                            {isEdit ? t('activity.editActivity') : t('activity.addActivity')}
                        </Text>
                    </Group>
                    <Stack p={14} style={{ background: '#fff' }} gap={0}>
                        {formContent}
                    </Stack>
                </Stack>
            </Collapse>
        );
    }

    // Modal mode (default)
    return (
        <>
        <Modal
            opened={opened}
            onClose={handleClose}
            title={isEdit ? t('activity.editActivity') : t('activity.addActivity')}
            size="md"
            radius="lg"
            centered
            overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
            styles={{ title: { fontWeight: 700, fontSize: '1.1rem' } }}
        >
            {formContent}
        </Modal>

        <Modal
            opened={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            title={t('common.unsavedChangesTitle')}
            radius="lg"
            centered
            size="sm"
            overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
            styles={{ title: { fontWeight: 700, fontSize: '1.1rem' } }}
            zIndex={1000}
        >
            <Stack gap="md">
                <Alert icon={<IconAlertCircle size={16} />} color="orange" variant="light">
                    <Text size="sm">
                        {t('common.unsavedChanges')}
                    </Text>
                </Alert>
                <Group justify="flex-end">
                    <Button variant="default" radius="md" onClick={() => setConfirmOpen(false)}>
                        {t('common.stayEditing')}
                    </Button>
                    <Button color="red" radius="md" onClick={handleConfirmDiscard}>
                        {t('common.discardChanges')}
                    </Button>
                </Group>
            </Stack>
        </Modal>
        </>
    );
}
