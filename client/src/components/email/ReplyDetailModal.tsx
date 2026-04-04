import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
    Modal, Group, Stack, Text, Badge, Button, Anchor,
    Collapse, Textarea, Box, ActionIcon, Menu, Divider,
    Avatar, ScrollArea,
} from '@mantine/core';
import {
    IconMail, IconMailOpened, IconTrash, IconRefresh,
    IconExternalLink, IconPlus, IconChevronDown, IconX, IconCheck,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showWarning, showErrorFromApi } from '../../lib/notifications';
import { useAuth } from '../../contexts/AuthContext';
import { isInternal } from '../../lib/permissions';
import { useStages } from '../../contexts/StagesContext';
import AssignCompanyForm from './AssignCompanyForm';
import type { EmailReply } from '../../types/emailReply';
import type { ActivityType } from '../../types/activity';

interface ReplyDetailModalProps {
    reply: EmailReply | null;
    opened: boolean;
    onClose: () => void;
}

const ACTIVITY_TYPES: { value: ActivityType; emoji: string; labelKey: string }[] = [
    { value: 'follow_up', emoji: '📞', labelKey: 'activities.types.follow_up' },
    { value: 'meeting',   emoji: '🤝', labelKey: 'activities.types.meeting' },
    { value: 'not',       emoji: '📝', labelKey: 'activities.types.not' },
];

function getInitials(name: string | null, email: string): string {
    if (name) {
        const parts = name.trim().split(/\s+/);
        return parts.length >= 2
            ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
            : parts[0].slice(0, 2).toUpperCase();
    }
    return email.split('@')[0].slice(0, 2).toUpperCase();
}

