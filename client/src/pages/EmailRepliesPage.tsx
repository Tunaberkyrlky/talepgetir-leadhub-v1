import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
    Container, Title, Group, Stack, Paper, Text, Badge, Table,
    Loader, Center, Button, SimpleGrid, Select, TextInput,
    Skeleton, Tooltip, Alert, Anchor, Pagination, ActionIcon,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useDebouncedValue } from '@mantine/hooks';
import {
    IconMail, IconMailOpened, IconSearch,
    IconCircleFilled, IconLink, IconLinkOff, IconAlertCircle,
    IconSpeakerphone, IconDownload, IconChevronDown, IconChevronRight,
} from '@tabler/icons-react';
import ThreadHistoryRows from '../components/email/ThreadHistoryRows';

import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import StatCard from '../components/StatCard';
import ReplyDetailModal from '../components/email/ReplyDetailModal';
import type { EmailReply, EmailReplyStats, Campaign } from '../types/emailReply';
import type { CampaignsResponse } from '../types/plusvibe';

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface EmailRepliesResponse {
    data: EmailReply[];
    pagination: {
        hasNext: boolean;
        total: number;
        totalPages: number;
        page: number;
        limit: number;
    };
}

// ─── Helper Functions ────────────────────────────────────────────────────────

// Issue 7: include timezone offset so server compares in user's local time, not UTC
function tzOffset(d: Date): string {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
    const mm = String(Math.abs(off) % 60).padStart(2, '0');
    return `${sign}${hh}:${mm}`;
}

