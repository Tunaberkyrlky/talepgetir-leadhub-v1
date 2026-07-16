import { useState, useMemo, useCallback, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
    Modal, Group, Stack, Text, Badge, Button, Anchor,
    Collapse, Textarea, Box, ActionIcon, Menu, Divider,
    Avatar, ScrollArea, TextInput,
} from '@mantine/core';
import {
    IconMail, IconMailOpened, IconTrash, IconRefresh,
    IconExternalLink, IconPlus, IconChevronDown, IconX, IconCheck,
    IconArrowBackUp, IconArrowForwardUp, IconSend, IconDeviceFloppy,
    IconPaperclip,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showWarning, showErrorFromApi, notifyAttachmentWarning } from '../../lib/notifications';
import { useAuth } from '../../contexts/AuthContext';
import { isInternal } from '../../lib/permissions';
import { useStages } from '../../contexts/StagesContext';
import AssignCompanyForm from './AssignCompanyForm';
import AttachmentSection from './AttachmentSection';
import TrackingBadges from './TrackingBadges';
import ActivityForm from '../ActivityForm';
import ClosingReportModal from '../ClosingReportModal';
import type { EmailReply, ThreadHistoryItem } from '../../types/emailReply';
import { resolveOurMailbox } from '../../types/emailReply';
import type { ClosingOutcome } from '../../types/activity';

interface ReplyDetailModalProps {
    reply: EmailReply | null;
    opened: boolean;
    onClose: () => void;
}

