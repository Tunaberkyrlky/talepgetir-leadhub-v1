import { useState, useMemo, useCallback, useEffect, Fragment } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
    Container, Title, Group, Stack, Paper, Text, Badge, Table,
    Loader, Center, Button, SimpleGrid, Select, TextInput,
    Skeleton, Tooltip, Alert, Anchor, Pagination, ActionIcon,
    SegmentedControl, Popover, Checkbox, Divider, Menu, Collapse, Modal,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useDebouncedValue } from '@mantine/hooks';
import {
    IconMail, IconMailOpened, IconSearch,
    IconAlertCircle,
    IconSpeakerphone, IconDownload, IconChevronDown, IconChevronRight,
    IconChevronLeft, IconRefresh, IconAdjustments, IconPencilPlus,
    IconEye, IconStar, IconClock, IconCircleCheck, IconPaperclip, IconNotes, IconMailCog,
} from '@tabler/icons-react';
import ThreadHistoryRows from '../components/email/ThreadHistoryRows';
import ErrorFeedbackButton from '../components/ErrorFeedbackButton';

import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showErrorFromApi, showWarning } from '../lib/notifications';
import StatCard from '../components/StatCard';
import ReplyDetailModal from '../components/email/ReplyDetailModal';
import ComposeMailModal from '../components/email/ComposeMailModal';
import AttachmentLibraryModal from '../components/email/AttachmentLibraryModal';
import ActivityTimeline from '../components/ActivityTimeline';
import type { EmailReply, EmailReplyStats, EmailTrackingStats, Campaign } from '../types/emailReply';
import type { CampaignsResponse } from '../types/plusvibe';
import { useStages } from '../contexts/StagesContext';
import { useAuth } from '../contexts/AuthContext';
import EmailConnectionPanel from '../components/settings/EmailConnectionPanel';
import DeliverabilityHealthPanel from '../components/settings/DeliverabilityHealthPanel';

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

function toLocalISOStart(d: Date | string): string {
    const date = d instanceof Date ? d : new Date(d);
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}T00:00:00${tzOffset(date)}`;
}

function toLocalISOEnd(d: Date | string): string {
    const date = d instanceof Date ? d : new Date(d);
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}T23:59:59${tzOffset(date)}`;
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

// ─── Period Filter Helpers ────────────────────────────────────────────────────

type PeriodType = 'day' | 'week' | 'month' | 'custom';

function getPeriodDates(type: PeriodType, anchor: Date): { start: Date; end: Date } {
    if (type === 'day') return { start: anchor, end: anchor };
    if (type === 'week') {
        const d = new Date(anchor);
        const day = d.getDay();
        const diff = day === 0 ? -6 : 1 - day;
        const monday = new Date(d);
        monday.setDate(d.getDate() + diff);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        return { start: monday, end: sunday };
    }
    return {
        start: new Date(anchor.getFullYear(), anchor.getMonth(), 1),
        end: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0),
    };
}

function shiftPeriod(type: PeriodType, anchor: Date, direction: 1 | -1): Date {
    const d = new Date(anchor);
    if (type === 'day') d.setDate(d.getDate() + direction);
    else if (type === 'week') d.setDate(d.getDate() + direction * 7);
    else if (type === 'month') d.setMonth(d.getMonth() + direction);
    return d;
}

function formatPeriodLabel(type: PeriodType, anchor: Date, locale: string): string {
    if (type === 'day') return anchor.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
    if (type === 'week') {
        const { start, end } = getPeriodDates(type, anchor);
        const monthStr = end.toLocaleDateString(locale, { month: 'short' });
        return `${start.getDate()} — ${end.getDate()} ${monthStr} ${end.getFullYear()}`;
    }
    return anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}

// ─── Column Toggle ──────────────────────────────────────────────────────────

type EmailColumnKey =
    | 'campaign' | 'sender' | 'company' | 'contact'
    | 'label' | 'preview' | 'website' | 'notes' | 'date';

interface EmailColumnDef { key: EmailColumnKey; visible: boolean; }

const EMAIL_COLUMNS_KEY = 'email_replies_columns_v1';

const DEFAULT_EMAIL_COLUMNS: EmailColumnDef[] = [
    { key: 'campaign', visible: true },
    { key: 'sender', visible: true },
    { key: 'company', visible: true },
    { key: 'contact', visible: true },
    { key: 'label', visible: true },
    { key: 'preview', visible: true },
    { key: 'website', visible: false },
    { key: 'notes', visible: true },
    { key: 'date', visible: true },
];

const VALID_EMAIL_COLS = new Set<string>(DEFAULT_EMAIL_COLUMNS.map(c => c.key));

// PlusVibe label kodlarını i18n anahtarlarına eşler (filtre + tablo gösterimi ortak).
const LABEL_I18N_KEYS: Record<string, string> = {
    INTERESTED: 'interested',
    NOT_INTERESTED: 'notInterested',
    MEETING_BOOKED: 'meetingBooked',
    MEETING_CANCELLED: 'meetingCancelled',
    CLOSED: 'closed',
    OUT_OF_OFFICE: 'outOfOffice',
    AUTOMATIC_REPLY: 'automaticReply',
    WRONG_PERSON: 'wrongPerson',
    DO_NOT_CONTACT: 'doNotContact',
};

