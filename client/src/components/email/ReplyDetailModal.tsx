import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
    Modal, Paper, Group, Stack, Text, Badge, Select, Button, Divider,
    SimpleGrid, Anchor,
} from '@mantine/core';
import {
    IconMail, IconMailOpened, IconSparkles, IconTrash,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';
import { useAuth } from '../../contexts/AuthContext';
import { isInternal } from '../../lib/permissions';
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
    const { user } = useAuth();
    const { stageOptions } = useStages();
    const canDeleteReply = isInternal(user?.role || '');

    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';

    const [selectedStage, setSelectedStage] = useState<string | null>(null);
    // Local copy so modal reflects mutations without waiting for query refetch
    const [localReply, setLocalReply] = useState<EmailReply | null>(reply);

    // Sync when a new reply is selected
    if (reply?.id !== localReply?.id) {
        setLocalReply(reply);
        setSelectedStage(null);
    }

    const isMatched = !!localReply?.company_id;

    // ── Stage update mutation ──
    const stageUpdateMutation = useMutation({
        mutationFn: async (newStage: string) => {
            return (await api.put(`/companies/${localReply!.company_id}`, { stage: newStage })).data;
        },
        onSuccess: () => {
            showSuccess(t('emailReplies.stageUpdated'));
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['companies'] });
            setSelectedStage(null);
        },
        onError: (err) => {
            showErrorFromApi(err, t('emailReplies.errors.stageUpdateFailed'));
        },
    });

    // ── Delete mutation ──
    const [confirmDelete, setConfirmDelete] = useState(false);
    const deleteMutation = useMutation({
        mutationFn: async () => {
            await api.delete(`/email-replies/${localReply!.id}`);
        },
        onSuccess: () => {
            showSuccess(t('emailReplies.deleted'));
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['email-replies-stats'] });
            setConfirmDelete(false);
            onClose();
        },
        onError: (err) => {
            showErrorFromApi(err, t('emailReplies.errors.deleteFailed'));
            setConfirmDelete(false);
        },
    });

    // ── Read toggle mutation ──
    // Issue 5 (Option A): send explicit desired status — no server-side race condition
    const readToggleMutation = useMutation({
        mutationFn: async () => {
            const read_status = localReply!.read_status === 'read' ? 'unread' : 'read';
            return (await api.patch(`/email-replies/${localReply!.id}/read`, { read_status })).data;
        },
        onSuccess: (data: { id: string; read_status: string }) => {
            showSuccess(t('emailReplies.readStatusUpdated'));
            setLocalReply((prev) => prev ? { ...prev, read_status: data.read_status as EmailReply['read_status'] } : prev);
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['email-replies-stats'] });
        },
        onError: (err) => {
            showErrorFromApi(err, t('emailReplies.errors.readToggleFailed'));
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

    if (!localReply) return null;

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
                    {localReply.campaign_name ? (
                        <Badge size="lg" variant="light" color="blue">
                            {localReply.campaign_name}
                        </Badge>
                    ) : (
                        <Badge size="lg" variant="light" color="gray">-</Badge>
                    )}
                    <Text size="sm" c="dimmed">
                        {formatDate(localReply.replied_at)}
                    </Text>
                </Group>

                {/* Info grid: Sender | Company | Contact */}
                <SimpleGrid cols={3}>
                    <div>
                        <Text size="xs" c="dimmed" fw={500}>
                            {t('emailReplies.detail.sender')}
                        </Text>
                        <Text size="sm" fw={500}>
                            {localReply.sender_email}
                        </Text>
                    </div>
                    <div>
                        <Text size="xs" c="dimmed" fw={500}>
                            {t('emailReplies.detail.company')}
                        </Text>
                        {localReply.company_id ? (
                            <Anchor
                                size="sm"
                                fw={500}
                                href={`/companies/${localReply.company_id}`}
                                onClick={(e) => {
                                    e.preventDefault();
                                    onClose();
                                    navigate(`/companies/${localReply.company_id}`);
                                }}
                            >
                                {localReply.company_name || '-'}
                            </Anchor>
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
                            {localReply.contact_name || '-'}
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
                            {localReply.reply_body || '-'}
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
                            color={localReply.read_status === 'read' ? 'gray' : 'blue'}
                            leftSection={localReply.read_status === 'read'
                                ? <IconMailOpened size={16} />
                                : <IconMail size={16} />
                            }
                            onClick={() => readToggleMutation.mutate()}
                            loading={readToggleMutation.isPending}
                            radius="md"
                        >
                            {localReply.read_status === 'read'
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

                        {/* Delete */}
                        {canDeleteReply && (
                            confirmDelete ? (
                                <Group gap="sm">
                                    <Text size="sm" c="red" fw={500}>{t('emailReplies.actions.deleteConfirm')}</Text>
                                    <Button
                                        color="red"
                                        size="xs"
                                        loading={deleteMutation.isPending}
                                        onClick={() => deleteMutation.mutate()}
                                        radius="md"
                                    >
                                        {t('emailReplies.actions.confirmYes')}
                                    </Button>
                                    <Button
                                        variant="subtle"
                                        color="gray"
                                        size="xs"
                                        onClick={() => setConfirmDelete(false)}
                                        radius="md"
                                    >
                                        {t('emailReplies.actions.confirmNo')}
                                    </Button>
                                </Group>
                            ) : (
                                <Button
                                    variant="light"
                                    color="red"
                                    leftSection={<IconTrash size={16} />}
                                    onClick={() => setConfirmDelete(true)}
                                    radius="md"
                                >
                                    {t('emailReplies.actions.delete')}
                                </Button>
                            )
                        )}
                    </Stack>
                ) : (
                    /* Unmatched: show assign form + delete */
                    <Stack gap="sm">
                        <AssignCompanyForm
                            replyId={localReply.id}
                            onAssigned={onClose}
                        />
                        {canDeleteReply && (
                            <Divider />
                        )}
                        {canDeleteReply && (
                            confirmDelete ? (
                                <Group gap="sm">
                                    <Text size="sm" c="red" fw={500}>{t('emailReplies.actions.deleteConfirm')}</Text>
                                    <Button
                                        color="red"
                                        size="xs"
                                        loading={deleteMutation.isPending}
                                        onClick={() => deleteMutation.mutate()}
                                        radius="md"
                                    >
                                        {t('emailReplies.actions.confirmYes')}
                                    </Button>
                                    <Button
                                        variant="subtle"
                                        color="gray"
                                        size="xs"
                                        onClick={() => setConfirmDelete(false)}
                                        radius="md"
                                    >
                                        {t('emailReplies.actions.confirmNo')}
                                    </Button>
                                </Group>
                            ) : (
                                <Button
                                    variant="light"
                                    color="red"
                                    leftSection={<IconTrash size={16} />}
                                    onClick={() => setConfirmDelete(true)}
                                    radius="md"
                                >
                                    {t('emailReplies.actions.delete')}
                                </Button>
                            )
                        )}
                    </Stack>
                )}
            </Stack>
        </Modal>
    );
}
