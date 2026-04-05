import { useQuery } from '@tanstack/react-query';
import { Table, Text, Center, Loader } from '@mantine/core';
import api from '../../lib/api';
import type { ThreadHistoryItem } from '../../types/emailReply';

interface ThreadHistoryRowsProps {
    senderEmail: string;
    campaignId: string | null;
    excludeId: string;
    locale: string;
    colSpan: number;
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
    excludeId,
    locale,
    colSpan,
}: ThreadHistoryRowsProps) {
    const { data, isLoading } = useQuery<ThreadHistoryItem[]>({
        queryKey: ['email-reply-thread', senderEmail, campaignId, excludeId],
        queryFn: async () => {
            const params: Record<string, string> = {
                sender_email: senderEmail,
                exclude_id: excludeId,
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

    return (data || []).map((h) => {
        const isOut = h.direction === 'OUT';
        return (
            <Table.Tr
                key={h.id}
                style={{ backgroundColor: isOut ? 'var(--mantine-color-violet-0)' : 'var(--mantine-color-gray-0)' }}
            >
                <Table.Td />
                <Table.Td />
                <Table.Td colSpan={2}>
                    <Text size="xs" c={isOut ? 'violet' : 'dimmed'} pl="md" fw={isOut ? 500 : 400}>
                        {isOut ? '↱ ' : '↳ '}{formatDate(h.replied_at, locale)}{isOut ? ' (sent)' : ''}
                    </Text>
                </Table.Td>
                <Table.Td colSpan={colSpan - 4}>
                    <Text size="xs" c={isOut ? 'violet.6' : 'dimmed'} lineClamp={1}>
                        {truncate(h.reply_body, 100)}
                    </Text>
                </Table.Td>
            </Table.Tr>
        );
    });
}