export default function ReplyDetailModal({ reply, opened, onClose }: ReplyDetailModalProps) {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const { stageOptions } = useStages();
    const canDeleteReply = isInternal(user?.role || '');
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';

    const [localReply, setLocalReply] = useState<EmailReply | null>(reply);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [activityOpen, setActivityOpen] = useState(false);
    const [activityType, setActivityType] = useState<ActivityType>('follow_up');
    const [activityNote, setActivityNote] = useState('');
    const [assignOpen, setAssignOpen] = useState(false);

    // Sync when a new reply is selected
    if (reply?.id !== localReply?.id) {
        setLocalReply(reply);
        setConfirmDelete(false);
        setActivityOpen(false);
        setActivityNote('');
        setActivityType('follow_up');
        setAssignOpen(false);
    }

    const isMatched = !!localReply?.company_id;

    const formatDate = (iso: string) =>
        new Date(iso).toLocaleDateString(locale, {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });

    // ── Stage update ──
    const stageUpdateMutation = useMutation({
        mutationFn: async (newStage: string) =>
            (await api.put(`/companies/${localReply!.company_id}`, { stage: newStage })).data,
        onSuccess: () => {
            showSuccess(t('emailReplies.stageUpdated'));
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['companies'] });
        },
        onError: (err) => showErrorFromApi(err, t('emailReplies.errors.stageUpdateFailed')),
    });

    // ── Rematch ──
    const rematchMutation = useMutation({
        mutationFn: async () => (await api.post(`/email-replies/${localReply!.id}/rematch`)).data,
        onSuccess: (data: { id: string; match_status: string; company_id: string | null; contact_id: string | null }) => {
            if (data.match_status === 'matched') {
                showSuccess(t('emailReplies.rematch.success'));
            } else {
                showWarning(t('emailReplies.rematch.noMatch'));
            }
            setLocalReply((prev) => prev ? {
                ...prev,
                match_status: data.match_status as EmailReply['match_status'],
                company_id: data.company_id,
                contact_id: data.contact_id,
            } : prev);
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['email-replies-stats'] });
        },
        onError: (err) => showErrorFromApi(err, t('emailReplies.rematch.failed')),
    });

    // ── Delete ──
    const deleteMutation = useMutation({
        mutationFn: async () => { await api.delete(`/email-replies/${localReply!.id}`); },
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

    // ── Read toggle ──
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
        onError: (err) => showErrorFromApi(err, t('emailReplies.errors.readToggleFailed')),
    });

    // ── Quick activity ──
    const addActivityMutation = useMutation({
        mutationFn: async () => (await api.post('/activities', {
            company_id: localReply!.company_id,
            contact_id: localReply!.contact_id || null,
            type: activityType,
            summary: activityNote.trim(),
            visibility: 'client',
        })).data,
        onSuccess: () => {
            showSuccess(t('emailReplies.quickActivity.added'));
            setActivityOpen(false);
            setActivityNote('');
            setActivityType('follow_up');
            queryClient.invalidateQueries({ queryKey: ['activities'] });
        },
        onError: (err) => showErrorFromApi(err, t('emailReplies.quickActivity.failed')),
    });

    if (!localReply) return null;

    const initials = getInitials(localReply.contact_name, localReply.sender_email);
    const avatarColor = isMatched ? 'violet' : 'orange';

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            size="xl"
            radius="lg"
            centered
            withCloseButton={false}
            overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
            styles={{ body: { padding: 0, minHeight: 520 } }}
            aria-label={t('emailReplies.detail.title')}
        >
            {/* ── HEADER ─────────────────────────────────── */}
            <Box px={24} pt={22} pb={18}>
                <Group align="flex-start" gap={14} wrap="nowrap">
                    <Avatar
                        size={46}
                        radius="xl"
                        color={avatarColor}
                        variant="filled"
                        style={{ flexShrink: 0 }}
                    >
                        {initials}
                    </Avatar>

                    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                        <Text fw={600} size="sm" c="#0f0f20" truncate>
                            {localReply.contact_name || localReply.sender_email.split('@')[0]}
                        </Text>
                        <Text size="xs" c="dimmed" truncate>
                            {localReply.sender_email}
                        </Text>
                    </Stack>

                    <Group gap={8} style={{ flexShrink: 0, paddingTop: 2 }}>
                        {localReply.campaign_name && (
                            <Badge size="sm" variant="light" color="violet">
                                {localReply.campaign_name}
                            </Badge>
                        )}
                        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                            {formatDate(localReply.replied_at)}
                        </Text>
                        <ActionIcon
                            variant="subtle"
                            color="gray"
                            size="sm"
                            radius="xl"
                            onClick={onClose}
                        >
                            <IconX size={14} />
                        </ActionIcon>
                    </Group>
                </Group>
            </Box>

            {/* ── INFO STRIP ─────────────────────────────── */}
            <Box
                style={{
                    background: '#f9f9fd',
                    borderTop: '1px solid #ededf8',
                    borderBottom: '1px solid #ededf8',
                    padding: '10px 24px',
                }}
            >
                <Group gap={0} align="center" wrap="nowrap">
                    {/* Company */}
                    <Group gap={6} pr={14} style={{ borderRight: '1px solid #e8e8f5', flexShrink: 0 }}>
                        <Text size="xs" fw={700} c="dimmed" tt="uppercase"
                            style={{ letterSpacing: '0.08em', fontSize: 10 }}>
                            {t('emailReplies.detail.company')}
                        </Text>
                        {isMatched ? (
                            <Anchor
                                fw={600}
                                size="sm"
                                c="#3b3b8a"
                                style={{ textDecoration: 'none' }}
                                styles={{ root: { '&:hover': { color: 'var(--mantine-color-violet-7)', textDecoration: 'underline' } } }}
                                onClick={() => { onClose(); navigate(`/companies/${localReply.company_id}`); }}
                            >
                                {localReply.company_name}
                                <IconExternalLink size={10} style={{ marginLeft: 3, opacity: 0.45, verticalAlign: 'middle' }} />
                            </Anchor>
                        ) : (
                            <Badge size="xs" variant="light" color="orange">
                                {t('emailReplies.status.unmatched')}
                            </Badge>
                        )}
                    </Group>

                    {/* Contact */}
                    <Group gap={6} px={14} style={{ borderRight: '1px solid #e8e8f5', flexShrink: 0 }}>
                        <Text size="xs" fw={700} c="dimmed" tt="uppercase"
                            style={{ letterSpacing: '0.08em', fontSize: 10 }}>
                            {t('emailReplies.detail.contact')}
                        </Text>
                        {localReply.contact_id ? (
                            <Anchor
                                fw={600}
                                size="sm"
                                c="#3b3b8a"
                                style={{ textDecoration: 'none' }}
                                styles={{ root: { '&:hover': { color: 'var(--mantine-color-violet-7)', textDecoration: 'underline' } } }}
                                onClick={() => { onClose(); navigate(`/people/${localReply.contact_id}`); }}
                            >
                                {localReply.contact_name}
                                <IconExternalLink size={10} style={{ marginLeft: 3, opacity: 0.45, verticalAlign: 'middle' }} />
                            </Anchor>
                        ) : (
                            <Text size="sm" c="dimmed">—</Text>
                        )}
                    </Group>

                    {/* Match status */}
                    <Group gap={6} px={14} style={{ borderRight: '1px solid #e8e8f5', flexShrink: 0 }}>
                        <Box
                            w={6} h={6}
                            style={{ borderRadius: '50%', background: isMatched ? '#16a34a' : '#d97706', flexShrink: 0 }}
                        />
                        <Text size="xs" fw={600} c={isMatched ? 'green' : 'orange'}>
                            {isMatched ? t('emailReplies.status.matched') : t('emailReplies.status.unmatched')}
                        </Text>
                    </Group>

                    {/* Read status */}
                    <Box ml="auto" pl={14}>
                        <Badge
                            size="sm"
                            variant="light"
                            color={localReply.read_status === 'unread' ? 'blue' : 'gray'}
                        >
                            {localReply.read_status === 'unread'
                                ? t('emailReplies.status.unread')
                                : t('emailReplies.status.read')}
                        </Badge>
                    </Box>
                </Group>
            </Box>

            {/* ── REPLY BODY ─────────────────────────────── */}
            <ScrollArea.Autosize mah={320}>
                <Box px={24} py={20}>
                    <Text
                        size="sm"
                        style={{
                            lineHeight: 1.8,
                            color: '#252540',
                            fontFamily: 'Georgia, "Times New Roman", serif',
                            whiteSpace: 'pre-wrap',
                        }}
                    >
                        {localReply.reply_body || '—'}
                    </Text>
                </Box>
            </ScrollArea.Autosize>

            {/* ── UNMATCHED PANEL ────────────────────────── */}
            {!isMatched && (
                <Box mx={24} mb={16}>
                    <Box
                        style={{
                            border: '1px solid #fed7aa',
                            borderRadius: 10,
                            overflow: 'hidden',
                        }}
                    >
                        <Group px={14} py={11} style={{ background: '#fff7ed' }} gap={8} wrap="nowrap">
                            <Text size="xs" c="#92400e" fw={500} style={{ flex: 1 }}>
                                {t('emailReplies.status.unmatched')}
                            </Text>
                            <Button
                                size="xs"
                                variant={assignOpen ? 'light' : 'subtle'}
                                color="orange"
                                onClick={() => setAssignOpen((v) => !v)}
                                style={{ flexShrink: 0 }}
                            >
                                {t('emailReplies.assign.manualMatch')}
                            </Button>
                            <Button
                                size="xs"
                                variant="filled"
                                color="yellow"
                                leftSection={<IconRefresh size={13} />}
                                loading={rematchMutation.isPending}
                                onClick={() => rematchMutation.mutate()}
                                style={{ flexShrink: 0 }}
                            >
                                {t('emailReplies.rematch.button')}
                            </Button>
                        </Group>
                        <Collapse in={assignOpen}>
                            <Box px={14} py={12} style={{ borderTop: '1px solid #fed7aa' }}>
                                <AssignCompanyForm replyId={localReply.id} onAssigned={onClose} hideWarning />
                            </Box>
                        </Collapse>
                    </Box>
                </Box>
            )}

            {/* ── QUICK ACTIVITY PANEL ───────────────────── */}
            <Collapse in={activityOpen && isMatched}>
                <Box mx={24} mb={12}>
                    <Box
                        style={{
                            border: '1px solid #e2e8f0',
                            borderRadius: 10,
                            overflow: 'hidden',
                        }}
                    >
                        {/* Panel header */}
                        <Group
                            px={14} py={10}
                            style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}
                            justify="space-between"
                        >
                            <Group gap={6}>
                                <IconPlus size={13} color="#334155" />
                                <Text size="xs" fw={600} c="#334155">
                                    {t('emailReplies.quickActivity.title')}
                                </Text>
                            </Group>
                            <ActionIcon
                                size="sm"
                                variant="subtle"
                                color="gray"
                                onClick={() => setActivityOpen(false)}
                            >
                                <IconX size={12} />
                            </ActionIcon>
                        </Group>

                        {/* Panel body */}
                        <Box p={14} style={{ background: '#fff' }}>
                            {/* Type selector */}
                            <Group gap={6} mb={10}>
                                {ACTIVITY_TYPES.map(({ value, emoji, labelKey }) => (
                                    <Button
                                        key={value}
                                        size="xs"
                                        variant={activityType === value ? 'filled' : 'default'}
                                        color="violet"
                                        radius="xl"
                                        fw={activityType === value ? 600 : 400}
                                        onClick={() => setActivityType(value)}
                                    >
                                        {emoji} {t(labelKey)}
                                    </Button>
                                ))}
                            </Group>

                            <Textarea
                                placeholder={t('emailReplies.quickActivity.placeholder')}
                                value={activityNote}
                                onChange={(e) => setActivityNote(e.currentTarget.value)}
                                minRows={2}
                                maxRows={4}
                                autosize
                                styles={{ input: { fontSize: 13, lineHeight: 1.6 } }}
                            />

                            <Group justify="flex-end" mt={10} gap="xs">
                                <Button
                                    size="xs"
                                    variant="subtle"
                                    color="gray"
                                    onClick={() => setActivityOpen(false)}
                                >
                                    {t('emailReplies.quickActivity.cancel')}
                                </Button>
                                <Button
                                    size="xs"
                                    leftSection={<IconCheck size={12} />}
                                    loading={addActivityMutation.isPending}
                                    disabled={!activityNote.trim()}
                                    onClick={() => addActivityMutation.mutate()}
                                >
                                    {t('emailReplies.quickActivity.save')}
                                </Button>
                            </Group>
                        </Box>
                    </Box>
                </Box>
            </Collapse>

            {/* ── TOOLBAR ────────────────────────────────── */}
            <Box
                px={18}
                py={10}
                style={{ borderTop: '1px solid #ededf8' }}
            >
                {confirmDelete ? (
                    <Group gap="xs" align="center">
                        <Text size="xs" c="red" fw={500}>{t('emailReplies.actions.deleteConfirm')}</Text>
                        <Button size="xs" color="red" loading={deleteMutation.isPending}
                            onClick={() => deleteMutation.mutate()}>
                            {t('emailReplies.actions.confirmYes')}
                        </Button>
                        <Button size="xs" variant="subtle" color="gray"
                            onClick={() => setConfirmDelete(false)}>
                            {t('emailReplies.actions.confirmNo')}
                        </Button>
                    </Group>
                ) : (
                    <Group gap={2} align="center">
                        {/* Stage menu — only when matched */}
                        {isMatched && (
                            <>
                                <Menu shadow="md" radius="md" position="top-start">
                                    <Menu.Target>
                                        <Button
                                            variant="subtle"
                                            color="gray"
                                            size="xs"
                                            rightSection={<IconChevronDown size={12} />}
                                            loading={stageUpdateMutation.isPending}
                                        >
                                            {t('emailReplies.actions.updateStage')}
                                            {localReply?.company_stage && (
                                                <span style={{ marginLeft: 4, color: 'var(--mantine-color-violet-6)', fontWeight: 600 }}>
                                                    · {stageOptions.find((s) => s.value === localReply.company_stage)?.label ?? localReply.company_stage}
                                                </span>
                                            )}
                                        </Button>
                                    </Menu.Target>
                                    <Menu.Dropdown>
                                        <Menu.Label>{t('emailReplies.actions.updateStage')}</Menu.Label>
                                        {stageOptions.map((stage) => {
                                            const isCurrent = stage.value === localReply?.company_stage;
                                            return (
                                                <Menu.Item
                                                    key={stage.value}
                                                    fw={isCurrent ? 600 : undefined}
                                                    c={isCurrent ? 'violet' : undefined}
                                                    rightSection={isCurrent ? <IconCheck size={13} /> : undefined}
                                                    onClick={() => stageUpdateMutation.mutate(stage.value)}
                                                >
                                                    {stage.label}
                                                </Menu.Item>
                                            );
                                        })}
                                    </Menu.Dropdown>
                                </Menu>
                                <Divider orientation="vertical" h={18} my="auto" />
                            </>
                        )}

                        {/* Quick activity — only when matched */}
                        {isMatched && (
                            <>
                                <Button
                                    variant={activityOpen ? 'light' : 'subtle'}
                                    color={activityOpen ? 'violet' : 'gray'}
                                    size="xs"
                                    leftSection={<IconPlus size={13} />}
                                    onClick={() => setActivityOpen((v) => !v)}
                                >
                                    {t('emailReplies.quickActivity.button')}
                                </Button>
                                <Divider orientation="vertical" h={18} my="auto" />
                            </>
                        )}

                        {/* Read/unread toggle */}
                        <Button
                            variant="subtle"
                            color="gray"
                            size="xs"
                            leftSection={localReply.read_status === 'read'
                                ? <IconMailOpened size={13} />
                                : <IconMail size={13} />}
                            loading={readToggleMutation.isPending}
                            onClick={() => readToggleMutation.mutate()}
                        >
                            {localReply.read_status === 'read'
                                ? t('emailReplies.actions.markUnread')
                                : t('emailReplies.actions.markRead')}
                        </Button>

                        {/* Delete — internal only */}
                        {canDeleteReply && (
                            <>
                                <Divider orientation="vertical" h={18} my="auto" />
                                <Button
                                    variant="subtle"
                                    color="red"
                                    size="xs"
                                    leftSection={<IconTrash size={13} />}
                                    onClick={() => setConfirmDelete(true)}
                                >
                                    {t('emailReplies.actions.delete')}
                                </Button>
                            </>
                        )}
                    </Group>
                )}
            </Box>
        </Modal>
    );
}
