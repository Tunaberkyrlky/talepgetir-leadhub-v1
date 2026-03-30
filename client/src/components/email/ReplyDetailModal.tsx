import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
    Modal, Paper, Group, Stack, Text, Badge, Select, Button, Divider,
    SimpleGrid,
} from '@mantine/core';
import {
    IconMail, IconMailOpened, IconSparkles,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';
import { useStages } from '../../contexts/StagesContext';
import AssignCompanyForm from './AssignCompanyForm';
import type { EmailReply } from '../../types/emailReply';

interface ReplyDetailModalProps {
    reply: EmailReply | null;
    opened: boolean;
    onClose: () => void;
}

export default function ReplyDetailModal({ reply, opened, onClose }: ReplyDetailModalProps) {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { stageOptions } = useStages();

    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';

    const [selectedStage, setSelectedStage] = useState<string | null>(null);

    const isMatched = !!reply?.company_id;

    // ── Stage update mutation ──
    const stageUpdateMutation = useMutation({
        mutationFn: async (newStage: string) => {
            return (await api.put(`/companies/${reply!.company_id}`, { stage: newStage })).data;
        },
        onSuccess: () => {
            showSuccess(t('emailReplies.stageUpdated'));
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['companies'] });
            setSelectedStage(null);
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    // ── Read toggle mutation ──
    const readToggleMutation = useMutation({
        mutationFn: async () => {
            const newStatus = reply!.read_status === 'read' ? false : true;
            return (await api.patch(`/email-replies/${reply!.id}/read`, { read: newStatus })).data;
        },
        onSuccess: () => {
            showSuccess(t('emailReplies.readStatusUpdated'));
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['email-replies-stats'] });
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    const formatDate = (iso: string) => {
        return new Date(iso).toLocaleDateString(locale, {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    if (!reply) return null;

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={t('emailReplies.detail.title')}
            size="lg"
            radius="lg"
            centered
            overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
            styles={{ title: { fontWeight: 700, fontSize: '1.1rem' } }}
        >
            <Stack gap="md">
                {/* Header: Campaign badge + date */}
                <Group justify="space-between">
                    {reply.campaign_name ? (
                        <Badge size="lg" variant="light" color="blue">
                            {reply.campaign_name}
                        </Badge>
                    ) : (
                        <Badge size="lg" variant="light" color="gray">-</Badge>
                    )}
                    <Text size="sm" c="dimmed">
                        {formatDate(reply.replied_at)}
                    </Text>
                </Group>

                {/* Info grid: Sender | Company | Contact */}
                <SimpleGrid cols={3}>
                    <div>
                        <Text size="xs" c="dimmed" fw={500}>
                            {t('emailReplies.detail.sender')}
                        </Text>
                        <Text size="sm" fw={500}>
                            {reply.sender_email}
                        </Text>
                    </div>
                    <div>
                        <Text size="xs" c="dimmed" fw={500}>
                            {t('emailReplies.detail.company')}
                        </Text>
                        {reply.company_id ? (
                            <Text
                                size="sm"
                                fw={500}
                                c="blue"
                                style={{ cursor: 'pointer' }}
                                onClick={() => {
                                    onClose();
                                    navigate(`/companies/${reply.company_id}`);
                                }}
                            >
                                {reply.company_name || '-'}
                            </Text>
                        ) : (
                            <Badge size="sm" variant="light" color="red">
                                {t('emailReplies.status.unmatched')}
                            </Badge>
                        )}
                    </div>
                    <div>
                        <Text size="xs" c="dimmed" fw={500}>
                            {t('emailReplies.detail.contact')}
                        </Text>
                        <Text size="sm" fw={500}>
                            {reply.contact_name || '-'}
                        </Text>
                    </div>
                </SimpleGrid>

                <Divider />

                {/* Reply body */}
                <div>
                    <Text size="xs" c="dimmed" fw={500} mb={4}>
                        {t('emailReplies.detail.replyBody')}
                    </Text>
                    <Paper
                        p="md"
                        radius="md"
                        withBorder
                        style={{
                            borderLeft: `4px solid var(--mantine-color-${isMatched ? 'blue' : 'orange'}-5)`,
                            maxHeight: 300,
                            overflowY: 'auto',
                            whiteSpace: 'pre-wrap',
                        }}
                    >
                        <Text size="sm">
                            {reply.reply_body || '-'}
                        </Text>
                    </Paper>
                </div>

                <Divider />

                {/* Actions */}
                <Text size="xs" c="dimmed" fw={500}>
                    {t('emailReplies.detail.actions')}
                </Text>

                {isMatched ? (
                    <Stack gap="sm">
                        {/* Stage Update */}
                        <Group gap="sm" align="flex-end">
                            <Select
                                label={t('emailReplies.actions.updateStage')}
                                placeholder={t('emailReplies.actions.updateStage')}
                                data={stageOptions}
                                value={selectedStage}
                                onChange={setSelectedStage}
                                clearable
                                style={{ flex: 1 }}
                            />
                            <Button
                                onClick={() => {
                                    if (selectedStage) stageUpdateMutation.mutate(selectedStage);
                                }}
                                loading={stageUpdateMutation.isPending}
                                disabled={!selectedStage}
                                radius="md"
                            >
                                {t('emailReplies.actions.update')}
                            </Button>
                        </Group>

                        {/* Read/Unread toggle */}
                        <Button
                            variant="light"
                            color={reply.read_status === 'read' ? 'gray' : 'blue'}
                            leftSection={reply.read_status === 'read'
                                ? <IconMailOpened size={16} />
                                : <IconMail size={16} />
                            }
                            onClick={() => readToggleMutation.mutate()}
                            loading={readToggleMutation.isPending}
                            radius="md"
                        >
                            {reply.read_status === 'read'
                                ? t('emailReplies.actions.markUnread')
                                : t('emailReplies.actions.markRead')
                            }
                        </Button>

                        {/* AI Category placeholder */}
                        <Button
                            variant="light"
                            color="gray"
                            leftSection={<IconSparkles size={16} />}
                            disabled
                            radius="md"
                        >
                            {t('emailReplies.aiCategory.title')} — {t('emailReplies.aiCategory.comingSoon')}
                        </Button>
                    </Stack>
                ) : (
                    /* Unmatched: show assign form */
                    <AssignCompanyForm
                        replyId={reply.id}
                        onAssigned={onClose}
                    />
                )}
            </Stack>
        </Modal>
    );
}