function toLocalISOStart(d: Date): string {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}T00:00:00${tzOffset(d)}`;
}

function toLocalISOEnd(d: Date): string {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}T23:59:59${tzOffset(d)}`;
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
    const queryClient = useQueryClient();
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

    // Selected reply (for modal)
    const [selectedReply, setSelectedReply] = useState<EmailReply | null>(null);

    // Expanded thread rows
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

    const toggleExpand = useCallback((id: string) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    }, []);

    // ── Derived ──

    const dateFrom = dateRange[0] ? toLocalISOStart(dateRange[0]) : '';
    const dateTo = dateRange[1] ? toLocalISOEnd(dateRange[1]) : '';

    // ── Queries ──

    const { data, isLoading, error: repliesError } = useQuery<EmailRepliesResponse>({
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

    const { data: stats, isLoading: statsLoading, error: statsError } = useQuery<EmailReplyStats>({
        queryKey: ['email-replies-stats'],
        queryFn: async () => (await api.get('/email-replies/stats')).data,
    });

    const { data: campaigns } = useQuery<Campaign[]>({
        queryKey: ['email-replies-campaigns'],
        queryFn: async () => (await api.get('/email-replies/campaigns')).data,
    });

    // PlusVibe campaign stats (active campaigns assigned to this tenant)
    const { data: pvCampaigns } = useQuery<CampaignsResponse>({
        queryKey: ['plusvibe', 'campaigns', 'active'],
        queryFn: async () => (await api.get('/plusvibe/campaigns', { params: { status: 'ACTIVE' } })).data,
    });

    const activeCampaigns = useMemo(() => pvCampaigns?.data || [], [pvCampaigns]);

    // Assign short codes (#1, #2, ...) to campaigns for compact table display
    const campaignCodeMap = useMemo(() => {
        const map = new Map<string, number>();
        activeCampaigns.forEach((c, i) => {
            if (c.pv_campaign_id) map.set(c.pv_campaign_id, i + 1);
        });
        return map;
    }, [activeCampaigns]);

    // Import historical replies from PlusVibe
    const importMutation = useMutation({
        mutationFn: async () => (await api.post('/plusvibe/import-replies')).data,
        onSuccess: (data: { imported: number; skipped: number }) => {
            if (data.imported === 0 && data.skipped > 0) {
                showSuccess(t('emailReplies.importUpToDate'));
            } else {
                showSuccess(t('emailReplies.importSuccess', { count: data.imported }));
            }
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['email-replies-stats'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    // ── Filter change helpers (reset page) ──

    const resetPage = () => setPage(1);

    // Issue 14: close modal when filters change to prevent showing stale data.
    // Render-phase state comparison (same pattern as ReplyDetailModal localReply sync).
    const filterSig = `${campaignFilter}|${matchStatusFilter}|${readStatusFilter}|${debouncedSearch}|${dateFrom}|${dateTo}`;
    const [prevFilterSig, setPrevFilterSig] = useState(filterSig);
    if (prevFilterSig !== filterSig) {
        setPrevFilterSig(filterSig);
        if (selectedReply !== null) setSelectedReply(null);
        if (expandedIds.size > 0) setExpandedIds(new Set());
    }

    // ── Displayed replies ──

    const displayedReplies = useMemo(() => data?.data ?? [], [data]);

    const total = data?.pagination?.total ?? 0;
    const totalPages = data?.pagination?.totalPages ?? 1;
    const limit = data?.pagination?.limit ?? 20;

    // ── Select Data ──

    const campaignSelectData = (campaigns || [])
        .filter((c) => c.campaign_name != null)
        .map((c) => ({
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
                {activeCampaigns.length > 0 && (
                    <Button
                        variant="light"
                        size="sm"
                        leftSection={<IconDownload size={16} />}
                        onClick={() => importMutation.mutate()}
                        loading={importMutation.isPending}
                    >
                        {t('emailReplies.importReplies')}
                    </Button>
                )}
            </Group>

            {/* Error state */}
            {(repliesError || statsError) && (
                <Alert
                    icon={<IconAlertCircle size={16} />}
                    color="red"
                    variant="light"
                    mb="md"
                    title={t('emailReplies.errors.loadFailed')}
                >
                    {t('emailReplies.errors.loadFailedDescription')}
                </Alert>
            )}

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

            {/* Active Campaigns Summary */}
            {activeCampaigns.length > 0 && (
                <Paper p="sm" radius="md" withBorder mb="md" bg="var(--mantine-color-violet-0)">
                    <Group gap="xs" mb={6}>
                        <IconSpeakerphone size={14} style={{ opacity: 0.6 }} />
                        <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                            {t('emailReplies.activeCampaigns')}
                        </Text>
                    </Group>
                    <Group gap="lg" wrap="wrap">
                        {activeCampaigns.map((c, i) => (
                            <Group key={c.id} gap={6}>
                                <Badge size="xs" variant="filled" color="violet" circle>{i + 1}</Badge>
                                <Text size="xs" fw={500}>{c.name}</Text>
                                <Badge size="xs" variant="light" color="violet">
                                    {c.emails_sent} {t('campaigns.stats.sent').toLowerCase()}
                                </Badge>
                                <Badge size="xs" variant="light" color="orange">
                                    {c.replies} {t('campaigns.stats.replies').toLowerCase()}
                                </Badge>
                            </Group>
                        ))}
                    </Group>
                </Paper>
            )}

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
                                    <Table.Th style={{ width: 46 }} />
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
                                    const hasUnread = reply.has_unread ?? reply.read_status === 'unread';
                                    const isUnmatched = reply.match_status === 'unmatched';
                                    const threadCount = reply.thread_count ?? 1;
                                    const isExpanded = expandedIds.has(reply.id);

                                    return (
                                        <>
                                            <Table.Tr
                                                key={reply.id}
                                                style={{
                                                    cursor: 'pointer',
                                                    backgroundColor: hasUnread
                                                        ? 'var(--mantine-color-blue-0)'
                                                        : undefined,
                                                }}
                                                onClick={() => setSelectedReply(reply)}
                                            >
                                                {/* Unread dot + expand chevron */}
                                                <Table.Td>
                                                    <Group gap={4} wrap="nowrap" justify="center">
                                                        {hasUnread && (
                                                            <Tooltip label={t('emailReplies.status.unread')}>
                                                                <IconCircleFilled
                                                                    size={10}
                                                                    style={{ color: 'var(--mantine-color-blue-5)', flexShrink: 0 }}
                                                                />
                                                            </Tooltip>
                                                        )}
                                                        {threadCount > 1 && (
                                                            <Tooltip label={isExpanded ? t('emailReplies.thread.collapse') : t('emailReplies.thread.expand', { count: threadCount - 1 })}>
                                                                <ActionIcon
                                                                    size="xs"
                                                                    variant="subtle"
                                                                    color="gray"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        toggleExpand(reply.id);
                                                                    }}
                                                                >
                                                                    {isExpanded
                                                                        ? <IconChevronDown size={13} />
                                                                        : <IconChevronRight size={13} />
                                                                    }
                                                                </ActionIcon>
                                                            </Tooltip>
                                                        )}
                                                    </Group>
                                                </Table.Td>

                                                {/* Campaign code */}
                                                <Table.Td>
                                                    {reply.campaign_id && campaignCodeMap.has(reply.campaign_id) ? (
                                                        <Tooltip label={reply.campaign_name || reply.campaign_id} withArrow>
                                                            <Badge size="sm" variant="filled" color="violet" circle>
                                                                {campaignCodeMap.get(reply.campaign_id)}
                                                            </Badge>
                                                        </Tooltip>
                                                    ) : reply.campaign_name ? (
                                                        <Tooltip label={reply.campaign_name} withArrow>
                                                            <Badge size="sm" variant="light" color="gray" circle>?</Badge>
                                                        </Tooltip>
                                                    ) : (
                                                        <Text size="xs" c="dimmed">-</Text>
                                                    )}
                                                </Table.Td>

                                                {/* Sender Email + thread badge */}
                                                <Table.Td>
                                                    <Group gap={6} wrap="nowrap">
                                                        <Text size="sm" fw={hasUnread ? 600 : 400}>
                                                            {reply.sender_email}
                                                        </Text>
                                                        {threadCount > 1 && (
                                                            <Badge size="xs" variant="outline" color="gray" style={{ flexShrink: 0 }}>
                                                                {threadCount}
                                                            </Badge>
                                                        )}
                                                    </Group>
                                                </Table.Td>

                                                {/* Company */}
                                                <Table.Td>
                                                    {isUnmatched ? (
                                                        <Badge size="sm" variant="light" color="red">
                                                            {t('emailReplies.status.unmatched')}
                                                        </Badge>
                                                    ) : reply.company_name ? (
                                                        <Anchor
                                                            size="sm"
                                                            fw={500}
                                                            href={`/companies/${reply.company_id}`}
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                navigate(`/companies/${reply.company_id}`);
                                                            }}
                                                        >
                                                            {reply.company_name}
                                                        </Anchor>
                                                    ) : (
                                                        <Text size="xs" c="dimmed">-</Text>
                                                    )}
                                                </Table.Td>

                                                {/* Contact */}
                                                <Table.Td>
                                                    <Text size="sm">{reply.contact_name || '-'}</Text>
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

                                            {/* Thread history rows */}
                                            {isExpanded && threadCount > 1 && (
                                                <ThreadHistoryRows
                                                    senderEmail={reply.sender_email}
                                                    campaignId={reply.campaign_id}
                                                    excludeId={reply.id}
                                                    locale={locale}
                                                    colSpan={7}
                                                />
                                            )}
                                        </>
                                    );
                                })}
                            </Table.Tbody>
                        </Table>
                    </Paper>

                    {/* Pagination */}
                    {totalPages > 1 && (
                        <Group justify="space-between" mt="xs">
                            <Text size="xs" c="dimmed">
                                {((page - 1) * limit) + 1}–{Math.min(page * limit, total)} / {total}
                            </Text>
                            <Pagination
                                total={totalPages}
                                value={page}
                                onChange={setPage}
                                size="sm"
                            />
                        </Group>
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
