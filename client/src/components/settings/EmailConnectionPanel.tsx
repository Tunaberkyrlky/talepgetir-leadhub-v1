import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Paper, Group, Stack, Text, Button, Title, Alert } from '@mantine/core';
import {
    IconMail, IconBrandGoogle, IconBrandWindows, IconPlugConnectedX, IconCheck, IconAlertCircle,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';
import { useAuth } from '../../contexts/AuthContext';
import type { EmailConnectionStatus } from '../../types/campaign';

export default function EmailConnectionPanel() {
    const { t } = useTranslation();
    useAuth(); // activeTenantId will be used as Nango connectionId when OAuth is deployed
    const qc = useQueryClient();
    const [connecting, setConnecting] = useState(false);

    const { data: status } = useQuery<EmailConnectionStatus>({
        queryKey: ['email-connection-status'],
        queryFn: async () => { const r = await api.get('/email-connections/status'); return r.data; },
    });

    const disconnectMut = useMutation<unknown, unknown, void>({
        mutationFn: () => api.delete('/email-connections'),
        onSuccess: () => { showSuccess(t('campaign.emailDisconnected', 'Email disconnected')); qc.invalidateQueries({ queryKey: ['email-connection-status'] }); },
        onError: (err) => showErrorFromApi(err),
    });

    const handleConnect = async (provider: 'google-mail' | 'microsoft-outlook') => {
        setConnecting(true);
        try {
            // In production: Nango frontend SDK opens OAuth popup
            // const nangoFrontend = new Nango({ publicKey: import.meta.env.VITE_NANGO_PUBLIC_KEY });
            // await nangoFrontend.auth(provider, activeTenantId);
            // await api.post('/email-connections/callback', { provider });
            // qc.invalidateQueries({ queryKey: ['email-connection-status'] });

            // Placeholder until Nango is deployed:
            alert(`OAuth popup would open for ${provider}.\nConfigure VITE_NANGO_PUBLIC_KEY to enable.`);
        } catch (err) {
            showErrorFromApi(err);
        } finally {
            setConnecting(false);
        }
    };

    const providerLabel = status?.provider === 'google-mail' ? 'Gmail' : 'Outlook';

    return (
        <Paper shadow="sm" radius="lg" p="xl" withBorder>
            <Stack gap="lg">
                <Group gap="xs">
                    <IconMail size={20} color="var(--mantine-color-violet-6)" />
                    <Title order={4} fw={600}>{t('campaign.emailConnection', 'Email Connection')}</Title>
                </Group>

                <Text size="sm" c="dimmed">
                    {t('campaign.emailConnectionDesc', 'Connect your Gmail or Outlook account to send campaign emails.')}
                </Text>

                {status?.connected ? (
                    <Paper p="md" radius="md" bg="green.0" withBorder style={{ borderColor: 'var(--mantine-color-green-3)' }}>
                        <Group justify="space-between">
                            <Group gap="sm">
                                <IconCheck size={18} color="var(--mantine-color-green-7)" />
                                <div>
                                    <Text size="sm" fw={600} c="green.8">{t('campaign.connectedTo', 'Connected to')} {providerLabel}</Text>
                                    <Text size="xs" c="dimmed">{status.email}</Text>
                                </div>
                            </Group>
                            <Button variant="subtle" color="red" size="xs" leftSection={<IconPlugConnectedX size={14} />}
                                onClick={() => disconnectMut.mutate()} loading={disconnectMut.isPending}
                            >{t('campaign.disconnect', 'Disconnect')}</Button>
                        </Group>
                    </Paper>
                ) : (
                    <Group grow>
                        <Button variant="outline" size="md" radius="md" leftSection={<IconBrandGoogle size={18} />}
                            onClick={() => handleConnect('google-mail')} loading={connecting}
                        >Gmail</Button>
                        <Button variant="outline" size="md" radius="md" leftSection={<IconBrandWindows size={18} />}
                            onClick={() => handleConnect('microsoft-outlook')} loading={connecting}
                        >Outlook</Button>
                    </Group>
                )}

                <Alert variant="light" color="blue" icon={<IconAlertCircle size={16} />}>
                    <Text size="xs">
                        Gmail free: 500/day. Workspace: 2,000/day. Outlook: 10,000/day.
                    </Text>
                </Alert>
            </Stack>
        </Paper>
    );
}
