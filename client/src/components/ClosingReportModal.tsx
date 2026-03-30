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
    Text,
    Alert,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import type { ClosingOutcome } from '../types/activity';

interface ClosingReportModalProps {
    opened: boolean;
    onClose: () => void;         // iptal → stage değişmez
    companyId: string;
    companyName: string;
    targetStage: ClosingOutcome; // hangi terminal stage'e gidiliyor (pre-selected)
    onSuccess: () => void;       // rapor kaydedildi → cache invalidate
}

export default function ClosingReportModal({
    opened,
    onClose,
    companyId,
    companyName,
    targetStage,
    onSuccess,
}: ClosingReportModalProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();

    const form = useForm({
        initialValues: {
            outcome: targetStage as string,
            summary: '',
            detail: '',
            visibility: 'client',
        },
        validate: {
            outcome: (v: string) => (v ? null : t('validation.required', { field: t('activity.closingReport.outcomeLabel') })),
            summary: (v: string) => (v.trim() ? null : t('validation.required', { field: t('activity.summary') })),
        },
    });

    // targetStage değiştiğinde form'u resetle
    useEffect(() => {
        if (opened) {
            form.setValues({
                outcome: targetStage,
                summary: '',
                detail: '',
                visibility: 'client',
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened, targetStage]);

    const mutation = useMutation({
        mutationFn: async (values: typeof form.values) => {
            const res = await api.post('/activities/closing-report', {
                company_id: companyId,
                outcome: values.outcome,
                summary: values.summary,
                detail: values.detail || null,
                visibility: values.visibility,
            });
            return res.data;
        },
        onSuccess: () => {
            showSuccess(t('activity.created'));
            queryClient.invalidateQueries({ queryKey: ['pipeline'] });
            queryClient.invalidateQueries({ queryKey: ['companies'] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            queryClient.invalidateQueries({ queryKey: ['activities'] });
            onSuccess();
            onClose();
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    const handleSubmit = form.onSubmit((values) => {
        mutation.mutate(values);
    });

    const outcomeOptions = [
        { value: 'won', label: t('activity.closingReport.won') },
        { value: 'lost', label: t('activity.closingReport.lost') },
        { value: 'on_hold', label: t('activity.closingReport.on_hold') },
        { value: 'cancelled', label: t('activity.closingReport.cancelled') },
    ];

    const visibilityOptions = [
        { value: 'client', label: t('activity.visibility_options.client') },
        { value: 'internal', label: t('activity.visibility_options.internal') },
    ];

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={t('activity.closingReport.title')}
            size="md"
            radius="lg"
            centered
            overlayProps={{ backgroundOpacity: 0.45, blur: 4 }}
            styles={{ title: { fontWeight: 700, fontSize: '1.1rem' } }}
        >
            <Alert
                icon={<IconAlertTriangle size={16} />}
                color="orange"
                variant="light"
                mb="md"
                radius="md"
            >
                <Text size="sm" fw={500}>{companyName}</Text>
                <Text size="xs" c="dimmed" mt={2}>{t('activity.closingReport.required')}</Text>
            </Alert>

            <form onSubmit={handleSubmit}>
                <Stack gap="md">
                    <Select
                        label={t('activity.closingReport.outcomeLabel')}
                        data={outcomeOptions}
                        required
                        radius="md"
                        {...form.getInputProps('outcome')}
                    />

                    <TextInput
                        label={t('activity.closingReport.summaryLabel')}
                        placeholder={t('activity.summary')}
                        required
                        radius="md"
                        {...form.getInputProps('summary')}
                    />

                    <Textarea
                        label={t('activity.closingReport.reasonLabel')}
                        placeholder={t('activity.detail')}
                        autosize
                        minRows={2}
                        radius="md"
                        {...form.getInputProps('detail')}
                    />

                    <Select
                        label={t('activity.visibility')}
                        data={visibilityOptions}
                        radius="md"
                        {...form.getInputProps('visibility')}
                    />

                    <Group justify="flex-end" mt="sm">
                        <Button variant="default" radius="md" onClick={onClose}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            type="submit"
                            radius="md"
                            color="orange"
                            loading={mutation.isPending}
                        >
                            {t('common.save')}
                        </Button>
                    </Group>
                </Stack>
            </form>
        </Modal>
    );
}
