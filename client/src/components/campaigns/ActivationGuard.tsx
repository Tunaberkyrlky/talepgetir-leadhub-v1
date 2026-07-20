import { useQuery } from '@tanstack/react-query';
import { Button, HoverCard, Stack, Group, Text, ThemeIcon, Loader } from '@mantine/core';
import { IconPlayerPlay, IconCheck, IconX, IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';

interface Props {
    emailStepCount: number;
    enrolledCount: number;
    onActivate: () => void;
    loading: boolean;
}

type Severity = 'ok' | 'error' | 'warn' | 'loading';

function CheckRow({ severity, label }: { severity: Severity; label: string }) {
    const map = {
        ok: { color: 'green', icon: <IconCheck size={12} /> },
        error: { color: 'red', icon: <IconX size={12} /> },
        warn: { color: 'yellow', icon: <IconAlertTriangle size={12} /> },
        loading: { color: 'gray', icon: <Loader size={10} color="gray" /> },
    }[severity];
    return (
        <Group gap="xs" wrap="nowrap" align="center">
            <ThemeIcon size="sm" radius="xl" variant="light" color={map.color}>{map.icon}</ThemeIcon>
            <Text size="xs" c={severity === 'error' ? 'red.7' : 'dimmed'}>{label}</Text>
        </Group>
    );
}

/**
 * Aktivasyon ön-kontrol paneli. Backend zaten en az 1 email adımı ve 1 bağlı
 * kutu şartını uyguluyor; bu bileşen bunları kullanıcı tıklamadan önce checklist
 * olarak gösterir. Eksik şart (error) varsa butonu kilitler. Kitle boşluğu yalnız
 * uyarıdır (warn) — aktif kampanyaya sonradan kişi eklenebildiği için engellemez.
 */
export default function ActivationGuard({ emailStepCount, enrolledCount, onActivate, loading }: Props) {
    const { t } = useTranslation();

    const { data, isLoading: connLoading } = useQuery<{ connections?: unknown[] }>({
        queryKey: ['email-connection-status'],
        queryFn: async () => { const r = await api.get('/email-connections/status'); return r.data; },
        staleTime: 60_000,
    });

    const connCount = data?.connections?.length;

    const emailSev: Severity = emailStepCount >= 1 ? 'ok' : 'error';
    const connSev: Severity = connLoading || connCount === undefined ? 'loading' : connCount >= 1 ? 'ok' : 'error';
    const audienceSev: Severity = enrolledCount >= 1 ? 'ok' : 'warn';

    // error varsa aktive edilemez; loading/warn engellemez (backend son sözü söyler)
    const blocked = emailSev === 'error' || connSev === 'error';

    return (
        <HoverCard width={280} position="bottom-end" withArrow shadow="md" openDelay={120} closeDelay={80}>
            <HoverCard.Target>
                {/* div sarmalayıcı: disabled buton hover olaylarını yutmasın */}
                <div>
                    <Button
                        variant="gradient" gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                        radius="md" size="sm" leftSection={<IconPlayerPlay size={16} />}
                        onClick={onActivate} loading={loading} disabled={blocked}
                    >
                        {t('campaign.editor.activate', 'Activate')}
                    </Button>
                </div>
            </HoverCard.Target>
            <HoverCard.Dropdown>
                <Stack gap="xs">
                    <Text size="xs" fw={700}>{t('campaign.activation.title', 'Ready to activate?')}</Text>
                    <CheckRow severity={emailSev} label={t('campaign.activation.emailStep', 'At least one email step')} />
                    <CheckRow severity={connSev} label={t('campaign.activation.connection', 'A connected mailbox')} />
                    <CheckRow
                        severity={audienceSev}
                        label={audienceSev === 'ok'
                            ? t('campaign.activation.audienceCount', { count: enrolledCount, defaultValue: '{{count}} contacts added' })
                            : t('campaign.activation.audienceEmpty', 'No contacts yet (you can add later)')}
                    />
                    {!blocked && (
                        <Text size="xs" c="green.7" fw={600} mt={2}>
                            {t('campaign.activation.ready', 'All set — you can start.')}
                        </Text>
                    )}
                </Stack>
            </HoverCard.Dropdown>
        </HoverCard>
    );
}
