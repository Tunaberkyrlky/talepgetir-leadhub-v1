import { useState, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Modal, Group, Stack, Text, Badge, Button, Anchor,
    Textarea, Box, ActionIcon, Divider, TextInput, Loader,
    Checkbox, Alert, Select,
} from '@mantine/core';
import {
    IconMail, IconPlus, IconX, IconSend, IconPaperclip,
    IconAlertCircle,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';

interface ComposeMailModalProps {
    opened: boolean;
    onClose: () => void;
}

interface ContactSearchResult {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    company_id: string | null;
    company_name?: string | null;
}

interface AttachmentTemplate {
    id: string;
    label: string;
    file_type: string;
    file_url: string;
    file_size: string;
}

interface EmailConnectionStatus {
    connected: boolean;
    provider?: string;
    email?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ComposeMailModal({ opened, onClose }: ComposeMailModalProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();

    const [to, setTo] = useState('');
    const [toCompanyId, setToCompanyId] = useState<string | null>(null);
    const [toContactId, setToContactId] = useState<string | null>(null);
    const [contactSearchOpen, setContactSearchOpen] = useState(false);
    const [subject, setSubject] = useState('');
    const [body, setBody] = useState('');
    const [selectedCc, setSelectedCc] = useState<string[]>([]);
    const [customCc, setCustomCc] = useState('');
    const [ccInputOpen, setCcInputOpen] = useState(false);
    const [selectedAttachments, setSelectedAttachments] = useState<string[]>([]);
    const [fromAccount, setFromAccount] = useState<string | null>(null);

    // Reset all state when modal opens/closes
    useEffect(() => {
        if (!opened) {
            setTo('');
            setToCompanyId(null);
            setToContactId(null);
            setContactSearchOpen(false);
            setSubject('');
            setBody('');
            setSelectedCc([]);
            setCustomCc('');
            setCcInputOpen(false);
            setSelectedAttachments([]);
            setFromAccount(null);
        }
    }, [opened]);

    // ── Connection status ──
    const { data: connStatus, isLoading: connLoading } = useQuery<EmailConnectionStatus>({
        queryKey: ['email-connection-status'],
        queryFn: async () => (await api.get('/email-connections/status')).data,
        enabled: opened,
        staleTime: 60_000,
    });

    const connectionList = useMemo(() => connStatus?.connections ?? [], [connStatus]);

    // Default the "From" to the tenant's default mailbox once connections load
    useEffect(() => {
        if (opened && !fromAccount && connectionList.length > 0) {
            const def = connectionList.find((c) => c.is_default) ?? connectionList[0];
            setFromAccount(def.email_address);
        }
    }, [opened, fromAccount, connectionList]);

    // ── Contact search ──
    const { data: contactResults = [], isLoading: contactsLoading } = useQuery<ContactSearchResult[]>({
        queryKey: ['contact-search-compose', to],
        queryFn: async () => {
            if (!to.trim() || to.includes('@')) return [];
            const res = await api.get('/contacts', { params: { search: to.trim(), limit: 8, page: 1 } });
            return res.data?.data ?? res.data ?? [];
        },
        enabled: opened && contactSearchOpen && to.trim().length >= 2 && !to.includes('@'),
        staleTime: 30_000,
    });

    // ── CC addresses (tenant-level, shared with reply panel) ──
    const { data: ccAddresses } = useQuery<{ email: string; label: string }[]>({
        queryKey: ['cc-addresses'],
        queryFn: async () => (await api.get('/settings/cc-addresses')).data.data,
        staleTime: 5 * 60 * 1000,
    });
    const savedCcList = useMemo(() => (ccAddresses || []).map((a) => a.email), [ccAddresses]);

    // ── Attachment templates ──
    const { data: attachmentTemplates = [] } = useQuery<AttachmentTemplate[]>({
        queryKey: ['attachment-templates'],
        queryFn: async () => {
            const { data } = await api.get('/attachment-templates');
            return data.data || [];
        },
        enabled: opened,
        staleTime: 5 * 60_000,
    });

    // ── Send mutation ──
    const sendMutation = useMutation({
        mutationFn: async () => {
            const ccList = [...new Set(selectedCc)];
            return (await api.post('/email-replies/compose', {
                to: to.trim(),
                subject: subject.trim(),
                body: body.trim(),
                ...(selectedAttachments.length > 0 && { attachmentIds: selectedAttachments }),
                ...(ccList.length > 0 && { cc: ccList.join(', ') }),
                ...(fromAccount && { accountEmail: fromAccount }),
                ...(toCompanyId && { companyId: toCompanyId }),
                ...(toContactId && { contactId: toContactId }),
            })).data;
        },
        onSuccess: () => {
            showSuccess(t('emailReplies.compose.success', 'Mail gönderildi'));
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['email-replies-stats'] });
            onClose();
        },
        onError: (err) => showErrorFromApi(err, t('emailReplies.compose.failed', 'Mail gönderilemedi')),
    });

    const connected = !!connStatus?.connected;
    const canSend = connected
        && to.trim().length > 0
        && EMAIL_RE.test(to.trim())
        && subject.trim().length > 0
        && body.trim().length > 0
        && !sendMutation.isPending;

    const handleContactPick = (c: ContactSearchResult) => {
        if (!c.email) return;
        setTo(c.email);
        setToCompanyId(c.company_id);
        setToContactId(c.id);
        setContactSearchOpen(false);
    };

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            size="lg"
            radius="lg"
            centered
            title={
                <Group gap={8}>
                    <IconMail size={18} color="var(--mantine-color-violet-6)" />
                    <Text fw={600} size="md">{t('emailReplies.compose.title', 'Yeni Mail')}</Text>
                </Group>
            }
            overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
        >
            <Stack gap="md">
                {/* Connection guard */}
                {connLoading ? (
                    <Group justify="center" py="md"><Loader size="sm" /></Group>
                ) : !connected ? (
                    <Alert variant="light" color="yellow" icon={<IconAlertCircle size={16} />}>
                        <Text size="sm" fw={500} mb={4}>
                            {t('emailReplies.compose.noConnectionTitle', 'Bağlı mail hesabı yok')}
                        </Text>
                        <Text size="xs" c="dimmed">
                            {t(
                                'emailReplies.compose.noConnection',
                                'Mail göndermek için önce Ayarlar > E-posta Bağlantısı\'ndan Gmail hesabınızı bağlayın.',
                            )}
                        </Text>
                    </Alert>
                ) : connectionList.length > 1 ? (
                    <Select
                        label={t('emailReplies.compose.from', 'Kimden')}
                        data={connectionList.map((c) => ({
                            value: c.email_address,
                            label: c.is_default ? `${c.email_address} ★` : c.email_address,
                        }))}
                        value={fromAccount}
                        onChange={setFromAccount}
                        allowDeselect={false}
                        size="xs"
                        styles={{ label: { fontSize: 11, fontWeight: 600 } }}
                    />
                ) : (
                    <Text size="xs" c="dimmed">
                        {t('emailReplies.compose.from', 'Kimden')}: <Text span fw={500} c="dark">{fromAccount}</Text>
                    </Text>
                )}

                {/* To */}
                <Box>
                    <Text size="xs" fw={600} c="dimmed" mb={4} tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                        {t('emailReplies.compose.to', 'Kime')}
                    </Text>
                    <TextInput
                        placeholder={t('emailReplies.compose.toPlaceholder', 'Kişi arayın veya e-posta yazın')}
                        value={to}
                        onChange={(e) => {
                            setTo(e.currentTarget.value);
                            setToCompanyId(null);
                            setToContactId(null);
                            if (!contactSearchOpen) setContactSearchOpen(true);
                        }}
                        onFocus={() => setContactSearchOpen(true)}
                        rightSection={contactsLoading ? <Loader size={14} /> : undefined}
                        disabled={!connected}
                    />
                    {/* Inline contact picker */}
                    {contactSearchOpen && contactResults.length > 0 && (
                        <Box
                            mt={4}
                            style={{
                                border: '1px solid #e8e8f0', borderRadius: 8, maxHeight: 200, overflow: 'auto',
                                background: '#fff',
                            }}
                        >
                            {contactResults.map((c) => {
                                const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email;
                                return (
                                    <Box
                                        key={c.id}
                                        onClick={() => handleContactPick(c)}
                                        style={{
                                            padding: '8px 12px', cursor: c.email ? 'pointer' : 'not-allowed',
                                            opacity: c.email ? 1 : 0.5, borderBottom: '1px solid #f1f3f5',
                                        }}
                                        onMouseEnter={(e) => { e.currentTarget.style.background = '#f8f5ff'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
                                    >
                                        <Text size="sm" fw={500}>{name}</Text>
                                        <Text size="xs" c="dimmed">
                                            {c.email || t('emailReplies.compose.noEmail', '(e-posta yok)')}
                                            {c.company_name && <> · {c.company_name}</>}
                                        </Text>
                                    </Box>
                                );
                            })}
                        </Box>
                    )}
                    {toCompanyId && (
                        <Badge size="xs" color="violet" variant="light" mt={4}>
                            {t('emailReplies.compose.linkedContact', 'Kişiye bağlandı')}
                        </Badge>
                    )}
                </Box>

                {/* Subject */}
                <Box>
                    <Text size="xs" fw={600} c="dimmed" mb={4} tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                        {t('emailReplies.compose.subject', 'Konu')}
                    </Text>
                    <TextInput
                        placeholder={t('emailReplies.compose.subjectPlaceholder', 'Konu yazın')}
                        value={subject}
                        onChange={(e) => setSubject(e.currentTarget.value)}
                        disabled={!connected}
                    />
                </Box>

                {/* CC */}
                <Box>
                    <Text size="xs" fw={600} c="dimmed" mb={4} tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                        CC
                    </Text>
                    {(savedCcList.length > 0 || selectedCc.length > 0) && (
                        <Group gap={4} mb={6} style={{ flexWrap: 'wrap' }}>
                            {savedCcList.map((email) => (
                                <Badge
                                    key={email} size="xs"
                                    variant={selectedCc.includes(email) ? 'filled' : 'light'}
                                    color="violet" style={{ cursor: 'pointer' }}
                                    onClick={() => setSelectedCc((prev) =>
                                        prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email]
                                    )}
                                >
                                    {email}
                                </Badge>
                            ))}
                            {selectedCc.filter((e) => !savedCcList.includes(e)).map((email) => (
                                <Badge
                                    key={email} size="xs" variant="filled" color="gray"
                                    rightSection={
                                        <ActionIcon size={12} variant="transparent" c="white"
                                            onClick={(ev) => { ev.stopPropagation(); setSelectedCc((p) => p.filter((e) => e !== email)); }}
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
                    {(savedCcList.length > 0 || selectedCc.length > 0 || customCc || ccInputOpen) ? (
                        <TextInput
                            size="xs" placeholder={t('emailReplies.reply.customCc', 'CC ekle...')}
                            value={customCc}
                            onChange={(e) => setCustomCc(e.currentTarget.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    const email = customCc.trim().toLowerCase();
                                    if (email && EMAIL_RE.test(email) && !selectedCc.includes(email)) {
                                        setSelectedCc((prev) => [...prev, email]);
                                        setCustomCc('');
                                    }
                                }
                            }}
                            disabled={!connected}
                            styles={{ input: { fontSize: 11 } }}
                        />
                    ) : (
                        <Button
                            size="compact-xs"
                            variant="subtle"
                            color="gray"
                            leftSection={<IconPlus size={12} />}
                            onClick={() => setCcInputOpen(true)}
                            disabled={!connected}
                        >
                            CC {t('emailReplies.reply.addCc', 'Ekle')}
                        </Button>
                    )}
                </Box>

                {/* Body */}
                <Box>
                    <Text size="xs" fw={600} c="dimmed" mb={4} tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                        {t('emailReplies.compose.body', 'Mesaj')}
                    </Text>
                    <Textarea
                        placeholder={t('emailReplies.compose.bodyPlaceholder', 'Mailinizi yazın...')}
                        value={body}
                        onChange={(e) => setBody(e.currentTarget.value)}
                        minRows={5}
                        maxRows={15}
                        autosize
                        disabled={!connected}
                        styles={{ input: { fontSize: 13, lineHeight: 1.6 } }}
                    />
                </Box>

                {/* Attachments */}
                {attachmentTemplates.length > 0 && (
                    <Box pt={4} style={{ borderTop: '1px solid #f1f3f5' }}>
                        <Group justify="space-between" mb={6} mt={6}>
                            <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.06em' }}>
                                {t('emailReplies.attachments.label', 'Eklentiler')}
                            </Text>
                        </Group>
                        <Group gap={6}>
                            {attachmentTemplates.map((tmpl) => {
                                const isSelected = selectedAttachments.includes(tmpl.id);
                                return (
                                    <Box
                                        key={tmpl.id}
                                        onClick={() => connected && setSelectedAttachments((prev) =>
                                            isSelected ? prev.filter((x) => x !== tmpl.id) : [...prev, tmpl.id]
                                        )}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 6,
                                            border: `1px solid ${isSelected ? '#7c3aed' : '#e8e8f0'}`,
                                            borderRadius: 8, padding: '6px 10px',
                                            cursor: connected ? 'pointer' : 'not-allowed',
                                            background: isSelected ? '#f5f3ff' : '#fafafe',
                                            opacity: connected ? 1 : 0.5,
                                        }}
                                    >
                                        <Checkbox checked={isSelected} onChange={() => {}} size="xs" color="violet" />
                                        <IconPaperclip size={12} color={isSelected ? '#7c3aed' : '#888'} />
                                        <Text size="xs" fw={isSelected ? 600 : 400}>{tmpl.label}</Text>
                                    </Box>
                                );
                            })}
                        </Group>
                    </Box>
                )}

                <Divider />

                {/* Actions */}
                <Group justify="flex-end" gap="xs">
                    <Button variant="subtle" color="gray" size="sm" onClick={onClose}>
                        {t('emailReplies.compose.cancel', 'İptal')}
                    </Button>
                    <Button
                        color="violet"
                        size="sm"
                        leftSection={<IconSend size={14} />}
                        loading={sendMutation.isPending}
                        disabled={!canSend}
                        onClick={() => sendMutation.mutate()}
                    >
                        {t('emailReplies.compose.send', 'Gönder')}
                        {selectedAttachments.length > 0 && (
                            <Badge size="xs" variant="filled" color="white" c="violet" ml={4}>
                                +{selectedAttachments.length}
                            </Badge>
                        )}
                    </Button>
                </Group>

                {!connected && !connLoading && (
                    <Anchor href="/settings" size="xs" c="violet" ta="center">
                        {t('emailReplies.compose.goToSettings', 'Ayarlara git')}
                    </Anchor>
                )}
            </Stack>
        </Modal>
    );
}
