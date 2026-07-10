import { useQuery } from '@tanstack/react-query';
import { Group, Stack, Text, Tooltip, Anchor } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import type { MailboxHealthStats, MailboxWindowStats } from '../../types/campaign';

interface MailboxHealthRowProps {
    connectionId: string;
}

/** Oran → yüzde metni; null (veri yok) → em-dash. */
function pct(r: number | null): string {
    if (r == null) return '—';
    return `${(r * 100).toFixed(1)}%`;
}

/** Bounce eşikleri: >%2 kırmızı, >%1 sarı, aksi halde vurgusuz. */
function bounceColor(r: number | null): string | undefined {
    if (r == null) return undefined;
    if (r > 0.02) return 'red';
    if (r > 0.01) return 'yellow';
    return undefined;
}

/** Abonelikten çıkma eşiği: >%1 sarı. */
function unsubColor(r: number | null): string | undefined {
    if (r == null) return undefined;
    if (r > 0.01) return 'yellow';
    return undefined;
}

export default function MailboxHealthRow({ connectionId }: MailboxHealthRowProps) {
    const { t } = useTranslation();

    const { data } = useQuery<MailboxHealthStats>({
        queryKey: ['mailbox-health', connectionId],
        queryFn: async () => {
            const r = await api.get(`/email-connections/${connectionId}/health-stats`);
            return r.data;
        },
        staleTime: 5 * 60 * 1000,
        retry: false,
    });

    // Hiç gönderim geçmişi yoksa satırı gizle (yeni bağlanan kutu için gürültü olmasın).
    if (!data || !data.hasHistory) return null;

    const windows: Array<{ label: string; w: MailboxWindowStats }> = [
        { label: t('campaign.mailboxHealth.window7', '7 gün'), w: data.d7 },
        { label: t('campaign.mailboxHealth.window30', '30 gün'), w: data.d30 },
    ];

    return (
        <Stack gap={2} mt={4}>
            {windows.map(({ label, w }) => (
                <Group key={label} gap={8} wrap="wrap">
                    <Text size="xs" c="dimmed" fw={600} style={{ minWidth: 34 }}>{label}</Text>

                    <Tooltip
                        label={t('campaign.mailboxHealth.sentTip', 'Bu kutudan gönderilen kampanya maili (geri dönenler dahil).')}
                        withArrow multiline w={220}
                    >
                        <Text size="xs">
                            {w.sent} {t('campaign.mailboxHealth.sent', 'gönderim')}
                        </Text>
                    </Tooltip>

                    <Text size="xs" c="dimmed">·</Text>

                    <Tooltip
                        label={t('campaign.mailboxHealth.bounceTip', 'Kalıcı olarak geri dönen (geçersiz adres) mail oranı. %2 üzeri kutu itibarını ciddi riske atar, %1 üzeri dikkat gerektirir.')}
                        withArrow multiline w={240}
                    >
                        <Text size="xs" c={bounceColor(w.bounceRate)} fw={bounceColor(w.bounceRate) ? 600 : undefined}>
                            {t('campaign.mailboxHealth.bounce', 'bounce')} {pct(w.bounceRate)}
                        </Text>
                    </Tooltip>

                    <Text size="xs" c="dimmed">·</Text>

                    <Tooltip
                        label={t('campaign.mailboxHealth.replyTip', 'Yanıt veren benzersiz alıcı oranı.')}
                        withArrow multiline w={220}
                    >
                        <Text size="xs">
                            {t('campaign.mailboxHealth.reply', 'yanıt')} {pct(w.replyRate)}
                        </Text>
                    </Tooltip>

                    <Text size="xs" c="dimmed">·</Text>

                    <Tooltip
                        label={t('campaign.mailboxHealth.unsubTip', 'Abonelikten çıkan benzersiz alıcı oranı. %1 üzeri içerik veya hedefleme sorununa işaret eder.')}
                        withArrow multiline w={240}
                    >
                        <Text size="xs" c={unsubColor(w.unsubRate)} fw={unsubColor(w.unsubRate) ? 600 : undefined}>
                            {t('campaign.mailboxHealth.unsub', 'çıkış')} {pct(w.unsubRate)}
                        </Text>
                    </Tooltip>
                </Group>
            ))}

            {data.sendsToGmail && (
                <Text size="xs" c="dimmed" mt={2}>
                    {t('campaign.mailboxHealth.postmasterNote', 'Gmail alıcılarına gönderiyorsunuz. Gönderen itibarınızı izlemek için alan adınızı')}{' '}
                    <Anchor href="https://postmaster.google.com" target="_blank" rel="noopener noreferrer" size="xs">
                        {t('campaign.mailboxHealth.postmasterLink', 'Google Postmaster Tools')}
                    </Anchor>
                    {t('campaign.mailboxHealth.postmasterNoteEnd', ' aracına ekleyebilirsiniz.')}
                </Text>
            )}
        </Stack>
    );
}
