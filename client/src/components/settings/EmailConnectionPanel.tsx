import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Paper, Group, Stack, Text, Button, Title, Alert, Badge, ActionIcon, Tooltip } from '@mantine/core';
import {
    IconMail, IconBrandGoogle, IconBrandWindows, IconServer, IconTrash,
    IconCheck, IconAlertCircle, IconStar, IconStarFilled,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import Nango from '@nangohq/frontend';
import api from '../../lib/api';
import { showSuccess, showError, showErrorFromApi } from '../../lib/notifications';
import { useAuth } from '../../contexts/AuthContext';
import type { EmailConnectionStatus, EmailConnectionItem, ConnectionProvider } from '../../types/campaign';
import SmtpConnectionModal from './SmtpConnectionModal';
import GmailConnectModal from './GmailConnectModal';
import DomainHealthBadges from './DomainHealthBadges';

function providerLabel(p: ConnectionProvider): string {
    if (p === 'google-mail') return 'Gmail';
    if (p === 'microsoft-outlook') return 'Outlook';
    return 'SMTP';
}

function ProviderIcon({ p }: { p: ConnectionProvider }) {
    if (p === 'google-mail') return <IconBrandGoogle size={16} />;
    if (p === 'microsoft-outlook') return <IconBrandWindows size={16} />;
    return <IconServer size={16} />;
}

export default function EmailConnectionPanel() {
    const { t } = useTranslation();
    const { activeTenantId } = useAuth();
    const qc = useQueryClient();
    const [connecting, setConnecting] = useState(false);
    const [smtpOpen, setSmtpOpen] = useState(false);
    const [gmailOpen, setGmailOpen] = useState(false);

    const { data: status } = useQuery<EmailConnectionStatus>({
        queryKey: ['email-connection-status'],
        queryFn: async () => { const r = await api.get('/email-connections/status'); return r.data; },
    });

    const connections: EmailConnectionItem[] = status?.connections ?? [];

    const disconnectMut = useMutation<unknown, unknown, string>({
        mutationFn: (id) => api.delete(`/email-connections/${id}`),
        onSuccess: () => { showSuccess(t('campaign.emailDisconnected', 'Hesap kaldırıldı')); qc.invalidateQueries({ queryKey: ['email-connection-status'] }); },
        onError: (err) => showErrorFromApi(err),
    });

    const setDefaultMut = useMutation<unknown, unknown, string>({
        mutationFn: (id) => api.patch(`/email-connections/${id}/default`),
        onSuccess: () => { showSuccess(t('campaign.defaultSet', 'Varsayılan hesap güncellendi')); qc.invalidateQueries({ queryKey: ['email-connection-status'] }); },
        onError: (err) => showErrorFromApi(err),
    });

    const handleConnect = async (provider: 'google-mail' | 'microsoft-outlook') => {
        if (!activeTenantId) {
            showError(t('campaign.noActiveTenant', 'No active tenant selected'));
            return;
        }
        setConnecting(true);
        try {
            const { data: session } = await api.post('/email-connections/start-session', { provider });
            const token = session?.token as string | undefined;
            if (!token) throw new Error('No session token returned');
            const nango = new Nango({ connectSessionToken: token });
            const result = await nango.auth(provider);
            const connectionId = (result as { connectionId?: string } | undefined)?.connectionId;
            if (!connectionId) throw new Error('Nango auth did not return a connectionId');
            await api.post('/email-connections/callback', { provider, connectionId });
            qc.invalidateQueries({ queryKey: ['email-connection-status'] });
            showSuccess(t('campaign.emailConnected', 'Email connected'));
        } catch (err) {
            showErrorFromApi(err);
        } finally {
            setConnecting(false);
        }
    };

    return (
        <Paper shadow="sm" radius="lg" p="xl" withBorder>
            <Stack gap="lg">
                <Group gap="xs">
                    <IconMail size={20} color="var(--mantine-color-violet-6)" />
                    <Title order={4} fw={600}>{t('campaign.emailConnection', 'E-posta Bağlantısı')}</Title>
                </Group>

                <Text size="sm" c="dimmed">
                    {t('campaign.emailConnectionDescMulti', 'Gmail/Outlook hesabınızı bağlayın veya kendi SMTP sunucunuzu ekleyin. Birden fazla hesap ekleyebilirsiniz.')}
                </Text>

                {/* Connected accounts list */}
                {connections.length > 0 && (
                    <Stack gap="xs">
                        {connections.map((c) => (
                            <Paper key={c.id} p="sm" radius="md" withBorder bg="gray.0">
                                <Group justify="space-between" wrap="nowrap">
                                    <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                                        <ProviderIcon p={c.provider} />
                                        <div style={{ minWidth: 0 }}>
                                            <Group gap={6}>
                                                <Text size="sm" fw={600} truncate>{c.email_address}</Text>
                                                {c.is_default && (
                                                    <Badge size="xs" color="violet" variant="light">
                                                        {t('campaign.default', 'Varsayılan')}
                                                    </Badge>
                                                )}
                                            </Group>
                                            <Text size="xs" c="dimmed">
                                                {providerLabel(c.provider)}
                                                {c.imap_host && ` · ${t('campaign.imapReading', 'Yanıt okuma açık')}`}
                                            </Text>
                                            {typeof c.ramp_cap === 'number' && (
                                                <Text size="xs" c="dimmed">
                                                    {t('campaign.rampCapHint', 'Bugünkü otomatik limit: {{cap}}/gün', { cap: c.ramp_cap })}
                                                </Text>
                                            )}
                                            <DomainHealthBadges connectionId={c.id} />
                                        </div>
                                    </Group>
                                    <Group gap={4} wrap="nowrap">
                                        {!c.is_default && (
                                            <Tooltip label={t('campaign.makeDefault', 'Varsayılan yap')}>
                                                <ActionIcon variant="subtle" color="violet" size="sm"
                                                    loading={setDefaultMut.isPending}
                                                    onClick={() => setDefaultMut.mutate(c.id)}>
                                                    <IconStar size={15} />
                                                </ActionIcon>
                                            </Tooltip>
                                        )}
                                        {c.is_default && <IconStarFilled size={15} color="var(--mantine-color-violet-6)" />}
                                        <Tooltip label={t('campaign.disconnect', 'Kaldır')}>
                                            <ActionIcon variant="subtle" color="red" size="sm"
                                                loading={disconnectMut.isPending}
                                                onClick={() => disconnectMut.mutate(c.id)}>
                                                <IconTrash size={15} />
                                            </ActionIcon>
                                        </Tooltip>
                                    </Group>
                                </Group>
                            </Paper>
                        ))}
                    </Stack>
                )}

                {/* Add account buttons */}
                <div>
                    <Text size="xs" fw={600} c="dimmed" mb={6} tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                        {t('campaign.addAccount', 'Hesap Ekle')}
                    </Text>
                    <Group grow>
                        <Button variant="outline" size="sm" radius="md" leftSection={<IconBrandGoogle size={16} />}
                            onClick={() => setGmailOpen(true)}>
                            Gmail
                        </Button>
                        <Button variant="outline" size="sm" radius="md" leftSection={<IconBrandWindows size={16} />}
                            onClick={() => handleConnect('microsoft-outlook')} loading={connecting}>
                            Outlook
                        </Button>
                        <Button variant="outline" size="sm" radius="md" leftSection={<IconServer size={16} />}
                            onClick={() => setSmtpOpen(true)}>
                            SMTP
                        </Button>
                    </Group>
                </div>

                {connections.length === 0 && (
                    <Alert variant="light" color="blue" icon={<IconAlertCircle size={16} />}>
                        <Text size="xs">
                            {t('campaign.noConnectionHint', 'Henüz bağlı hesap yok. Kampanya ve mail gönderimi için en az bir hesap bağlayın.')}
                        </Text>
                    </Alert>
                )}

                {connections.length > 0 && (
                    <Alert variant="light" color="green" icon={<IconCheck size={16} />}>
                        <Text size="xs">
                            Gmail free: 500/gün · Workspace: 2.000/gün · Outlook: 10.000/gün · SMTP: 300/gün
                        </Text>
                    </Alert>
                )}
            </Stack>

            <SmtpConnectionModal opened={smtpOpen} onClose={() => setSmtpOpen(false)} />
            <GmailConnectModal opened={gmailOpen} onClose={() => setGmailOpen(false)} />
        </Paper>
    );
}