function splitEmailBody(body: string): { fresh: string; quoted: string | null } {
    if (!body) return { fresh: '', quoted: null };
    const patterns = [
        /^From:[ \t]+\S/m,
        /^On .+?wrote:/m,
        /^-{3,}[ \t]*(?:original|forwarded)/im,
        /^[ \t]*>/m,
    ];
    let splitIndex = body.length;
    for (const pattern of patterns) {
        const match = body.match(pattern);
        if (match?.index !== undefined && match.index > 10) {
            splitIndex = Math.min(splitIndex, match.index);
        }
    }
    if (splitIndex === body.length) return { fresh: body, quoted: null };
    const fresh = body.slice(0, splitIndex).trimEnd();
    if (!fresh) return { fresh: body, quoted: null };
    return { fresh, quoted: body.slice(splitIndex) };
}

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
    const { stageOptions, terminalStageSlugs } = useStages();
    const canDeleteReply = isInternal(user?.role || '');
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';

    const [localReply, setLocalReply] = useState<EmailReply | null>(reply);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [activityOpen, setActivityOpen] = useState(false);
    const [closingReportTarget, setClosingReportTarget] = useState<ClosingOutcome | null>(null);
    const [assignOpen, setAssignOpen] = useState(false);
    const [replyOpen, setReplyOpen] = useState(false);
    const [replyBody, setReplyBody] = useState('');
    const [selectedCc, setSelectedCc] = useState<string[]>([]);
    const [customCc, setCustomCc] = useState('');
    const [selectedAttachments, setSelectedAttachments] = useState<string[]>([]);
    const [draftLoaded, setDraftLoaded] = useState<string | null>(null);
    const [ccInputOpen, setCcInputOpen] = useState(false);
    const [expandedQuotes, setExpandedQuotes] = useState<Set<string>>(new Set());

    // Forward panel state
    const [forwardOpen, setForwardOpen] = useState(false);
    const [forwardTo, setForwardTo] = useState('');
    const [forwardNote, setForwardNote] = useState('');
    const [selectedForwardAttachments, setSelectedForwardAttachments] = useState<string[]>([]);

    // Sync all UI state when a different reply is selected
    useEffect(() => {
        setLocalReply(reply);
        setConfirmDelete(false);
        setActivityOpen(false);
        setAssignOpen(false);
        setReplyOpen(false);
        setReplyBody('');
        setSelectedCc([]);
        setSelectedAttachments([]);
        setDraftLoaded(null);
        setCcInputOpen(false);
        setForwardOpen(false);
        setForwardTo('');
        setForwardNote('');
        setSelectedForwardAttachments([]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reply?.id]);

    // Auto-mark as read when a decisive action is taken (activity, closing report, reply sent)
    const markAsRead = useCallback(() => {
        if (!localReply || localReply.read_status === 'read') return;
        api.patch(`/email-replies/${localReply.id}/read`, { read_status: 'read' })
            .then(() => {
                setLocalReply(prev => prev ? { ...prev, read_status: 'read' } : prev);
                queryClient.invalidateQueries({ queryKey: ['email-replies'] });
                queryClient.invalidateQueries({ queryKey: ['email-replies-stats'] });
            })
            .catch(() => {});
    }, [localReply, queryClient]);

    const isMatched = !!localReply?.company_id;

    // ── CC addresses (tenant-level, persisted on server) ──
    const { data: ccAddresses } = useQuery<{ email: string; label: string }[]>({
        queryKey: ['cc-addresses'],
        queryFn: async () => (await api.get('/settings/cc-addresses')).data.data,
        staleTime: 5 * 60 * 1000,
    });
    const savedCcList = useMemo(() => (ccAddresses || []).map(a => a.email), [ccAddresses]);
    const addToSavedCc = useCallback((email: string) => {
        const current = ccAddresses || [];
        if (current.some(a => a.email === email)) return;
        const updated = [...current, { email, label: email }];
        api.put('/settings/cc-addresses', { cc_addresses: updated }).then(() => {
            queryClient.invalidateQueries({ queryKey: ['cc-addresses'] });
        }).catch(() => {});
    }, [ccAddresses, queryClient]);
    const removeFromSavedCc = useCallback((email: string) => {
        const updated = (ccAddresses || []).filter(a => a.email !== email);
        api.put('/settings/cc-addresses', { cc_addresses: updated }).then(() => {
            queryClient.invalidateQueries({ queryKey: ['cc-addresses'] });
        }).catch(() => {});
    }, [ccAddresses, queryClient]);

    // ── Load saved draft ──
    const { data: draftData } = useQuery<{ draft: { id: string; reply_body: string; raw_payload: any } | null }>({
        queryKey: ['email-reply-draft', localReply?.id],
        queryFn: async () => (await api.get(`/email-replies/${localReply!.id}/draft`)).data,
        enabled: opened && !!localReply,
        staleTime: 30_000,
    });

    // Auto-fill body from draft when reply compose opens (only if body is empty)
    useEffect(() => {
        if (draftData?.draft && draftData.draft.id !== draftLoaded && !replyBody.trim()) {
            setReplyBody(draftData.draft.reply_body);
            setDraftLoaded(draftData.draft.id);
            // Restore CC from draft if available
            const savedCc = draftData.draft.raw_payload?.cc;
            if (savedCc && typeof savedCc === 'string') {
                setSelectedCc(savedCc.split(',').map((e: string) => e.trim()).filter(Boolean));
            }
            const savedAttachments = draftData.draft.raw_payload?.attachment_ids;
            if (Array.isArray(savedAttachments) && savedAttachments.length) {
                setSelectedAttachments(
                    savedAttachments.filter((id: unknown): id is string => typeof id === 'string'),
                );
            }
        }
    }, [draftData, draftLoaded, replyBody]);

    // ── Thread history (all IN + OUT messages) ──
    const { data: threadMessages } = useQuery<ThreadHistoryItem[]>({
        queryKey: ['email-reply-thread-modal', localReply?.sender_email, localReply?.campaign_id],
        queryFn: async () => {
            const params: Record<string, string> = {
                sender_email: localReply!.sender_email,
            };
            if (localReply!.campaign_id) params.campaign_id = localReply!.campaign_id;
            return (await api.get('/email-replies/thread-history', { params })).data;
        },
        enabled: opened && !!localReply,
        staleTime: 60_000,
    });

    const sortedThread = useMemo(() =>
        [...(threadMessages || [])].sort((a, b) =>
            new Date(b.replied_at).getTime() - new Date(a.replied_at).getTime()
        ), [threadMessages]);

    const formatDate = (iso: string) =>
        new Date(iso).toLocaleDateString(locale, {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });

    // ── Stage update ──
    const stageUpdateMutation = useMutation({
        mutationFn: async (newStage: string) =>
            (await api.patch(`/companies/${localReply!.company_id}/stage`, { stage: newStage })).data,
        onSuccess: () => {
            showSuccess(t('emailReplies.stageUpdated'));
            markAsRead();
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

    // Sender (from) address shown in the reply compose panel = OUR mailbox for
    // this thread. Resolved source-aware (SMTP/webhook/api-import/OUT) so the
    // legacy mis-labeled `from_address` (which sometimes held the recipient list)
    // no longer leaks the lead/recipient into the "From" slot.
    const senderAddress = resolveOurMailbox(localReply);

    // ── Send reply via PlusVibe ──
    // Build CC list from selected chips
    const buildCcList = (): string[] => {
        return [...new Set(selectedCc)];
    };

    const sendReplyMutation = useMutation({
        mutationFn: async () => {
            const ccList = buildCcList();
            return (await api.post(`/email-replies/${localReply!.id}/reply`, {
                body: replyBody.trim(),
                ...(selectedAttachments.length > 0 && { attachmentIds: selectedAttachments }),
                ...(ccList.length > 0 && { cc: ccList.join(', ') }),
            })).data;
        },
        onSuccess: (data) => {
            if (!notifyAttachmentWarning(data)) showSuccess(t('emailReplies.reply.success'));
            setReplyOpen(false);
            setReplyBody('');
            setSelectedCc([]);
            setCustomCc('');
            setSelectedAttachments([]);
            markAsRead();
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['email-replies-stats'] });
            queryClient.invalidateQueries({ queryKey: ['email-replies-tracking-stats'] });
        },
        onError: (err) => showErrorFromApi(err, t('emailReplies.reply.failed')),
    });

    const saveDraftMutation = useMutation({
        mutationFn: async () => {
            const ccList = buildCcList();
            return (await api.post(`/email-replies/${localReply!.id}/save-draft`, {
                body: replyBody.trim(),
                ...(selectedAttachments.length > 0 && { attachmentIds: selectedAttachments }),
                ...(ccList.length > 0 && { cc: ccList.join(', ') }),
            })).data;
        },
        onSuccess: () => {
            showSuccess(t('emailReplies.reply.draftSaved'));
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['activities'] });
        },
        onError: (err) => showErrorFromApi(err, t('emailReplies.reply.draftFailed')),
    });

    // ── Forward via PlusVibe ──
    const forwardMutation = useMutation({
        mutationFn: async () =>
            (await api.post(`/email-replies/${localReply!.id}/forward`, {
                to: forwardTo.trim(),
                note: forwardNote.trim(),
                ...(selectedForwardAttachments.length > 0 && { attachmentIds: selectedForwardAttachments }),
            })).data,
        onSuccess: (data) => {
            if (!notifyAttachmentWarning(data)) showSuccess(t('emailReplies.forward.success', 'Email yönlendirildi'));
            setForwardOpen(false);
            setForwardTo('');
            setForwardNote('');
            setSelectedForwardAttachments([]);
            markAsRead();
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['email-reply-thread-modal'] });
            queryClient.invalidateQueries({ queryKey: ['email-replies-tracking-stats'] });
        },
        onError: (err) => showErrorFromApi(err, t('emailReplies.forward.failed', 'Yönlendirme başarısız')),
    });

    if (!localReply) return null;

    const initials = getInitials(localReply.contact_name, localReply.sender_email);
    const avatarColor = isMatched ? 'violet' : 'orange';

    return (
        <>
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

            {/* ── CONVERSATION THREAD ────────────────────── */}
            <ScrollArea.Autosize mah={380}>
                {sortedThread.length > 0 ? sortedThread.map((msg, idx) => {
                    const isOut = msg.direction === 'OUT';
                    const isCurrent = msg.id === localReply.id;
                    const isForward = msg.raw_payload?.source === 'user_forward';
                    const forwardedTo = msg.raw_payload?.forwarded_to;
                    return (
                        <Box key={msg.id}>
                            {idx > 0 && <Divider color="#ededf8" />}
                            <Box
                                px={24}
                                py={14}
                                style={{
                                    background: isForward ? '#fffbeb' : (isOut ? '#f8f5ff' : '#fff'),
                                    ...(isCurrent ? { borderLeft: '3px solid #7c3aed' } : {}),
                                }}
                            >
                                <Group gap={8} mb={6}>
                                    <Badge
                                        size="xs"
                                        variant={isForward || isOut ? 'filled' : 'light'}
                                        color={isForward ? 'yellow' : (isOut ? 'violet' : 'gray')}
                                    >
                                        {isForward
                                            ? t('emailReplies.thread.forwarded')
                                            : (isOut ? t('emailReplies.thread.sent') : t('emailReplies.thread.received'))}
                                    </Badge>
                                    {isForward && forwardedTo && (
                                        <Text size="xs" c="#92400e" fw={500}>
                                            → {forwardedTo}
                                        </Text>
                                    )}
                                    <Text size="xs" c="dimmed">
                                        {formatDate(msg.replied_at)}
                                    </Text>
                                    {isOut && <TrackingBadges tracking={msg.tracking} locale={locale} />}
                                </Group>
                                {(() => {
                                    // Per-message From/To from canonical columns (fallback to legacy).
                                    // IN:  from = lead (sender_email),  to = our mailbox (account_email)
                                    // OUT: from = our mailbox,          to = lead
                                    const ourMailbox = resolveOurMailbox(msg);
                                    const fromAddr = msg.from_address
                                        ?? (isOut ? ourMailbox : msg.sender_email);
                                    const toAddr = msg.to_address
                                        ?? (isOut ? msg.sender_email : ourMailbox);
                                    if (!fromAddr && !toAddr) return null;
                                    return (
                                        <Stack gap={1} mb={6}>
                                            {fromAddr && (
                                                <Text size="xs" c="dimmed">
                                                    <Text span fw={600} c="#525266">{t('emailReplies.reply.from')}:</Text>{' '}{fromAddr}
                                                </Text>
                                            )}
                                            {toAddr && (
                                                <Text size="xs" c="dimmed">
                                                    <Text span fw={600} c="#525266">{t('emailReplies.reply.to')}:</Text>{' '}{toAddr}
                                                </Text>
                                            )}
                                        </Stack>
                                    );
                                })()}
                                {(() => {
                                    const { fresh, quoted } = splitEmailBody(msg.reply_body || '');
                                    const isQuoteExpanded = expandedQuotes.has(msg.id);
                                    return (
                                        <>
                                            <Text size="sm" style={{ lineHeight: 1.7, color: isOut ? '#4c1d95' : '#252540', fontFamily: 'Georgia, "Times New Roman", serif', whiteSpace: 'pre-wrap' }}>
                                                {fresh || '—'}
                                            </Text>
                                            {quoted && (
                                                <>
                                                    <Box
                                                        mt={8}
                                                        style={{ display: 'inline-flex', cursor: 'pointer' }}
                                                        onClick={() => setExpandedQuotes(prev => {
                                                            const s = new Set(prev);
                                                            s.has(msg.id) ? s.delete(msg.id) : s.add(msg.id);
                                                            return s;
                                                        })}
                                                    >
                                                        <Box style={{ padding: '1px 7px', borderRadius: 4, background: '#e8e8f0', color: '#888', fontSize: 13, letterSpacing: 2, userSelect: 'none' }}>
                                                            ···
                                                        </Box>
                                                    </Box>
                                                    {isQuoteExpanded && (
                                                        <Box mt={8} pl={12} style={{ borderLeft: '2px solid #d8d8ec' }}>
                                                            <Text size="xs" style={{ color: '#999', whiteSpace: 'pre-wrap', lineHeight: 1.6, fontFamily: 'Georgia, "Times New Roman", serif' }}>
                                                                {quoted}
                                                            </Text>
                                                        </Box>
                                                    )}
                                                </>
                                            )}
                                        </>
                                    );
                                })()}
                                {msg.attachments && msg.attachments.length > 0 && (
                                    <Group gap={8} mt={10}>
                                        {msg.attachments.map((attachment) => attachment.missing ? (
                                            <Badge
                                                key={attachment.id}
                                                size="sm"
                                                variant="light"
                                                color="gray"
                                                leftSection={<IconPaperclip size={12} />}
                                            >
                                                {t('emailReplies.attachments.unavailable', 'Ek artık mevcut değil')}
                                            </Badge>
                                        ) : (
                                            <Anchor
                                                key={attachment.id}
                                                href={attachment.open_url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                underline="never"
                                            >
                                                <Group
                                                    gap={6}
                                                    wrap="nowrap"
                                                    style={{ border: '1px solid #e3e3ef', borderRadius: 8, padding: '4px 10px', background: '#fff' }}
                                                >
                                                    <IconPaperclip size={14} color="#7c3aed" />
                                                    <Box>
                                                        <Text
                                                            size="xs"
                                                            fw={600}
                                                            c="#3a3a52"
                                                            style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                                        >
                                                            {attachment.label}
                                                        </Text>
                                                        <Text fz={10} c="dimmed">
                                                            {(attachment.file_type || '').toUpperCase()}
                                                            {attachment.file_size ? ` · ${attachment.file_size}` : ''}
                                                        </Text>
                                                    </Box>
                                                    <Badge size="xs" variant="light" color={attachment.is_file ? 'teal' : 'gray'}>
                                                        {attachment.is_file
                                                            ? t('emailReplies.attachments.deliveryFile', 'Dosya')
                                                            : t('emailReplies.attachments.deliveryLink', 'Link')}
                                                    </Badge>
                                                    <IconExternalLink size={13} color="#9a9ab0" />
                                                </Group>
                                            </Anchor>
                                        ))}
                                    </Group>
                                )}
                            </Box>
                        </Box>
                    );
                }) : (
                    <Box px={24} py={20}>
                        {(() => {
                            const { fresh, quoted } = splitEmailBody(localReply.reply_body || '');
                            const isQuoteExpanded = expandedQuotes.has(localReply.id);
                            return (
                                <>
                                    <Text size="sm" style={{ lineHeight: 1.8, color: '#252540', fontFamily: 'Georgia, "Times New Roman", serif', whiteSpace: 'pre-wrap' }}>
                                        {fresh || '—'}
                                    </Text>
                                    {quoted && (
                                        <>
                                            <Box
                                                mt={8}
                                                style={{ display: 'inline-flex', cursor: 'pointer' }}
                                                onClick={() => setExpandedQuotes(prev => {
                                                    const s = new Set(prev);
                                                    s.has(localReply.id) ? s.delete(localReply.id) : s.add(localReply.id);
                                                    return s;
                                                })}
                                            >
                                                <Box style={{ padding: '1px 7px', borderRadius: 4, background: '#e8e8f0', color: '#888', fontSize: 13, letterSpacing: 2, userSelect: 'none' }}>
                                                    ···
                                                </Box>
                                            </Box>
                                            {isQuoteExpanded && (
                                                <Box mt={8} pl={12} style={{ borderLeft: '2px solid #d8d8ec' }}>
                                                    <Text size="xs" style={{ color: '#999', whiteSpace: 'pre-wrap', lineHeight: 1.6, fontFamily: 'Georgia, "Times New Roman", serif' }}>
                                                        {quoted}
                                                    </Text>
                                                </Box>
                                            )}
                                        </>
                                    )}
                                </>
                            );
                        })()}
                    </Box>
                )}
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

            {/* ── ACTIVITY FORM (inline) ──────────────── */}
            {isMatched && localReply.company_id && (
                <ActivityForm
                    opened={activityOpen}
                    onClose={() => setActivityOpen(false)}
                    onSuccess={markAsRead}
                    companyId={localReply.company_id}
                    contactId={localReply.contact_id || undefined}
                    inline
                />
            )}

            {/* ── REPLY PANEL ────────────────────────────── */}
            <Collapse in={replyOpen}>
                <Box mx={24} mb={12}>
                    <Box
                        style={{
                            border: '1px solid #c4b5fd',
                            borderRadius: 10,
                            overflow: 'hidden',
                        }}
                    >
                        <Group
                            px={14} py={10}
                            style={{ background: '#f5f3ff', borderBottom: '1px solid #c4b5fd' }}
                            justify="space-between"
                        >
                            <Group gap={6}>
                                <IconArrowBackUp size={13} color="#5b21b6" />
                                <Text size="xs" fw={600} c="#5b21b6">
                                    {t('emailReplies.reply.title')}
                                </Text>
                            </Group>
                            <ActionIcon
                                size="sm"
                                variant="subtle"
                                color="gray"
                                onClick={() => setReplyOpen(false)}
                            >
                                <IconX size={12} />
                            </ActionIcon>
                        </Group>

                        <Box p={14} style={{ background: '#fff' }}>
                            {senderAddress && (
                                <Text size="xs" c="dimmed" mb={4}>
                                    {t('emailReplies.reply.from')}: <Text span fw={500} c="dark">{senderAddress}</Text>
                                </Text>
                            )}
                            <Text size="xs" c="dimmed" mb={4}>
                                {t('emailReplies.reply.to')}: <Text span fw={500} c="dark">{localReply.sender_email}</Text>
                            </Text>

                            {/* CC selector — saved badges above, input below */}
                            <Box mb={8}>
                                {/* Saved CC badges (if any) */}
                                {(savedCcList.length > 0 || selectedCc.length > 0) && (
                                    <Group gap={4} mb={6} style={{ flexWrap: 'wrap' }}>
                                        {savedCcList.map((email) => (
                                            <Badge key={email} size="xs"
                                                variant={selectedCc.includes(email) ? 'filled' : 'light'}
                                                color="violet" style={{ cursor: 'pointer' }}
                                                onClick={() => setSelectedCc((prev) =>
                                                    prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email]
                                                )}
                                                rightSection={
                                                    <ActionIcon size={12} variant="transparent"
                                                        c={selectedCc.includes(email) ? 'white' : 'dimmed'}
                                                        onClick={(ev) => { ev.stopPropagation(); removeFromSavedCc(email); setSelectedCc(p => p.filter(e => e !== email)); }}
                                                    >
                                                        <IconX size={10} />
                                                    </ActionIcon>
                                                }
                                            >
                                                {email}
                                            </Badge>
                                        ))}
                                        {/* Active CC's not in saved list */}
                                        {selectedCc.filter(e => !savedCcList.includes(e)).map((email) => (
                                            <Badge key={email} size="xs" variant="filled" color="gray"
                                                rightSection={
                                                    <ActionIcon size={12} variant="transparent" c="white"
                                                        onClick={(ev) => { ev.stopPropagation(); setSelectedCc(p => p.filter(e => e !== email)); }}
                                                    >
                                                        <IconX size={10} />
                                                    </ActionIcon>
                                                }
                                            >
                                                {email}
                                            </Badge>
                                        ))}
                                    </Group>
                                )}

                                {/* CC input — always visible if badges exist, otherwise show "CC Ekle" button */}
                                {(savedCcList.length > 0 || selectedCc.length > 0 || customCc) ? (
                                    <TextInput size="xs" placeholder={t('emailReplies.reply.customCc', 'CC ekle...')}
                                        value={customCc}
                                        onChange={(e) => setCustomCc(e.currentTarget.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                const email = customCc.trim().toLowerCase();
                                                if (email && email.includes('@') && !selectedCc.includes(email)) {
                                                    setSelectedCc((prev) => [...prev, email]);
                                                    addToSavedCc(email);
                                                    setCustomCc('');
                                                }
                                            }
                                        }}
                                        styles={{ input: { fontSize: 11 } }}
                                    />
                                ) : (
                                    <Button
                                        size="compact-xs"
                                        variant="subtle"
                                        color="gray"
                                        leftSection={<IconPlus size={12} />}
                                        onClick={() => setCcInputOpen(true)}
                                    >
                                        CC {t('emailReplies.reply.addCc', 'Ekle')}
                                    </Button>
                                )}
                                {ccInputOpen && savedCcList.length === 0 && selectedCc.length === 0 && !customCc && (
                                    <TextInput size="xs" placeholder={t('emailReplies.reply.customCc', 'CC ekle...')}
                                        value={customCc} mt={4}
                                        onChange={(e) => setCustomCc(e.currentTarget.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                const email = customCc.trim().toLowerCase();
                                                if (email && email.includes('@') && !selectedCc.includes(email)) {
                                                    setSelectedCc((prev) => [...prev, email]);
                                                    addToSavedCc(email);
                                                    setCustomCc('');
                                                }
                                            }
                                        }}
                                        styles={{ input: { fontSize: 11 } }}
                                        autoFocus
                                    />
                                )}
                            </Box>

                            <Textarea
                                placeholder={t('emailReplies.reply.placeholder')}
                                value={replyBody}
                                onChange={(e) => setReplyBody(e.currentTarget.value)}
                                minRows={3}
                                maxRows={8}
                                autosize
                                styles={{ input: { fontSize: 13, lineHeight: 1.6 } }}
                            />
                            {/* ── Attachments (shared structure) ── */}
                            <AttachmentSection
                                key={`reply-att-${localReply?.id ?? 'new'}`}
                                selected={selectedAttachments}
                                setSelected={setSelectedAttachments}
                            />

                            <Group justify="flex-end" mt={10} gap="xs">
                                <Button
                                    size="xs"
                                    variant="subtle"
                                    color="gray"
                                    onClick={() => { setReplyOpen(false); setSelectedAttachments([]); }}
                                >
                                    {t('emailReplies.reply.cancel')}
                                </Button>
                                <Button
                                    size="xs"
                                    variant="light"
                                    color="gray"
                                    leftSection={<IconDeviceFloppy size={12} />}
                                    loading={saveDraftMutation.isPending}
                                    disabled={!replyBody.trim() || sendReplyMutation.isPending}
                                    onClick={() => saveDraftMutation.mutate()}
                                >
                                    {t('emailReplies.reply.saveDraft')}
                                </Button>
                                <Button
                                    size="xs"
                                    color="violet"
                                    leftSection={<IconSend size={12} />}
                                    loading={sendReplyMutation.isPending}
                                    disabled={!replyBody.trim() || saveDraftMutation.isPending}
                                    onClick={() => sendReplyMutation.mutate()}
                                >
                                    {t('emailReplies.reply.send')}
                                    {selectedAttachments.length > 0 && (
                                        <Badge size="xs" variant="filled" color="white" c="violet" ml={4}>
                                            +{selectedAttachments.length}
                                        </Badge>
                                    )}
                                </Button>
                            </Group>
                        </Box>
                    </Box>
                </Box>
            </Collapse>

            {/* ── FORWARD PANEL ──────────────────────────── */}
            <Collapse in={forwardOpen}>
                <Box mx={24} mb={12}>
                    <Box
                        style={{
                            border: '1px solid #fde68a',
                            borderRadius: 10,
                            overflow: 'hidden',
                        }}
                    >
                        <Group
                            px={14} py={10}
                            style={{ background: '#fffbeb', borderBottom: '1px solid #fde68a' }}
                            justify="space-between"
                        >
                            <Group gap={6}>
                                <IconArrowForwardUp size={13} color="#92400e" />
                                <Text size="xs" fw={600} c="#92400e">
                                    {t('emailReplies.forward.title', 'Yönlendir')}
                                </Text>
                            </Group>
                            <ActionIcon
                                size="sm"
                                variant="subtle"
                                color="gray"
                                onClick={() => setForwardOpen(false)}
                            >
                                <IconX size={12} />
                            </ActionIcon>
                        </Group>

                        <Box p={14} style={{ background: '#fff' }}>
                            {senderAddress && (
                                <Text size="xs" c="dimmed" mb={4}>
                                    {t('emailReplies.reply.from')}: <Text span fw={500} c="dark">{senderAddress}</Text>
                                </Text>
                            )}
                            <TextInput
                                size="xs"
                                placeholder={t('emailReplies.forward.toPlaceholder', 'hedef@example.com')}
                                label={t('emailReplies.forward.to', 'Yönlendirilecek adres')}
                                value={forwardTo}
                                onChange={(e) => setForwardTo(e.currentTarget.value)}
                                mb={10}
                                styles={{ input: { fontSize: 12 }, label: { fontSize: 11, fontWeight: 600 } }}
                            />
                            <Textarea
                                placeholder={t('emailReplies.forward.notePlaceholder', 'Eklemek istediğin not (orijinal mesajın üstüne eklenir)')}
                                value={forwardNote}
                                onChange={(e) => setForwardNote(e.currentTarget.value)}
                                minRows={3}
                                maxRows={8}
                                autosize
                                styles={{ input: { fontSize: 13, lineHeight: 1.6 } }}
                            />
                            <Text size="xs" c="dimmed" mt={6}>
                                {t('emailReplies.forward.hint', 'Orijinal mail otomatik olarak notun altında iletilir.')}
                            </Text>

                            {/* ── Attachments (shared structure) ── */}
                            <AttachmentSection
                                key={`fwd-att-${localReply?.id ?? 'new'}`}
                                selected={selectedForwardAttachments}
                                setSelected={setSelectedForwardAttachments}
                                color="yellow"
                            />

                            <Group justify="flex-end" mt={10} gap="xs">
                                <Button
                                    size="xs"
                                    variant="subtle"
                                    color="gray"
                                    onClick={() => { setForwardOpen(false); setSelectedForwardAttachments([]); }}
                                >
                                    {t('emailReplies.reply.cancel')}
                                </Button>
                                <Button
                                    size="xs"
                                    color="yellow"
                                    leftSection={<IconSend size={12} />}
                                    loading={forwardMutation.isPending}
                                    disabled={
                                        !forwardTo.trim() ||
                                        !forwardTo.includes('@') ||
                                        !forwardNote.trim()
                                    }
                                    onClick={() => forwardMutation.mutate()}
                                >
                                    {t('emailReplies.forward.send', 'Yönlendir')}
                                    {selectedForwardAttachments.length > 0 && (
                                        <Badge size="xs" variant="filled" color="white" c="yellow" ml={4}>
                                            +{selectedForwardAttachments.length}
                                        </Badge>
                                    )}
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
                                                    onClick={() => {
                                                        if (terminalStageSlugs.includes(stage.value)) {
                                                            setClosingReportTarget(stage.value as ClosingOutcome);
                                                        } else {
                                                            stageUpdateMutation.mutate(stage.value);
                                                        }
                                                    }}
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

                        {/* Reply button — only when campaign is linked */}
                        {!!localReply.campaign_id && (
                            <>
                                <Button
                                    variant={replyOpen ? 'light' : 'subtle'}
                                    color={replyOpen ? 'violet' : 'gray'}
                                    size="xs"
                                    leftSection={<IconArrowBackUp size={13} />}
                                    onClick={() => {
                                        setForwardOpen(false);
                                        setReplyOpen((v) => !v);
                                    }}
                                >
                                    {t('emailReplies.reply.button')}
                                </Button>
                                <Button
                                    variant={forwardOpen ? 'light' : 'subtle'}
                                    color={forwardOpen ? 'yellow' : 'gray'}
                                    size="xs"
                                    leftSection={<IconArrowForwardUp size={13} />}
                                    onClick={() => {
                                        setReplyOpen(false);
                                        setForwardOpen((v) => !v);
                                    }}
                                >
                                    {t('emailReplies.forward.button', 'Yönlendir')}
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

        {closingReportTarget && localReply?.company_id && (
            <ClosingReportModal
                opened={true}
                onClose={() => setClosingReportTarget(null)}
                companyId={localReply.company_id}
                companyName={localReply.company_name || ''}
                targetStage={closingReportTarget}
                onSuccess={() => {
                    setClosingReportTarget(null);
                    markAsRead();
                    queryClient.invalidateQueries({ queryKey: ['email-replies'] });
                    queryClient.invalidateQueries({ queryKey: ['companies'] });
                }}
            />
        )}
    </>
    );
}
