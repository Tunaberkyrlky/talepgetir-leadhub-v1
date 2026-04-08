import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
    Modal, Stack, SegmentedControl, TextInput, Textarea, Button, Group, Text,
} from '@mantine/core';
import { IconBug, IconBulb } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';

interface FeedbackModalProps {
    opened: boolean;
    onClose: () => void;
    /** Pre-fill values (e.g. from error screens) */
    prefill?: {
        type?: 'bug_report' | 'feature_request';
        title?: string;
        description?: string;
    };
}

export default function FeedbackModal({ opened, onClose, prefill }: FeedbackModalProps) {
    const { t } = useTranslation();
    const [type, setType] = useState<string>(prefill?.type || 'bug_report');
    const [title, setTitle] = useState(prefill?.title || '');
    const [description, setDescription] = useState(prefill?.description || '');

    // Sync prefill when it changes (e.g. new error triggers modal)
    const [prevPrefill, setPrevPrefill] = useState(prefill);
    if (prefill !== prevPrefill) {
        setPrevPrefill(prefill);
        if (prefill) {
            if (prefill.type) setType(prefill.type);
            if (prefill.title) setTitle(prefill.title);
            if (prefill.description) setDescription(prefill.description);
        }
    }

    const submitMutation = useMutation({
        mutationFn: async () => {
            return (await api.post('/feedback', { type, title, description: description || undefined })).data;
        },
        onSuccess: () => {
            showSuccess(t('feedback.submitted'));
            setType('feature_request');
            setTitle('');
            setDescription('');
            onClose();
        },
        onError: (err) => {
            showErrorFromApi(err, t('feedback.errors.submitFailed'));
        },
    });

    const handleClose = () => {
        if (!submitMutation.isPending) {
            onClose();
        }
    };

    const handleSubmit = () => {
        if (title.trim() && !submitMutation.isPending) {
            submitMutation.mutate();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    return (
        <Modal
            opened={opened}
            onClose={handleClose}
            title={t('feedback.title')}
            size="md"
            radius="lg"
            centered
            overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
            styles={{ title: { fontWeight: 700, fontSize: '1.1rem' } }}
        >
            <Stack gap="md">
                <div>
                    <Text size="sm" fw={500} mb={4}>{t('feedback.typeLabel')}</Text>
                    <SegmentedControl
                        fullWidth
                        value={type}
                        onChange={setType}
                        data={[
                            {
                                value: 'bug_report',
                                label: (
                                    <Group gap={6} justify="center">
                                        <IconBug size={16} />
                                        <span>{t('feedback.types.bugReport')}</span>
                                    </Group>
                                ),
                            },
                            {
                                value: 'feature_request',
                                label: (
                                    <Group gap={6} justify="center">
                                        <IconBulb size={16} />
                                        <span>{t('feedback.types.featureRequest')}</span>
                                    </Group>
                                ),
                            },
                        ]}
                    />
                </div>

                <TextInput
                    label={t('feedback.titleLabel')}
                    placeholder={type === 'bug_report'
                        ? t('feedback.placeholders.bugTitle')
                        : t('feedback.placeholders.featureTitle')
                    }
                    value={title}
                    onChange={(e) => setTitle(e.currentTarget.value)}
                    onKeyDown={handleKeyDown}
                    required
                    maxLength={200}
                />

                <Textarea
                    label={t('feedback.descriptionLabel')}
                    placeholder={type === 'bug_report'
                        ? t('feedback.placeholders.bugDescription')
                        : t('feedback.placeholders.featureDescription')
                    }
                    value={description}
                    onChange={(e) => setDescription(e.currentTarget.value)}
                    minRows={3}
                    maxRows={6}
                    autosize
                    maxLength={2000}
                />

                <Button
                    onClick={handleSubmit}
                    loading={submitMutation.isPending}
                    disabled={!title.trim()}
                    fullWidth
                    radius="md"
                    color={type === 'bug_report' ? 'red' : 'violet'}
                >
                    {t('feedback.submit')}
                </Button>
            </Stack>
        </Modal>
    );
}
