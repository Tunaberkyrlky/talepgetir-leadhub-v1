import { useQuery } from '@tanstack/react-query';
import { Stack, Text, Badge, Group } from '@mantine/core';
import { IconPlugConnected, IconPlugConnectedX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import type { PlusVibeStatus } from '../../types/plusvibe';

export default function PlusVibeSetup() {
    const { t } = useTranslation();

    const { data: status, isLoading } = useQuery<PlusVibeStatus>({
        queryKey: ['plusvibe', 'status'],
        queryFn: async () => (await api.get('/plusvibe/status')).data,
    });

    if (isLoading) return null;

    return (
        <Stack gap="sm">
            <Group gap="xs">
                <Text size="sm" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.5px' }}>
                    {t('plusvibe.setup.title')}
                </Text>
                <Badge
                    size="sm"
                    variant="light"
                    color={status?.connected ? 'green' : 'red'}
                    leftSection={status?.connected
                        ? <IconPlugConnected size={12} />
                        : <IconPlugConnectedX size={12} />
                    }
                >
                    {status?.connected
                        ? t('plusvibe.setup.statusConnected')
                        : t('plusvibe.setup.statusDisconnected')
                    }
                </Badge>
            </Group>
            <Text size="xs" c="dimmed">
                {status?.configured
                    ? t('plusvibe.setup.configuredViaEnv')
                    : t('plusvibe.setup.notConfigured')
                }
            </Text>
        </Stack>
    );
}
