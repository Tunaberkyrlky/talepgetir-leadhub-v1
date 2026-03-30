import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
    Container, Title, Group, Stack, Paper, Text, Badge, Table,
    Loader, Center, Button, SimpleGrid, Select, TextInput,
    Skeleton, Tooltip,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useDebouncedValue } from '@mantine/hooks';
import {
    IconMail, IconMailOpened, IconSearch,
    IconCircleFilled, IconLink, IconLinkOff,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import StatCard from '../components/StatCard';
import ReplyDetailModal from '../components/email/ReplyDetailModal';
import type { EmailReply, EmailReplyStats, Campaign } from '../types/emailReply';

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface EmailRepliesResponse {
    data: EmailReply[];
    pagination: {
        hasNext: boolean;
        total: number;
        page: number;
    };
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function toLocalDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
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

// ─── Main Component ──────────────────────────────────────────────────────────

export default function EmailRepliesPage() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';

    // Filters
    const [campaignFilter, setCampaignFilter] = useState('');
    const [matchStatusFilter, setMatchStatusFilter] = useState('');
    const [readStatusFilter, setReadStatusFilter] = useState('');
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 300);
    const [dateRange, setDateRange] = useState<[Date | null, Date | null]>([null, null]);

    // Pagination
    const [page, setPage] = useState(1);

    // Selected reply (for modal — wired in Task 9)
    const [selectedReply, setSelectedReply] = useState<EmailReply | null>(null);

    // ── Derived ──

    const dateFrom = dateRange[0] ? toLocalDateStr(dateRange[0]) : '';
    const dateTo = dateRange[1] ? `${toLocalDateStr(dateRange[1])}T23:59:59` : '';

    // ── Queries ──

    const { data, isLoading } = useQuery<EmailRepliesResponse>({
        queryKey: [
            'email-replies',
            page,
            campaignFilter,
            matchStatusFilter,
            readStatusFilter,
            debouncedSearch,
            dateFrom,
            dateTo,
        ],
        queryFn: async () => {
            const params: Record<string, string> = {
                page: String(page),
                limit: '20',
            };
            if (campaignFilter) params.campaign_id = campaignFilter;
            if (matchStatusFilter) params.match_status = matchStatusFilter;
            if (readStatusFilter) params.read_status = readStatusFilter;
            if (debouncedSearch) params.search = debouncedSearch;
            if (dateFrom) params.date_from = dateFrom;
            if (dateTo) params.date_to = dateTo;
            return (await api.get('/email-replies', { params })).data;
        },
        refetchOnWindowFocus: false,
    });

    const { data: stats, isLoading: statsLoading } = useQuery<EmailReplyStats>({
        queryKey: ['email-replies-stats'],
        queryFn: async () => (await api.get('/email-replies/stats')).data,
    });

    const { data: campaigns } = useQuery<Campaign[]>({
        queryKey: ['email-replies-campaigns'],
        queryFn: async () => (await api.get('/email-replies/campaigns')).data,
    });

    // ── Filter change helpers (reset page) ──

    const resetPage = () => setPage(1);

    // ── Displayed replies ──

    const displayedReplies = useMemo(() => data?.data ?? [], [data]);

    const hasMore = data?.pagination?.hasNext ?? false;
    const total = data?.pagination?.total ?? 0;

    // ── Select Data ──

    const campaignSelectData = (campaigns || []).map((c) => ({
        value: c.campaign_id,
        label: c.campaign_name,
    }));

    const matchStatusData = [
        { value: 'matched', label: t('emailReplies.status.matched') },
        { value: 'unmatched', label: t('emailReplies.status.unmatched') },
    ];

    const readStatusData = [
        { value: 'read', label: t('emailReplies.status.read') },
        { value: 'unread', label: t('emailReplies.status.unread') },
    ];

    // ── Render ──

    return (
        <Container size="xl" py="xl">
            {/* Header */}
            <Group justify="space-between" mb="lg">
                <Group gap="xs">
                    <Title order={2}>{t('emailReplies.pageTitle')}</Title>
                    <Badge size="lg" variant="light" color="violet" circle>
                        {total}
                    </Badge>
                </Group>
            </Group>

            {/* Stats Cards */}
            <SimpleGrid cols={{ base: 2, sm: 4 }} mb="lg">
                {statsLoading ? (
                    <>
                        <Skeleton height={100} radius="lg" />
                        <Skeleton height={100} radius="lg" />
                        <Skeleton height={100} radius="lg" />
                        <Skeleton height={100} radius="lg" />
                    </>
                ) : (
                    <>
                        <StatCard
                            title={t('emailReplies.stats.total')}
                            value={stats?.total ?? 0}
                            icon={<IconMail size={22} />}
                            color="violet"
                        />
                        <StatCard
                            title={t('emailReplies.stats.unread')}
                            value={stats?.unread ?? 0}
                            icon={<IconMailOpened size={22} />}
                            color="blue"
                        />
                        <StatCard
                            title={t('emailReplies.stats.matched')}
                            value={stats?.matched ?? 0}
                            icon={<IconLink size={22} />}
                            color="green"
                        />
                        <StatCard
                            title={t('emailReplies.stats.unmatched')}
                            value={stats?.unmatched ?? 0}
                            icon={<IconLinkOff size={22} />}
                            color="red"
                        />
                    </>
                )}
            </SimpleGrid>

            {/* Filter Bar */}
            <Paper p="md" radius="md" withBorder mb="md">
                <Stack gap="sm">
                    <Group gap="sm" wrap="wrap">
                        <TextInput
                            size="sm"
                            placeholder={t('emailReplies.filters.search')}
                            leftSection={<IconSearch size={16} />}
                            value={search}
                            onChange={(e) => setSearch(e.currentTarget.value)}
                            style={{ flex: 1, minWidth: 200 }}
                        />
                        <Select
                            size="sm"
                            placeholder={t('emailReplies.filters.allCampaigns')}
                            clearable
                            searchable
                            value={campaignFilter || null}
                            onChange={(v) => { setCampaignFilter(v || ''); resetPage(); }}
                            data={campaignSelectData}
                            style={{ minWidth: 180 }}
                        />
                        <Select
                            size="sm"
                            placeholder={t('emailReplies.filters.allMatchStatuses')}
                            clearable
                            value={matchStatusFilter || null}
                            onChange={(v) => { setMatchStatusFilter(v || ''); resetPage(); }}
                            data={matchStatusData}
                            style={{ minWidth: 160 }}
                        />
                        <Select
                            size="sm"
                            placeholder={t('emailReplies.filters.allReadStatuses')}
                            clearable
                            value={readStatusFilter || null}
                            onChange={(v) => { setReadStatusFilter(v || ''); resetPage(); }}
                            data={readStatusData}
                            style={{ minWidth: 160 }}
                        />
                        <DatePickerInput
                            type="range"
                            placeholder={t('emailReplies.filters.dateRange')}
                            value={dateRange}
                            onChange={(v) => { setDateRange(v as [Date | null, Date | null]); resetPage(); }}
                            clearable
                            size="sm"
                            style={{ minWidth: 220 }}
                        />
                    </Group>
                </Stack>
            </Paper>

            {/* Table */}
            {isLoading && displayedReplies.length === 0 ? (
                <Center py="xl">
                    <Loader size="md" color="violet" />
                </Center>
            ) : displayedReplies.length === 0 ? (
                <Center py="xl">
                    <Stack align="center" gap="xs">
                        <Text c="dimmed" fs="italic">
                            {t('emailReplies.noData')}
                        </Text>
                        <Text size="xs" c="dimmed">
                            {t('emailReplies.noDataDescription')}
                        </Text>
                    </Stack>
                </Center>
            ) : (
                <Stack gap="md">
                    <Paper radius="md" withBorder style={{ overflow: 'auto' }}>
                        <Table highlightOnHover striped>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th style={{ width: 30 }} />
                                    <Table.Th>{t('emailReplies.table.campaign')}</Table.Th>
                                    <Table.Th>{t('emailReplies.table.sender')}</Table.Th>
                                    <Table.Th>{t('emailReplies.table.company')}</Table.Th>
                                    <Table.Th>{t('emailReplies.table.contact')}</Table.Th>
                                    <Table.Th>{t('emailReplies.table.preview')}</Table.Th>
                                    <Table.Th>{t('emailReplies.table.date')}</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {displayedReplies.map((reply) => {
                                    const isUnread = reply.read_status === 'unread';
                                    const isUnmatched = reply.match_status === 'unmatched';

                                    return (
                                        <Table.Tr
                                            key={reply.id}
                                            style={{
                                                cursor: 'pointer',
                                                backgroundColor: isUnread
                                                    ? 'var(--mantine-color-blue-0)'
                                                    : undefined,
                                            }}
                                            onClick={() => setSelectedReply(reply)}
                                        >
                                            {/* Unread indicator */}
                                            <Table.Td>
                                                {isUnread && (
                                                    <Tooltip label={t('emailReplies.status.unread')}>
                                                        <IconCircleFilled
                                                            size={10}
                                                            style={{ color: 'var(--mantine-color-blue-5)' }}
                                                        />
                                                    </Tooltip>
                                                )}
                                            </Table.Td>

                                            {/* Campaign */}
                                            <Table.Td>
                                                {reply.campaign_name ? (
                                                    <Badge size="sm" variant="light" color="violet">
                                                        {reply.campaign_name}
                                                    </Badge>
                                                ) : (
                                                    <Text size="xs" c="dimmed">-</Text>
                                                )}
                                            </Table.Td>

                                            {/* Sender Email */}
                                            <Table.Td>
                                                <Text size="sm" fw={isUnread ? 600 : 400}>
                                                    {reply.sender_email}
                                                </Text>
                                            </Table.Td>

                                            {/* Company */}
                                            <Table.Td>
                                                {isUnmatched ? (
                                                    <Badge size="sm" variant="light" color="red">
                                                        {t('emailReplies.status.unmatched')}
                                                    </Badge>
                                                ) : reply.company_name ? (
                                                    <Text
                                                        size="sm"
                                                        c="blue"
                                                        fw={500}
                                                        style={{ cursor: 'pointer' }}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            navigate(`/companies/${reply.company_id}`);
                                                        }}
                                                    >
                                                        {reply.company_name}
                                                    </Text>
                                                ) : (
                                                    <Text size="xs" c="dimmed">-</Text>
                                                )}
                                            </Table.Td>

                                            {/* Contact */}
                                            <Table.Td>
                                                <Text size="sm">
                                                    {reply.contact_name || '-'}
                                                </Text>
                                            </Table.Td>

                                            {/* Reply Preview */}
                                            <Table.Td>
                                                <Text size="xs" c="dimmed" lineClamp={1}>
                                                    {truncate(reply.reply_body, 80)}
                                                </Text>
                                            </Table.Td>

                                            {/* Date */}
                                            <Table.Td>
                                                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                                                    {formatDate(reply.replied_at, locale)}
                                                </Text>
                                            </Table.Td>
                                        </Table.Tr>
                                    );
                                })}
                            </Table.Tbody>
                        </Table>
                    </Paper>

                    {/* Load More */}
                    {hasMore && (
                        <Center>
                            <Button
                                variant="subtle"
                                color="gray"
                                loading={isLoading}
                                onClick={() => setPage((p) => p + 1)}
                            >
                                {t('emailReplies.loadMore')}
                            </Button>
                        </Center>
                    )}
                </Stack>
            )}
            {/* Reply Detail Modal */}
            <ReplyDetailModal
                reply={selectedReply}
                opened={!!selectedReply}
                onClose={() => setSelectedReply(null)}
            />
        </Container>
    );
}