function loadEmailColumns(): EmailColumnDef[] {
    try {
        const stored = localStorage.getItem(EMAIL_COLUMNS_KEY);
        if (stored) {
            const parsed = JSON.parse(stored) as EmailColumnDef[];
            const valid = parsed.filter(c => VALID_EMAIL_COLS.has(c.key));
            const keys = valid.map(c => c.key);
            const missing = DEFAULT_EMAIL_COLUMNS.filter(c => !keys.includes(c.key));
            return [...valid, ...missing];
        }
    } catch {}
    return DEFAULT_EMAIL_COLUMNS;
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function EmailRepliesPage() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';
    const { getStageColor, getStageLabel } = useStages();

    // Compose modal
    const [composeOpen, setComposeOpen] = useState(false);
    const [connOpen, setConnOpen] = useState(false);
    const { user } = useAuth();
    const isAdmin = user?.role === 'superadmin' || user?.role === 'ops_agent' || user?.role === 'client_admin';

    // Attachment library manager (manage saved attachments without sending a mail)
    const [attachmentsOpen, setAttachmentsOpen] = useState(false);

    // Active campaigns summary — collapsed by default (not needed at all times); choice persists
    const [campaignsOpen, setCampaignsOpen] = useState<boolean>(
        () => localStorage.getItem('email_active_campaigns_open') === '1'
    );
    const toggleCampaigns = useCallback(() => {
        setCampaignsOpen((prev) => {
            const next = !prev;
            try { localStorage.setItem('email_active_campaigns_open', next ? '1' : '0'); } catch {}
            return next;
        });
    }, []);

    // Filters
    const [campaignFilter, setCampaignFilter] = useState('');
    const [matchStatusFilter, setMatchStatusFilter] = useState('');
    const [readStatusFilter, setReadStatusFilter] = useState('');
    const [labelFilter, setLabelFilter] = useState('');
    const [awaitingFilter, setAwaitingFilter] = useState(false);
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 300);
    const [periodType, setPeriodType] = useState<PeriodType>('month');
    const [periodAnchor, setPeriodAnchor] = useState<Date>(new Date());
    const [customRange, setCustomRange] = useState<[Date | null, Date | null]>([null, null]);

    // Pagination
    const [page, setPage] = useState(1);

    // Selected reply (for modal)
    const [selectedReply, setSelectedReply] = useState<EmailReply | null>(null);

    // Column visibility
    const [emailColumns, setEmailColumns] = useState<EmailColumnDef[]>(loadEmailColumns);
    const saveEmailColumns = (cols: EmailColumnDef[]) => {
        setEmailColumns(cols);
        localStorage.setItem(EMAIL_COLUMNS_KEY, JSON.stringify(cols));
    };
    const toggleEmailColumn = (key: EmailColumnKey) => {
        const visibleCount = emailColumns.filter(c => c.visible).length;
        const col = emailColumns.find(c => c.key === key);
        if (col?.visible && visibleCount <= 1) return;
        saveEmailColumns(emailColumns.map(c => c.key === key ? { ...c, visible: !c.visible } : c));
    };
    const visibleEmailCols = emailColumns.filter(c => c.visible);
    const isColVisible = (key: EmailColumnKey) => visibleEmailCols.some(c => c.key === key);

    const emailColumnLabels: Record<EmailColumnKey, string> = {
        campaign: t('emailReplies.table.campaign'),
        sender: t('emailReplies.table.sender'),
        company: t('emailReplies.table.company'),
        contact: t('emailReplies.table.contact'),
        label: t('emailReplies.table.label'),
        preview: t('emailReplies.table.preview'),
        website: t('emailReplies.table.website'),
        notes: t('emailReplies.table.notes'),
        date: t('emailReplies.table.date'),
    };

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

    const periodLabel = formatPeriodLabel(periodType, periodAnchor, locale);

    const { dateFrom, dateTo } = useMemo(() => {
        if (periodType === 'custom') {
            return {
                dateFrom: customRange[0] ? toLocalISOStart(customRange[0]) : '',
                dateTo: customRange[1] ? toLocalISOEnd(customRange[1]) : '',
            };
        }
        const { start, end } = getPeriodDates(periodType, periodAnchor);
        return { dateFrom: toLocalISOStart(start), dateTo: toLocalISOEnd(end) };
    }, [periodType, periodAnchor, customRange]);

    // ── Queries ──

    const { data, isLoading, error: repliesError } = useQuery<EmailRepliesResponse>({
        queryKey: [
            'email-replies',
            page,
            campaignFilter,
            matchStatusFilter,
            readStatusFilter,
            labelFilter,
            awaitingFilter,
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
            if (labelFilter) params.label = labelFilter === '__EMPTY__' ? '__EMPTY__' : labelFilter;
            if (awaitingFilter) params.awaiting = 'true';
            if (debouncedSearch) params.search = debouncedSearch;
            if (dateFrom) params.date_from = dateFrom;
            if (dateTo) params.date_to = dateTo;
            return (await api.get('/email-replies', { params })).data;
        },
        refetchOnWindowFocus: false,
    });

    // ── Read toggle (list row) ── the leftmost envelope acts as a read/unread switch.
    // Optimistic so the icon flips instantly; resyncs on settle (has_unread is thread-level).
    const readToggleMutation = useMutation({
        mutationFn: async ({ id, nextStatus }: { id: string; nextStatus: 'read' | 'unread' }) =>
            (await api.patch(`/email-replies/${id}/read`, { read_status: nextStatus })).data,
        onMutate: async ({ id, nextStatus }) => {
            await queryClient.cancelQueries({ queryKey: ['email-replies'] });
            queryClient.setQueriesData<EmailRepliesResponse>({ queryKey: ['email-replies'] }, (old) =>
                old
                    ? {
                          ...old,
                          data: old.data.map((r) =>
                              r.id === id
                                  ? { ...r, read_status: nextStatus, has_unread: nextStatus === 'unread' }
                                  : r,
                          ),
                      }
                    : old,
            );
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['email-replies-stats'] });
        },
        onError: (err) => showErrorFromApi(err, t('emailReplies.errors.readToggleFailed')),
    });

    // PlusVibe label kodunu yerelleştirilmiş metne çevirir (bilinmeyen → kod okunaklı hale).
    const labelText = (label: string) => {
        const key = LABEL_I18N_KEYS[label];
        return key ? t(`emailReplies.labels.${key}`) : label.replace(/_/g, ' ');
    };

    // Stat cards follow the same date window as the list (Gün/Hafta/Ay/Özel).
    const dateParams = () => {
        const p: Record<string, string> = {};
        if (dateFrom) p.date_from = dateFrom;
        if (dateTo) p.date_to = dateTo;
        return p;
    };

    const { data: stats, isLoading: statsLoading, error: statsError } = useQuery<EmailReplyStats>({
        queryKey: ['email-replies-stats', dateFrom, dateTo],
        queryFn: async () => (await api.get('/email-replies/stats', { params: dateParams() })).data,
    });

    // Open/click tracking aggregate — events arrive as recipients open mails,
    // so refresh periodically rather than only on invalidation.
    const { data: trackingStats, isLoading: trackingStatsLoading } = useQuery<EmailTrackingStats>({
        queryKey: ['email-replies-tracking-stats', dateFrom, dateTo],
        queryFn: async () => (await api.get('/email-replies/tracking-stats', { params: dateParams() })).data,
        refetchInterval: 60_000,
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

    // Bulk rematch — step-by-step progress state
    type RematchPhase =
        | { phase: 'idle' }
        | { phase: 'fetching' }
        | { phase: 'matching'; done: number; total: number }
        | { phase: 'done'; matched: number; total: number };

    const [rematchState, setRematchState] = useState<RematchPhase>({ phase: 'idle' });

    const runRematchAll = useCallback(async () => {
        setRematchState({ phase: 'fetching' });
        try {
            // Step 1: fetch all unmatched IDs (paginate through all pages, max 50/page)
            const PAGE_LIMIT = 50;
            const ids: string[] = [];
            let currentPage = 1;
            let hasMore = true;
            while (hasMore) {
                const resp = await api.get<{ data: { id: string }[]; pagination: { hasNext: boolean } }>('/email-replies', {
                    params: { match_status: 'unmatched', limit: String(PAGE_LIMIT), page: String(currentPage) },
                });
                ids.push(...resp.data.data.map((r) => r.id));
                hasMore = resp.data.pagination.hasNext;
                currentPage++;
            }

            if (ids.length === 0) {
                setRematchState({ phase: 'done', matched: 0, total: 0 });
                queryClient.invalidateQueries({ queryKey: ['email-replies-stats'] });
                return;
            }

            // Step 2: process in batches of 20
            const BATCH = 20;
            let totalMatched = 0;
            for (let i = 0; i < ids.length; i += BATCH) {
                setRematchState({ phase: 'matching', done: i, total: ids.length });
                const batch = ids.slice(i, i + BATCH);
                const { data } = await api.post<{ matched: number }>('/email-replies/rematch-batch', { ids: batch });
                totalMatched += data.matched;
            }

            setRematchState({ phase: 'done', matched: totalMatched, total: ids.length });
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['email-replies-stats'] });
        } catch (err) {
            showErrorFromApi(err);
            setRematchState({ phase: 'idle' });
        }
    }, [queryClient]);

    // Import historical replies — step-by-step progress state
    type ImportPhase =
        | { phase: 'idle' }
        | { phase: 'fetching' }
        | { phase: 'importing'; done: number; total: number; campaignName: string }
        | { phase: 'done'; imported: number };

    const [importState, setImportState] = useState<ImportPhase>({ phase: 'idle' });

    const runImport = useCallback(async () => {
        setImportState({ phase: 'fetching' });
        try {
            // Step 1: get campaigns assigned to this tenant
            const resp = await api.get<{ data: { pv_campaign_id: string; name: string }[] }>(
                '/plusvibe/campaigns'
            );
            const campaigns = resp.data.data.filter((c) => c.pv_campaign_id);

            if (campaigns.length === 0) {
                setImportState({ phase: 'done', imported: 0 });
                return;
            }

            // Step 2: import each campaign one by one. Keep going if one campaign fails
            // (e.g. a slow timeout) so the rest still import, but collect failures so we
            // can surface them instead of silently reporting success.
            let totalImported = 0;
            const failed: string[] = [];
            for (let i = 0; i < campaigns.length; i++) {
                const campaign = campaigns[i];
                setImportState({ phase: 'importing', done: i, total: campaigns.length, campaignName: campaign.name });
                try {
                    const { data } = await api.post<{ imported: number }>('/plusvibe/import-campaign', {
                        pv_campaign_id: campaign.pv_campaign_id,
                    });
                    totalImported += data.imported;
                } catch (campErr) {
                    failed.push(campaign.name);
                    console.error(`[import] campaign failed: ${campaign.name}`, campErr);
                }
            }

            setImportState({ phase: 'done', imported: totalImported });
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['email-replies-stats'] });

            if (failed.length > 0) {
                showWarning(
                    t('emailReplies.importPartialFailed', {
                        count: failed.length,
                        names: failed.join(', '),
                        defaultValue: `${failed.length} kampanya içe aktarılamadı: ${failed.join(', ')}. Tekrar deneyebilirsiniz.`,
                    }),
                );
            }
        } catch (err) {
            showErrorFromApi(err);
            setImportState({ phase: 'idle' });
        }
    }, [queryClient, t]);

    // ── Filter change helpers (reset page) ──

    const resetPage = () => setPage(1);

    // Close modal and collapse rows when filters change to prevent showing stale data
    const filterSig = `${campaignFilter}|${matchStatusFilter}|${readStatusFilter}|${labelFilter}|${awaitingFilter}|${debouncedSearch}|${dateFrom}|${dateTo}`;
    useEffect(() => {
        setSelectedReply(null);
        setExpandedIds(new Set());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filterSig]);

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
                    <Badge size="lg" variant="light" color="violet" radius="xl">
                        {total}
                    </Badge>
                </Group>
                <Group gap="xs">
                    <Button.Group>
                        <Button
                            size="sm"
                            color="violet"
                            leftSection={<IconPencilPlus size={16} />}
                            onClick={() => setComposeOpen(true)}
                        >
                            {t('emailReplies.compose.button', 'Yeni Mail')}
                        </Button>
                        {isAdmin && (
                            <Tooltip label={t('emailReplies.connSettings.tooltip', 'Mail bağlantı ayarları')}>
                                <Button
                                    size="sm"
                                    color="violet"
                                    px="xs"
                                    onClick={() => setConnOpen(true)}
                                    aria-label={t('emailReplies.connSettings.tooltip', 'Mail bağlantı ayarları')}
                                    style={{ borderLeft: '1px solid rgba(255, 255, 255, 0.3)' }}
                                >
                                    <IconMailCog size={18} />
                                </Button>
                            </Tooltip>
                        )}
                    </Button.Group>
                    {(() => {
                        const rematchBusy = rematchState.phase === 'fetching' || rematchState.phase === 'matching';
                        const importBusy = importState.phase === 'fetching' || importState.phase === 'importing';
                        const anyBusy = rematchBusy || importBusy;
                        const rematchLabel = rematchState.phase === 'idle'
                            ? t('emailReplies.rematch.bulkButton', { count: stats?.unmatched ?? 0 })
                            : rematchState.phase === 'fetching'
                                ? t('emailReplies.rematch.stepFetching')
                                : rematchState.phase === 'matching'
                                    ? t('emailReplies.rematch.stepMatching', { done: rematchState.done, total: rematchState.total })
                                    : t('emailReplies.rematch.stepDone', { matched: rematchState.matched, total: rematchState.total });
                        const importLabel = importState.phase === 'idle'
                            ? t('emailReplies.importReplies')
                            : importState.phase === 'fetching'
                                ? t('emailReplies.import.stepFetching')
                                : importState.phase === 'importing'
                                    ? t('emailReplies.import.stepImporting', { done: importState.done + 1, total: importState.total, name: importState.campaignName })
                                    : t('emailReplies.import.stepDone', { count: importState.imported });
                        // Rematch/Import only matter when there's work (or one is mid-run);
                        // Ekler is always available. New actions: add a Menu.Item here.
                        const showRematch = (stats?.unmatched ?? 0) > 0 || rematchState.phase !== 'idle';
                        const showImport = activeCampaigns.length > 0 || importState.phase !== 'idle';
                        return (
                            <Menu position="bottom-end" shadow="md" width={280}>
                                <Menu.Target>
                                    <Button
                                        size="sm"
                                        variant="light"
                                        color="violet"
                                        leftSection={anyBusy ? <Loader size={14} color="violet" /> : <IconAdjustments size={16} />}
                                        rightSection={<IconChevronDown size={14} />}
                                    >
                                        {anyBusy ? (rematchBusy ? rematchLabel : importLabel) : t('emailReplies.actions.menu', 'İşlemler')}
                                    </Button>
                                </Menu.Target>
                                <Menu.Dropdown>
                                    <Menu.Item
                                        leftSection={<IconPaperclip size={16} />}
                                        onClick={() => setAttachmentsOpen(true)}
                                    >
                                        {t('emailReplies.attachmentLibrary.button', 'Mail eki ve CC adresi')}
                                    </Menu.Item>
                                    {showRematch && (
                                        <Menu.Item
                                            leftSection={rematchBusy ? <Loader size={14} color="violet" /> : <IconRefresh size={16} />}
                                            color={rematchState.phase === 'done' ? 'green' : undefined}
                                            disabled={rematchBusy}
                                            closeMenuOnClick={!rematchBusy}
                                            onClick={() => { if (!rematchBusy) runRematchAll(); }}
                                        >
                                            {rematchLabel}
                                        </Menu.Item>
                                    )}
                                    {showImport && (
                                        <Menu.Item
                                            leftSection={importBusy ? <Loader size={14} color="blue" /> : <IconDownload size={16} />}
                                            color={importState.phase === 'done' ? 'green' : undefined}
                                            disabled={importBusy}
                                            closeMenuOnClick={!importBusy}
                                            onClick={() => { if (!importBusy) runImport(); }}
                                        >
                                            {importLabel}
                                        </Menu.Item>
                                    )}
                                </Menu.Dropdown>
                            </Menu>
                        );
                    })()}
                </Group>
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
                    <Group justify="space-between" align="center">
                        <Text size="sm">{t('emailReplies.errors.loadFailedDescription')}</Text>
                        <ErrorFeedbackButton context="Email Replies" size="xs" />
                    </Group>
                </Alert>
            )}

            {/* Stats Cards */}
            <SimpleGrid cols={{ base: 2, sm: 4 }} mb="lg">
                {statsLoading ? (
                    <>
                        <Skeleton height={100} radius="lg" />
                        <Skeleton height={100} radius="lg" />
                        <Skeleton height={100} radius="lg" />
                    </>
                ) : (
                    <>
                        <StatCard
                            title={t('emailReplies.stats.unread')}
                            value={stats?.unread ?? 0}
                            icon={<IconMailOpened size={22} />}
                            color="blue"
                            selected={readStatusFilter === 'unread'}
                            onClick={() => { setReadStatusFilter(readStatusFilter === 'unread' ? '' : 'unread'); resetPage(); }}
                        />
                        <StatCard
                            title={t('emailReplies.stats.interested')}
                            value={stats?.interested ?? 0}
                            icon={<IconStar size={22} />}
                            color="green"
                            description={t('emailReplies.stats.interestedTooltip')}
                            selected={labelFilter === 'INTERESTED'}
                            onClick={() => { setLabelFilter(labelFilter === 'INTERESTED' ? '' : 'INTERESTED'); resetPage(); }}
                        />
                        <StatCard
                            title={t('emailReplies.stats.awaiting')}
                            value={stats?.awaiting ?? 0}
                            icon={<IconClock size={22} />}
                            color="orange"
                            description={t('emailReplies.stats.awaitingTooltip')}
                            selected={awaitingFilter}
                            onClick={() => { setAwaitingFilter(!awaitingFilter); resetPage(); }}
                        />
                    </>
                )}
                {trackingStatsLoading ? (
                    <Skeleton height={100} radius="lg" />
                ) : (
                    <StatCard
                        title={t('emailReplies.tracking.stats.opened')}
                        value={trackingStats?.opened ?? 0}
                        icon={<IconEye size={22} />}
                        color="teal"
                        description={t('emailReplies.tracking.stats.openedContext', {
                            sent: trackingStats?.sent ?? 0,
                            pct: Math.round((trackingStats?.open_rate ?? 0) * 100),
                        })}
                    />
                )}
            </SimpleGrid>

            {/* Active Campaigns Summary — collapsed by default, header toggles */}
            {activeCampaigns.length > 0 && (
                <Paper p="sm" radius="md" withBorder mb="md" bg="var(--mantine-color-violet-0)">
                    <Group
                        gap="xs"
                        justify="space-between"
                        wrap="nowrap"
                        style={{ cursor: 'pointer' }}
                        onClick={toggleCampaigns}
                    >
                        <Group gap="xs" wrap="nowrap">
                            <IconSpeakerphone size={14} style={{ opacity: 0.6 }} />
                            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                                {t('emailReplies.activeCampaigns')}
                            </Text>
                            <Badge size="xs" variant="light" color="violet">{activeCampaigns.length}</Badge>
                        </Group>
                        <ActionIcon size="xs" variant="subtle" color="gray">
                            {campaignsOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                        </ActionIcon>
                    </Group>
                    <Collapse in={campaignsOpen}>
                        <Group gap="lg" wrap="wrap" mt={8}>
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
                    </Collapse>
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
                        <Select
                            size="sm"
                            placeholder={t('emailReplies.filters.allLabels')}
                            clearable
                            value={labelFilter || null}
                            onChange={(v) => { setLabelFilter(v || ''); resetPage(); }}
                            data={[
                                { value: 'INTERESTED', label: t('emailReplies.labels.interested') },
                                { value: 'NOT_INTERESTED', label: t('emailReplies.labels.notInterested') },
                                { value: 'MEETING_BOOKED', label: t('emailReplies.labels.meetingBooked') },
                                { value: 'MEETING_CANCELLED', label: t('emailReplies.labels.meetingCancelled') },
                                { value: 'CLOSED', label: t('emailReplies.labels.closed') },
                                { value: 'OUT_OF_OFFICE', label: t('emailReplies.labels.outOfOffice') },
                                { value: 'AUTOMATIC_REPLY', label: t('emailReplies.labels.automaticReply') },
                                { value: 'WRONG_PERSON', label: t('emailReplies.labels.wrongPerson') },
                                { value: 'DO_NOT_CONTACT', label: t('emailReplies.labels.doNotContact') },
                                { value: '__EMPTY__', label: t('emailReplies.labels.empty') },
                            ]}
                            style={{ minWidth: 160 }}
                        />
                    </Group>
                    <Group gap="xs" wrap="nowrap" justify="flex-end">
                        <SegmentedControl
                            size="xs"
                            value={periodType}
                            onChange={(v) => {
                                setPeriodType(v as PeriodType);
                                setPeriodAnchor(new Date());
                                setCustomRange([null, null]);
                                resetPage();
                            }}
                            data={[
                                { label: t('activities.periodDay'), value: 'day' },
                                { label: t('activities.periodWeek'), value: 'week' },
                                { label: t('activities.periodMonth'), value: 'month' },
                                { label: t('activities.periodCustom'), value: 'custom' },
                            ]}
                        />

                        {periodType !== 'custom' && (
                            <Group gap={4} wrap="nowrap">
                                <ActionIcon
                                    variant="subtle"
                                    color="gray"
                                    size="sm"
                                    onClick={() => { setPeriodAnchor((prev) => shiftPeriod(periodType, prev, -1)); resetPage(); }}
                                >
                                    <IconChevronLeft size={14} />
                                </ActionIcon>
                                <Text size="xs" fw={600} miw={120} ta="center">
                                    {periodLabel}
                                </Text>
                                <ActionIcon
                                    variant="subtle"
                                    color="gray"
                                    size="sm"
                                    onClick={() => { setPeriodAnchor((prev) => shiftPeriod(periodType, prev, 1)); resetPage(); }}
                                >
                                    <IconChevronRight size={14} />
                                </ActionIcon>
                                <Button
                                    size="compact-xs"
                                    variant="light"
                                    color="violet"
                                    onClick={() => { setPeriodAnchor(new Date()); resetPage(); }}
                                >
                                    {t('activities.today')}
                                </Button>
                            </Group>
                        )}

                        {periodType === 'custom' && (
                            <DatePickerInput
                                type="range"
                                placeholder={t('activities.dateRange')}
                                value={customRange}
                                onChange={(v) => { setCustomRange(v as [Date | null, Date | null]); resetPage(); }}
                                clearable
                                size="xs"
                            />
                        )}
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
                                    <Table.Th style={{ width: 72, padding: '0 2px' }} />
                                    <Table.Th style={{ width: 26, padding: '0 2px' }} />
                                    {isColVisible('campaign') && <Table.Th style={{ width: 28, padding: '0 2px' }} />}
                                    {isColVisible('sender') && <Table.Th>{t('emailReplies.table.sender')}</Table.Th>}
                                    {isColVisible('company') && <Table.Th>{t('emailReplies.table.company')}</Table.Th>}
                                    {isColVisible('contact') && <Table.Th>{t('emailReplies.table.contact')}</Table.Th>}
                                    {isColVisible('label') && <Table.Th style={{ width: 30, padding: '0 4px', textAlign: 'center' }}>{t('emailReplies.table.label')}</Table.Th>}
                                    {isColVisible('preview') && <Table.Th>{t('emailReplies.table.preview')}</Table.Th>}
                                    {isColVisible('website') && <Table.Th>{t('emailReplies.table.website')}</Table.Th>}
                                    {isColVisible('notes') && <Table.Th style={{ width: 64, padding: '0 4px' }}>{t('emailReplies.table.notes')}</Table.Th>}
                                    {isColVisible('date') && <Table.Th>{t('emailReplies.table.date')}</Table.Th>}
                                    <Table.Th style={{ width: 30, padding: '0 4px' }}>
                                        <Popover position="bottom-end" shadow="md" width={220}>
                                            <Popover.Target>
                                                <ActionIcon variant="subtle" color="gray" size="sm">
                                                    <IconAdjustments size={16} />
                                                </ActionIcon>
                                            </Popover.Target>
                                            <Popover.Dropdown>
                                                <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>{t('emailReplies.table.columns')}</Text>
                                                <Divider mb={6} />
                                                <Stack gap={4}>
                                                    {emailColumns.map((col) => (
                                                        <Checkbox
                                                            key={col.key}
                                                            size="xs"
                                                            checked={col.visible}
                                                            onChange={() => toggleEmailColumn(col.key)}
                                                            label={<Text size="sm">{emailColumnLabels[col.key]}</Text>}
                                                        />
                                                    ))}
                                                </Stack>
                                                <Divider my={6} />
                                                <Button
                                                    size="compact-xs"
                                                    variant="subtle"
                                                    color="gray"
                                                    fullWidth
                                                    onClick={() => saveEmailColumns(DEFAULT_EMAIL_COLUMNS)}
                                                >
                                                    {t('emailReplies.table.resetColumns')}
                                                </Button>
                                            </Popover.Dropdown>
                                        </Popover>
                                    </Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {displayedReplies.map((reply) => {
                                    const hasUnread = reply.has_unread ?? reply.read_status === 'unread';
                                    const isUnmatched = reply.match_status === 'unmatched';
                                    const threadCount = reply.thread_count ?? 1;
                                    const isExpanded = expandedIds.has(reply.id);

                                    return (
                                        <Fragment key={reply.id}>
                                            <Table.Tr
                                                style={{
                                                    cursor: 'pointer',
                                                    backgroundColor: hasUnread
                                                        ? 'var(--mantine-color-blue-0)'
                                                        : isExpanded
                                                            ? 'var(--mantine-color-violet-0)'
                                                            : undefined,
                                                }}
                                                onClick={() => setSelectedReply(reply)}
                                            >
                                                {/* Read toggle (envelope) + expand chevron */}
                                                <Table.Td
                                                    style={{
                                                        padding: '0 2px',
                                                        borderLeft: isExpanded
                                                            ? '3px solid var(--mantine-color-violet-5)'
                                                            : '3px solid transparent',
                                                    }}
                                                >
                                                    <Group gap={4} wrap="nowrap" justify="center">
                                                        <Tooltip
                                                            label={hasUnread
                                                                ? t('emailReplies.actions.markRead')
                                                                : t('emailReplies.actions.markUnread')}
                                                            withArrow
                                                        >
                                                            <ActionIcon
                                                                size="md"
                                                                variant="subtle"
                                                                color={hasUnread ? 'blue' : 'gray'}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    readToggleMutation.mutate({
                                                                        id: reply.id,
                                                                        nextStatus: hasUnread ? 'read' : 'unread',
                                                                    });
                                                                }}
                                                            >
                                                                {hasUnread
                                                                    ? <IconMail size={18} />
                                                                    : <IconMailOpened size={18} />}
                                                            </ActionIcon>
                                                        </Tooltip>
                                                        <Tooltip
                                                            label={isExpanded
                                                                ? t('emailReplies.thread.collapse')
                                                                : t('emailReplies.thread.expand', { count: threadCount })}
                                                            withArrow
                                                        >
                                                            <ActionIcon
                                                                size="md"
                                                                variant="subtle"
                                                                color="gray"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    toggleExpand(reply.id);
                                                                }}
                                                            >
                                                                {isExpanded
                                                                    ? <IconChevronDown size={18} />
                                                                    : <IconChevronRight size={18} />
                                                                }
                                                            </ActionIcon>
                                                        </Tooltip>
                                                    </Group>
                                                </Table.Td>

                                                {/* Reply status: awaiting our reply (clock) / we replied last (green check) */}
                                                <Table.Td style={{ padding: '0 2px', textAlign: 'center' }}>
                                                    {reply.awaiting ? (
                                                        <Tooltip label={t('emailReplies.status.awaiting')} withArrow>
                                                            <IconClock
                                                                size={16}
                                                                style={{ color: 'var(--mantine-color-orange-6)', verticalAlign: 'middle' }}
                                                            />
                                                        </Tooltip>
                                                    ) : reply.last_direction === 'OUT' ? (
                                                        <Tooltip label={t('emailReplies.status.replied')} withArrow>
                                                            <IconCircleCheck
                                                                size={16}
                                                                style={{ color: 'var(--mantine-color-green-6)', verticalAlign: 'middle' }}
                                                            />
                                                        </Tooltip>
                                                    ) : null}
                                                </Table.Td>

                                                {/* Campaign code — compact, left-aligned */}
                                                {isColVisible('campaign') && (
                                                <Table.Td style={{ padding: '0 2px' }}>
                                                    {reply.campaign_id && campaignCodeMap.has(reply.campaign_id) ? (
                                                        <Tooltip label={reply.campaign_name || reply.campaign_id} withArrow>
                                                            <Badge size="xs" variant="filled" color="violet" circle>
                                                                {campaignCodeMap.get(reply.campaign_id)}
                                                            </Badge>
                                                        </Tooltip>
                                                    ) : reply.campaign_name ? (
                                                        <Tooltip label={reply.campaign_name} withArrow>
                                                            <Badge size="xs" variant="light" color="gray" circle>?</Badge>
                                                        </Tooltip>
                                                    ) : null}
                                                </Table.Td>
                                                )}

                                                {/* Sender Email + thread badge */}
                                                {isColVisible('sender') && (
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
                                                )}

                                                {/* Company */}
                                                {isColVisible('company') && (
                                                <Table.Td>
                                                    {isUnmatched ? (
                                                        <Badge size="sm" variant="light" color="red">
                                                            {t('emailReplies.status.unmatched')}
                                                        </Badge>
                                                    ) : reply.company_name ? (
                                                        <Group gap={6} wrap="nowrap" justify="space-between">
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
                                                            {reply.company_stage && (
                                                                <Badge
                                                                    color={getStageColor(reply.company_stage)}
                                                                    variant="light"
                                                                    size="xs"
                                                                    radius="sm"
                                                                    style={{ flexShrink: 0, marginLeft: 'auto' }}
                                                                >
                                                                    {getStageLabel(reply.company_stage)}
                                                                </Badge>
                                                            )}
                                                        </Group>
                                                    ) : (
                                                        <Text size="xs" c="dimmed">-</Text>
                                                    )}
                                                </Table.Td>
                                                )}

                                                {/* Contact */}
                                                {isColVisible('contact') && (
                                                <Table.Td>
                                                    <Text size="sm">{reply.contact_name || '-'}</Text>
                                                </Table.Td>
                                                )}

                                                {/* Label — color dot */}
                                                {isColVisible('label') && (
                                                <Table.Td style={{ padding: '0 4px', textAlign: 'center' }}>
                                                    {reply.label && (
                                                        <Tooltip label={labelText(reply.label)} withArrow>
                                                            <Badge
                                                                size="xs"
                                                                variant="filled"
                                                                color={
                                                                    reply.label === 'INTERESTED' ? 'green'
                                                                    : reply.label === 'MEETING_BOOKED' ? 'teal'
                                                                    : reply.label === 'NOT_INTERESTED' ? 'red'
                                                                    : reply.label === 'DO_NOT_CONTACT' ? 'red'
                                                                    : reply.label === 'OUT_OF_OFFICE' ? 'yellow'
                                                                    : reply.label === 'WRONG_PERSON' ? 'orange'
                                                                    : 'gray'
                                                                }
                                                                style={{ width: 10, height: 10, padding: 0, minWidth: 10, borderRadius: '50%' }}
                                                            />
                                                        </Tooltip>
                                                    )}
                                                </Table.Td>
                                                )}

                                                {/* Reply Preview */}
                                                {isColVisible('preview') && (
                                                <Table.Td>
                                                    <Text size="xs" c="dimmed" lineClamp={1}>
                                                        {truncate(reply.reply_body, 80)}
                                                    </Text>
                                                </Table.Td>
                                                )}

                                                {/* Website */}
                                                {isColVisible('website') && (
                                                <Table.Td>
                                                    {reply.company_website ? (
                                                        <Anchor
                                                            size="xs"
                                                            href={reply.company_website.startsWith('http') ? reply.company_website : `https://${reply.company_website}`}
                                                            target="_blank"
                                                            onClick={(e) => e.stopPropagation()}
                                                            style={{ whiteSpace: 'nowrap' }}
                                                        >
                                                            {reply.company_website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '')}
                                                        </Anchor>
                                                    ) : (
                                                        <Text size="xs" c="dimmed">-</Text>
                                                    )}
                                                </Table.Td>
                                                )}

                                                {/* Activity count badge — click to read the company's notes in a popover */}
                                                {isColVisible('notes') && (
                                                <Table.Td
                                                    style={{ padding: '0 4px', textAlign: 'center' }}
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    {(reply.company_activity_count ?? 0) > 0 ? (
                                                        reply.company_id ? (
                                                            <Popover position="bottom-end" withArrow shadow="md" width={340}>
                                                                <Popover.Target>
                                                                    <Button
                                                                        size="compact-sm"
                                                                        variant="light"
                                                                        color="violet"
                                                                        leftSection={<IconNotes size={14} />}
                                                                    >
                                                                        {reply.company_activity_count}
                                                                    </Button>
                                                                </Popover.Target>
                                                                <Popover.Dropdown p="xs">
                                                                    <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6} lineClamp={1}>
                                                                        {reply.company_name || t('emailReplies.table.notes')}
                                                                    </Text>
                                                                    <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                                                                        <ActivityTimeline
                                                                            companyId={reply.company_id}
                                                                            embedded
                                                                            compact
                                                                            hideActionButton
                                                                        />
                                                                    </div>
                                                                </Popover.Dropdown>
                                                            </Popover>
                                                        ) : (
                                                            <Badge size="xs" variant="light" color="violet" style={{ cursor: 'default' }}>
                                                                {reply.company_activity_count}
                                                            </Badge>
                                                        )
                                                    ) : null}
                                                </Table.Td>
                                                )}

                                                {/* Date */}
                                                {isColVisible('date') && (
                                                <Table.Td>
                                                    <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                                                        {formatDate(reply.replied_at, locale)}
                                                    </Text>
                                                </Table.Td>
                                                )}

                                                {/* Spacer column (keeps rows aligned with the column-settings header) */}
                                                <Table.Td style={{ width: 30, padding: '0 4px' }} />
                                            </Table.Tr>

                                            {/* Thread history rows + company notes under them */}
                                            {isExpanded && (
                                                <>
                                                    <ThreadHistoryRows
                                                        senderEmail={reply.sender_email}
                                                        campaignId={reply.campaign_id}
                                                        parentReplyId={reply.id}
                                                        locale={locale}
                                                        colSpan={visibleEmailCols.length + 3}
                                                        onClickRow={() => setSelectedReply(reply)}
                                                    />
                                                    {reply.company_id && (reply.company_activity_count ?? 0) > 0 && (
                                                        <Table.Tr>
                                                            <Table.Td
                                                                colSpan={visibleEmailCols.length + 3}
                                                                style={{
                                                                    padding: '8px 12px 10px 26px',
                                                                    borderLeft: '3px solid var(--mantine-color-violet-4)',
                                                                    background: 'var(--mantine-color-gray-0)',
                                                                }}
                                                            >
                                                                <Group gap={6} mb={6} wrap="nowrap">
                                                                    <IconNotes size={13} style={{ color: 'var(--mantine-color-violet-6)' }} />
                                                                    <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                                                                        {t('emailReplies.table.notes')} ({reply.company_activity_count})
                                                                    </Text>
                                                                </Group>
                                                                <ActivityTimeline
                                                                    companyId={reply.company_id}
                                                                    embedded
                                                                    compact
                                                                    hideActionButton
                                                                />
                                                            </Table.Td>
                                                        </Table.Tr>
                                                    )}
                                                </>
                                            )}
                                        </Fragment>
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

            {/* Compose Mail Modal */}
            <ComposeMailModal
                opened={composeOpen}
                onClose={() => setComposeOpen(false)}
            />

            {/* Mail connection settings (moved from global Settings → adjacent to "Yeni Mail") */}
            <Modal
                opened={connOpen}
                onClose={() => setConnOpen(false)}
                size="lg"
                radius="lg"
                withCloseButton
            >
                <Stack gap="lg">
                    <EmailConnectionPanel />
                    <DeliverabilityHealthPanel />
                </Stack>
            </Modal>

            {/* Attachment Library Modal */}
            <AttachmentLibraryModal
                opened={attachmentsOpen}
                onClose={() => setAttachmentsOpen(false)}
            />
        </Container>
    );
}
