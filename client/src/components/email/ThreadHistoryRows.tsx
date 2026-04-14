import { useQuery } from '@tanstack/react-query';
import { Table, Text, Center, Loader, Badge, Group } from '@mantine/core';
import api from '../../lib/api';
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
        return (
            <Table.Tr
                key={h.id}
                style={{
                    backgroundColor: isOut ? 'var(--mantine-color-violet-0)' : 'var(--mantine-color-gray-0)',
                    cursor: onClickRow ? 'pointer' : undefined,
                }}
                onClick={onClickRow ? () => onClickRow(h) : undefined}
            >
                <Table.Td style={{ padding: '0 4px', width: 20 }}>
                    <Text size="xs" c={isOut ? 'violet' : 'dimmed'} ta="center">
                        {isOut ? '↑' : '↓'}
                    </Text>
                </Table.Td>
                <Table.Td colSpan={2}>
                    <Group gap={6} wrap="nowrap">
                        <Badge
                            size="xs"
                            variant={isOut ? 'filled' : 'light'}
                            color={isOut ? 'violet' : 'gray'}
                            style={{ flexShrink: 0 }}
                        >
                            {isOut ? 'Sent' : 'Received'}
                        </Badge>
                        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                            {formatDate(h.replied_at, locale)}
                        </Text>
                        {isCurrent && (
                            <Badge size="xs" variant="outline" color="blue" style={{ flexShrink: 0 }}>●</Badge>
                        )}
                    </Group>
                </Table.Td>
                <Table.Td colSpan={colSpan - 3}>
                    <Text size="xs" c={isOut ? 'violet.6' : 'dimmed'} lineClamp={1} fw={isCurrent ? 500 : 400}>
                        {truncate(h.reply_body, 120)}
                    </Text>
                </Table.Td>
            </Table.Tr>
        );
    });
}
