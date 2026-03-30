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
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { DateTimePicker } from '@mantine/dates';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import { useAuth } from '../contexts/AuthContext';
import { isInternal } from '../lib/permissions';
import type { Activity } from '../types/activity';

interface ActivityFormProps {
    opened: boolean;
    onClose: () => void;
    companyId: string;
    contactId?: string;
    contacts?: { id: string; first_name: string; last_name?: string | null }[];
    activity?: Activity | null; // null/undefined = create mode
}

export default function ActivityForm({ opened, onClose, companyId, contactId, contacts, activity }: ActivityFormProps) {
    const { t } = useTranslation();
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const isEdit = !!activity;

    const form = useForm({
        initialValues: {
            type: 'not' as string,
            summary: '',
            detail: '',
            outcome: '',
            visibility: 'client' as string,
            occurred_at: new Date(),
            contact_id: '' as string,
        },
        validate: {
            summary: (v: string) => (v.trim() ? null : t('validation.required', { field: t('activity.summary') })),
            occurred_at: (value) => {
                if (!value) return t('activity.dateRequired');
                const date = new Date(value);
                if (isNaN(date.getTime())) return t('activity.invalidDate');
                return null;
            },
        },
    });

    useEffect(() => {
        if (opened) {
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
            } else {
                form.reset();
                form.setFieldValue('occurred_at', new Date());
                form.setFieldValue('contact_id', contactId || '');
                form.resetDirty();
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened, activity]);

    const createMutation = useMutation({
        mutationFn: async (values: typeof form.values) => {
            const res = await api.post('/activities', {
                company_id: companyId,
                contact_id: contacts ? (form.values.contact_id || null) : (contactId || null),
                type: values.type,
                summary: values.summary,
                detail: values.detail || null,
                outcome: values.outcome || null,
                visibility: values.visibility,
                occurred_at: new Date(values.occurred_at).toISOString(),
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

    const typeOptions = [
        { value: 'not', label: t('activity.types.not') },
        { value: 'meeting', label: t('activity.types.meeting') },
        { value: 'follow_up', label: t('activity.types.follow_up') },
    ];

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
            <form onSubmit={handleSubmit}>
                <Stack gap="md">
                    {!isEdit && (
                        <Select
                            label={t('activity.type')}
                            data={typeOptions}
                            required
                            radius="md"
                            {...form.getInputProps('type')}
                        />
                    )}

                    {contacts && contacts.length > 0 && (
                        <Select
                            label={t('activities.contact')}
                            placeholder={t('activities.selectContact')}
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
                        label={t('activity.summary')}
                        required
                        radius="md"
                        {...form.getInputProps('summary')}
                    />

                    <Textarea
                        label={t('activity.detail')}
                        autosize
                        minRows={2}
                        radius="md"
                        {...form.getInputProps('detail')}
                    />

                    <TextInput
                        label={t('activity.outcome')}
                        radius="md"
                        {...form.getInputProps('outcome')}
                    />

                    {isInternal(user?.role || '') && (
                        <Select
                            label={t('activity.visibility')}
                            data={visibilityOptions}
                            radius="md"
                            {...form.getInputProps('visibility')}
                        />
                    )}

                    <DateTimePicker
                        label={t('activity.dateTime')}
                        radius="md"
                        valueFormat="DD MMM YYYY HH:mm"
                        {...form.getInputProps('occurred_at')}
                    />

                    <Group justify="flex-end" mt="sm">
                        <Button variant="default" radius="md" onClick={handleClose}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            type="submit"
                            radius="md"
                            gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                            variant="gradient"
                            loading={isSaving}
                        >
                            {t('common.save')}
                        </Button>
                    </Group>
                </Stack>
            </form>
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
