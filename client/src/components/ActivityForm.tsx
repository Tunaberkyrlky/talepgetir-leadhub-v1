import { useEffect } from 'react';
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
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import type { Activity } from '../types/activity';

interface ActivityFormProps {
    opened: boolean;
    onClose: () => void;
    companyId: string;
    contactId?: string;
    activity?: Activity | null; // null/undefined = create mode
}

export default function ActivityForm({ opened, onClose, companyId, contactId, activity }: ActivityFormProps) {
    const { t } = useTranslation();
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
        },
        validate: {
            summary: (v: string) => (v.trim() ? null : t('activity.summary') + ' is required'),
            occurred_at: (value) => {
                if (!value) return 'Lütfen geçerli bir tarih ve saat seçin';
                const date = new Date(value);
                if (isNaN(date.getTime())) return 'Geçersiz tarih formatı, lütfen tekrar seçin';
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
                });
            } else {
                form.reset();
                form.setFieldValue('occurred_at', new Date());
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened, activity]);

    const createMutation = useMutation({
        mutationFn: async (values: typeof form.values) => {
            const res = await api.post('/activities', {
                company_id: companyId,
                contact_id: contactId || null,
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

    const typeOptions = [
        { value: 'not', label: t('activity.types.not') },
        { value: 'meeting', label: t('activity.types.meeting') },
        { value: 'follow_up', label: t('activity.types.follow_up') },
    ];

    const visibilityOptions = [
        { value: 'client', label: t('activity.visibility_options.client') },
        { value: 'internal', label: t('activity.visibility_options.internal') },
    ];

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={isEdit ? t('activity.updated') : t('activity.addActivity')}
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

                    <Select
                        label={t('activity.visibility')}
                        data={visibilityOptions}
                        radius="md"
                        {...form.getInputProps('visibility')}
                    />

                    <DateTimePicker
                        label="Date & Time"
                        radius="md"
                        valueFormat="DD MMM YYYY HH:mm"
                        {...form.getInputProps('occurred_at')}
                    />

                    <Group justify="flex-end" mt="sm">
                        <Button variant="default" radius="md" onClick={onClose}>
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
    );
}
