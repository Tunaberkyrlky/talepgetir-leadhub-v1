import { useQuery } from '@tanstack/react-query';
import { Table, Text, Center, Loader, Badge, Group } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import TrackingBadges from './TrackingBadges';
import type { ThreadHistoryItem } from '../../types/emailReply';

interface ThreadHistoryRowsProps {
    senderEmail: string;
    campaignId: string | null;
    parentReplyId: string;
    locale: string;
    colSpan: number;
    onClickRow?: (item: ThreadHistoryItem) => void;
}

function formatDate(iso: string, locale: string): string {
    return new Date(iso).toLocaleDateString(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function truncate(text: string | null, maxLen: number): string {
    if (!text) return '';
    return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

export default function ThreadHistoryRows({
    senderEmail,
    campaignId,
    parentReplyId,
    locale,
    colSpan,
    onClickRow,
}: ThreadHistoryRowsProps) {
    const { t } = useTranslation();
    const { data, isLoading } = useQuery<ThreadHistoryItem[]>({
        queryKey: ['email-reply-thread', senderEmail, campaignId],
        queryFn: async () => {
            const params: Record<string, string> = {
                sender_email: senderEmail,
            };
            if (campaignId) params.campaign_id = campaignId;
            return (await api.get('/email-replies/thread-history', { params })).data;
        },
        staleTime: 60_000,
    });

    if (isLoading) {
        return (
            <Table.Tr>
                <Table.Td colSpan={colSpan}>
                    <Center py="xs">
                        <Loader size="xs" color="gray" />
                    </Center>
                </Table.Td>
            </Table.Tr>
        );
    }

    const items = data || [];
    if (items.length === 0) {
        return (
            <Table.Tr>
                <Table.Td colSpan={colSpan}>
                    <Text size="xs" c="dimmed" ta="center" py={6}>—</Text>
                </Table.Td>
            </Table.Tr>
        );
    }

    return items.map((h) => {
        const isOut = h.direction === 'OUT';
        const isCurrent = h.id === parentReplyId;
        const isForward = h.raw_payload?.source === 'user_forward';
        const forwardedTo = h.raw_payload?.forwarded_to;
        return (
            <Table.Tr
                key={h.id}
                style={{
                    backgroundColor: isCurrent
                        ? 'var(--mantine-color-violet-1)'
                        : (isOut ? 'var(--mantine-color-gray-0)' : 'var(--mantine-color-violet-0)'),
                    cursor: onClickRow ? 'pointer' : undefined,
                }}
                onClick={onClickRow ? () => onClickRow(h) : undefined}
            >
                <Table.Td
                    style={{
                        padding: '0 4px 0 14px',
                        width: 20,
                        borderLeft: isCurrent
                            ? '3px solid var(--mantine-color-violet-6)'
                            : '3px solid var(--mantine-color-violet-4)',
                    }}
                >
                    {!isOut && (
                        <Text size="xs" c="dimmed" ta="center">↓</Text>
                    )}
                </Table.Td>
                <Table.Td colSpan={3}>
                    <Group gap={6} wrap="nowrap">
                        <Badge
                            size="xs"
                            variant="light"
                            color={isForward ? 'yellow' : (isOut ? 'gray' : 'violet')}
                            style={{ flexShrink: 0 }}
                        >
                            {isForward
                                ? t('emailReplies.thread.forwarded')
                                : (isOut ? t('emailReplies.thread.sent') : t('emailReplies.thread.received'))}
                        </Badge>
                        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                            {formatDate(h.replied_at, locale)}
                        </Text>
                        {isOut && <TrackingBadges tracking={h.tracking} locale={locale} />}
                        {isForward && forwardedTo && (
                            <Text size="xs" c="#92400e" fw={500} style={{ whiteSpace: 'nowrap' }}>
                                → {forwardedTo}
                            </Text>
                        )}
                    </Group>
                </Table.Td>
                <Table.Td colSpan={colSpan - 4}>
                    <Text
                        size="xs"
                        c="dimmed"
                        lineClamp={1}
                        fw={isCurrent ? 500 : 400}
                    >
                        {truncate(h.reply_body, 120)}
                    </Text>
                </Table.Td>
            </Table.Tr>
        );
    });
}
