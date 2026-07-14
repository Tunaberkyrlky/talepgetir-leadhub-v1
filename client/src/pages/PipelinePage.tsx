import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
    Container,
    Title,
    Flex,
    Group,
    TextInput,
    ActionIcon,
    SegmentedControl,
    MultiSelect,
    Badge,
    Text,
    Paper,
    Stack,
    Table,
    Center,
    Loader,
    Button,
    UnstyledButton,
    Avatar,
    Tooltip,
} from '@mantine/core';
import { useDebouncedValue, useHotkeys } from '@mantine/hooks';
import { showSuccess, showError, showInfo } from '../lib/notifications';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    IconSearch,
    IconX,
    IconLayoutKanban,
    IconTable,
    IconColumns,
    IconUsers,
    IconRefresh,
    IconWifi,
    IconTrophy,
    IconChevronUp,
    IconChevronDown,
    IconSelector,
    IconAlertTriangle,
    IconClock,
    IconHistory,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import ErrorFeedbackButton from '../components/ErrorFeedbackButton';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { TierGate } from '../components/FeatureGate';
import { hasRolePermission } from '../lib/permissions';
import { useStages } from '../contexts/StagesContext';
import KanbanBoard from '../components/pipeline/KanbanBoard';
import DealKanbanBoard from '../components/pipeline/DealKanbanBoard';
import type { PipelineCompany } from '../components/pipeline/PipelineCard';
import type { Deal, DealsResponse } from '../types/deal';
import { isTaskOverdue, getContactAgeDays, getOwnerInitials } from '../lib/pipelineSignals';
import { useUndoStack } from '../hooks/useUndoStack';
import ClosingReportModal from '../components/ClosingReportModal';
import type { ClosingOutcome } from '../types/activity';

interface PipelineData {
    columns: Record<string, PipelineCompany[]>;
    terminalCounts: Record<string, number>;
    terminalColumns: Record<string, PipelineCompany[]>;
}

export default function PipelinePage() {
    const { t } = useTranslation();
    const { user, activeTenantId } = useAuth();
    const { pipelineStageSlugs, terminalStageSlugs, getStageColor, allStages, isLoading: stagesLoading } = useStages();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const focusStage = searchParams.get('focus');
    const role = user?.role || '';
    // Deal-mode (v2 Phase 5): flag-gated per tenant. When on, the board renders open
    // DEAL cards grouped by pipeline stage instead of companies.
    //
    // user.tenantSettings is resolved once at /auth/me time (mount tenant). Internal
    // roles can switch tenants without re-fetching /auth/me, which leaves tenantSettings
    // stale — so the flag would reflect the wrong tenant after a switch. When the active
    // tenant differs from the mount-time user tenant we fetch that tenant's settings
    // directly (/auth/me honours X-Tenant-Id and returns the requested tenant's settings).
    const settingsMatchActive = !!activeTenantId && activeTenantId === user?.tenantId;
    const { data: switchedSettings, isLoading: switchedSettingsLoading } = useQuery<Record<string, unknown>>({
        queryKey: ['tenant-settings', activeTenantId],
        queryFn: async ({ queryKey, signal }) => {
            // Pin the tenant to the KEY being fetched so a stale-key refetch after another
            // switch still targets the right tenant (same discipline as the deal query).
            const tid = queryKey[1] as string;
            const r = await api.get('/auth/me', { headers: { 'X-Tenant-Id': tid }, signal });
            return r.data?.user?.tenantSettings ?? {};
        },
        enabled: !!activeTenantId && !settingsMatchActive,
    });
    const activeSettings = settingsMatchActive ? user?.tenantSettings : switchedSettings;
    const dealMode = !!activeSettings?.deal_pipeline;
    // While the switched-tenant settings are in flight the mode is unknown; hold the
    // render so we never flash the wrong board (company ↔ deal) during a tenant switch.
    const settingsResolving = !!activeTenantId && !settingsMatchActive && switchedSettingsLoading;
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 300);
    // Additive work-signal filter: '' = none, 'overdue' = has an overdue pending task,
    // 'none' = no pending task at all. Threaded into the query so counts stay server-correct.
    const [taskFilter, setTaskFilter] = useState<'' | 'overdue' | 'none'>('');
    // Tag filter (v2 Phase 6) — kept isolated; threaded through the query + the
    // optimistic mutation's cache-key snapshot exactly like taskFilter.
    const [tagFilter, setTagFilter] = useState<string[]>([]);
    const [viewMode, setViewMode] = useState<string>('board');
    const searchRef = useRef<HTMLInputElement>(null);
    const undoStack = useUndoStack();

    // Table sort state
    type SortKey = 'name' | 'stage' | 'industry' | 'days' | 'updated_at' | 'contact_count';
    const [tableSortBy, setTableSortBy] = useState<SortKey>('updated_at');
    const [tableSortOrder, setTableSortOrder] = useState<'asc' | 'desc'>('desc');

    const handleTableSort = (column: SortKey) => {
        if (tableSortBy === column) {
            setTableSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
        } else {
            setTableSortBy(column);
            setTableSortOrder(column === 'name' || column === 'industry' ? 'asc' : 'desc');
        }
    };

    // Closing report modal state (triggered when dragging to terminal stage)
    const [closingReportState, setClosingReportState] = useState<{
        companyId: string;
        companyName: string;
        targetStage: ClosingOutcome;
    } | null>(null);

    // Page-level keyboard shortcuts
    useHotkeys([
        ['mod+K', () => searchRef.current?.focus()],
        ['mod+F', () => searchRef.current?.focus()],
        ['1', () => setViewMode('board')],
        ['2', () => setViewMode('table')],
        ['3', () => setViewMode('outcomes')],
        ['Escape', () => { if (search) setSearch(''); }],
        ['mod+Z', () => {
            const entry = undoStack.pop();
            if (entry) {
                entry.undo();
                showInfo(`${t('shortcuts.undone', 'Geri alındı')}: ${entry.description}`);
            }
        }],
    ]);

    const canDrag = hasRolePermission(role, 'pipeline_dragdrop');

    // Reset the tag filter when the active tenant changes — tag ids are tenant-scoped, so a
    // leftover selection from tenant A must not carry into (and silently mis-filter) tenant B.
    useEffect(() => {
        setTagFilter([]);
    }, [activeTenantId]);

    // Tenant tag catalogue (v2 Phase 6) — options for the tag filter.
    const { data: tagOptions } = useQuery<Array<{ id: string; name: string; color: string }>>({
        queryKey: ['tags', activeTenantId],
        queryFn: async ({ queryKey, signal }) => {
            const tid = queryKey[1] as string;
            return (await api.get('/tags', { headers: { 'X-Tenant-Id': tid }, signal })).data.data;
        },
        enabled: !!activeTenantId,
    });

    // Fetch pipeline data. activeTenantId in the key (internal roles switch tenant via
    // X-Tenant-Id) so a switch refetches and never shows a previous tenant's cached board;
    // the queryFn pins that tenant so a stale-key refetch targets the right tenant.
    const { data, isLoading, error } = useQuery<PipelineData>({
        queryKey: ['pipeline', activeTenantId, debouncedSearch, taskFilter, tagFilter],
        queryFn: async ({ queryKey, signal }) => {
            const tid = queryKey[1] as string;
            const params = new URLSearchParams();
            if (debouncedSearch) params.set('search', debouncedSearch);
            if (taskFilter === 'overdue') params.set('has_overdue_task', 'true');
            if (taskFilter === 'none') params.set('no_task', 'true');
            if (tagFilter.length) params.set('tags', tagFilter.join(','));
            const res = await api.get(`/companies/pipeline?${params.toString()}`, { headers: { 'X-Tenant-Id': tid }, signal });
            return res.data;
        },
        // In deal-mode the company pipeline is never rendered — skip the fetch.
        enabled: !dealMode && !!activeTenantId,
    });

    // Stage change mutation with optimistic update
    const stageMutation = useMutation({
        mutationFn: async ({ companyId, newStage }: { companyId: string; newStage: string }) => {
            const res = await api.patch(`/companies/${companyId}/stage`, { stage: newStage });
            return res.data;
        },
        onMutate: async ({ companyId, newStage }) => {
            // Capture tenant + search + filter at mutation time — user may change any before
            // onError fires, which would cause the rollback to write to the wrong cache key.
            const tenantSnapshot = activeTenantId;
            const searchSnapshot = debouncedSearch;
            const taskFilterSnapshot = taskFilter;
            const tagFilterSnapshot = tagFilter;

            await queryClient.cancelQueries({ queryKey: ['pipeline'] });
            const previous = queryClient.getQueryData<PipelineData>(['pipeline', tenantSnapshot, searchSnapshot, taskFilterSnapshot, tagFilterSnapshot]);

            // Optimistic update
            if (previous) {
                const updated = { ...previous, columns: { ...previous.columns } };
                let movedCompany: PipelineCompany | undefined;

                // Find and remove from old column
                for (const stage of Object.keys(updated.columns)) {
                    const idx = updated.columns[stage].findIndex((c) => c.id === companyId);
                    if (idx !== -1) {
                        movedCompany = { ...updated.columns[stage][idx], stage: newStage };
                        updated.columns[stage] = updated.columns[stage].filter((c) => c.id !== companyId);
                        break;
                    }
                }

                // Add to new column
                if (movedCompany && updated.columns[newStage]) {
                    updated.columns[newStage] = [movedCompany, ...updated.columns[newStage]];
                }

                queryClient.setQueryData(['pipeline', tenantSnapshot, searchSnapshot, taskFilterSnapshot, tagFilterSnapshot], updated);
            }

            return { previous, tenantSnapshot, searchSnapshot, taskFilterSnapshot, tagFilterSnapshot };
        },
        onError: (_err, _vars, context) => {
            // Rollback using the tenant + search + filter snapshot captured at mutation start
            if (context?.previous) {
                queryClient.setQueryData(['pipeline', context.tenantSnapshot, context.searchSnapshot, context.taskFilterSnapshot, context.tagFilterSnapshot], context.previous);
            }
            showError(t('pipeline.moveError'));
        },
        onSuccess: () => {
            showSuccess(t('pipeline.stageMoved'));
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['pipeline'] });
            queryClient.invalidateQueries({ queryKey: ['companies'] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
        },
    });

    const handleStageChange = useCallback(
        (companyId: string, newStage: string, oldStage: string) => {
            if (terminalStageSlugs.includes(newStage)) {
                // Terminal stage → open ClosingReportModal, do NOT call stageMutation
                const company = Object.values(data?.columns || {}).flat().find((c) => c.id === companyId);
                setClosingReportState({
                    companyId,
                    companyName: company?.name || companyId,
                    targetStage: newStage as ClosingOutcome,
                });
            } else {
                // Normal stage → existing mutation
                stageMutation.mutate({ companyId, newStage });
                undoStack.push({
                    description: t('pipeline.stageMoved', 'Aşama taşma'),
                    undo: () => stageMutation.mutate({ companyId, newStage: oldStage }),
                });
            }
        },
        // stageMutation.mutate is stable across renders (TanStack Query guarantee)
        [stageMutation.mutate, undoStack, t, data]
    );

    // ── Deal-mode (v2 Phase 5) ──────────────────────────────────────────────
    // Fully isolated from the company-mode data path above. The query is gated on
    // the flag so the default (company) experience issues no extra request.
    const { data: dealData, isLoading: dealLoading, error: dealError } = useQuery<DealsResponse>({
        // activeTenantId is part of the key so an internal-role tenant switch never
        // shows a previous tenant's cached deals; enabled guards a no-tenant query.
        queryKey: ['deals', 'pipeline', activeTenantId, debouncedSearch],
        queryFn: async ({ queryKey, signal }) => {
            // Pin the tenant to the KEY being fetched (not mutable localStorage/closure):
            // a stale-key refetch after a switch then targets the right tenant, so tenant
            // B's deals can never land under tenant A's key. The interceptor preserves it.
            const tid = queryKey[2] as string;
            // Single request; grouping into stage columns is done client-side.
            // limit=100 is the server cap — tenants with >100 open deals get
            // truncated columns (openQuestion: per-stage paged fetch later).
            const params = new URLSearchParams({ status: 'open', limit: '100' });
            if (debouncedSearch) params.set('search', debouncedSearch);
            const res = await api.get(`/deals?${params.toString()}`, { headers: { 'X-Tenant-Id': tid }, signal });
            return res.data;
        },
        enabled: dealMode && !!activeTenantId,
    });

    // Group open deals into pipeline-stage columns by their canonical stage_id.
    // deal.stage is a denormalized slug that lags a stage rename; resolving stage_id
    // to the *current* slug via allStages keeps a renamed stage's cards visible (they
    // would otherwise vanish when the cached slug no longer matches a column). Falls
    // back to the denormalized slug when stage_id is null. Won/lost deals are never
    // fetched (status=open); a deal that resolves to no pipeline column is not shown.
    const dealColumns = useMemo(() => {
        const cols: Record<string, Deal[]> = {};
        for (const slug of pipelineStageSlugs) cols[slug] = [];
        const idToSlug = new Map(allStages.map((s) => [s.id, s.slug]));
        for (const deal of dealData?.data || []) {
            const slug = (deal.stage_id && idToSlug.get(deal.stage_id)) || deal.stage;
            if (cols[slug]) cols[slug].push(deal);
        }
        return cols;
    }, [dealData, pipelineStageSlugs, allStages]);

    const totalOpenDeals = dealData?.pagination.total ?? 0;

    // Deal stage transition — mirrors stageMutation's optimistic + rollback shape.
    // The board speaks slugs; the API contract is stage_id, so the caller resolves
    // the slug to a stage id before mutating.
    const dealStageMutation = useMutation({
        mutationFn: async ({ dealId, stageId }: { dealId: string; newSlug: string; stageId: string }) => {
            const res = await api.put(`/deals/${dealId}`, { stage_id: stageId });
            return res.data;
        },
        onMutate: async ({ dealId, newSlug, stageId }) => {
            // Snapshot tenant + search at mutation time — either may change before onError
            // fires, which would otherwise read/write the wrong cache key. The key must
            // match the deal query's key exactly: ['deals','pipeline',tenant,search].
            const tenantSnapshot = activeTenantId;
            const searchSnapshot = debouncedSearch;
            const dealsKey = ['deals', 'pipeline', tenantSnapshot, searchSnapshot];
            await queryClient.cancelQueries({ queryKey: ['deals', 'pipeline', tenantSnapshot] });
            const previous = queryClient.getQueryData<DealsResponse>(dealsKey);
            // Capture ONLY the moved deal's prior stage (not the whole snapshot) so a
            // concurrent drag of a different deal isn't clobbered on rollback (P2-2).
            const prevDeal = previous?.data.find((d) => d.id === dealId);
            const prevStage = prevDeal ? { stage: prevDeal.stage, stage_id: prevDeal.stage_id } : null;
            if (previous) {
                const updated = {
                    ...previous,
                    data: previous.data.map((d) =>
                        d.id === dealId ? { ...d, stage: newSlug, stage_id: stageId } : d
                    ),
                };
                queryClient.setQueryData(dealsKey, updated);
            }
            return { dealsKey, prevStage, optimistic: { stage: newSlug, stage_id: stageId } };
        },
        onError: (_err, { dealId }, context) => {
            // Revert only THIS deal, and only if it still holds our optimistic value —
            // a concurrent successful drag of the same deal must not be undone, and a
            // concurrent drag of a different deal is untouched (functional update on the
            // live cache, not a stale full-snapshot restore).
            if (context?.prevStage) {
                queryClient.setQueryData<DealsResponse>(context.dealsKey, (curr) => {
                    if (!curr) return curr;
                    return {
                        ...curr,
                        data: curr.data.map((d) =>
                            d.id === dealId
                                && d.stage === context.optimistic.stage
                                && d.stage_id === context.optimistic.stage_id
                                ? { ...d, stage: context.prevStage!.stage, stage_id: context.prevStage!.stage_id }
                                : d
                        ),
                    };
                });
            }
            showError(t('dealPipeline.moveError'));
        },
        onSuccess: () => {
            showSuccess(t('dealPipeline.moved'));
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['deals'] });
        },
    });

    const handleDealStageChange = useCallback(
        (dealId: string, newSlug: string) => {
            // Resolve the column slug to a stage_id; the board only offers pipeline
            // columns, so a miss should never happen — guard + surface it if it does.
            const target = allStages.find((s) => s.slug === newSlug);
            if (!target) {
                showError(t('dealPipeline.moveError'));
                return;
            }
            dealStageMutation.mutate({ dealId, newSlug, stageId: target.id });
        },
        // dealStageMutation.mutate is stable across renders (TanStack Query guarantee)
        [allStages, dealStageMutation.mutate, t]
    );

    // Flatten all companies for table view, with client-side sorting
    const allCompanies = useMemo(() => {
        if (!data) return [];
        const flat = pipelineStageSlugs.flatMap((stage) => data.columns[stage] || []);

        const getDays = (c: PipelineCompany) =>
            c.stage_changed_at ? Math.floor((Date.now() - new Date(c.stage_changed_at).getTime()) / 86400000) : -1;

        return [...flat].sort((a, b) => {
            let cmp = 0;
            switch (tableSortBy) {
                case 'name':
                    cmp = a.name.localeCompare(b.name);
                    break;
                case 'stage':
                    cmp = a.stage.localeCompare(b.stage);
                    break;
                case 'industry':
                    cmp = (a.industry || '').localeCompare(b.industry || '');
                    break;
                case 'days':
                    cmp = getDays(a) - getDays(b);
                    break;
                case 'contact_count':
                    cmp = a.contact_count - b.contact_count;
                    break;
                case 'updated_at':
                    cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
                    break;
            }
            return tableSortOrder === 'asc' ? cmp : -cmp;
        });
    }, [data, pipelineStageSlugs, tableSortBy, tableSortOrder]);

    const totalActive = allCompanies.length;
    const terminalCounts = data?.terminalCounts || {};

    const allTerminalCompanies = useMemo(
        () => {
            if (!data?.terminalColumns) return [];
            return terminalStageSlugs.flatMap((stage) => data.terminalColumns[stage] || []);
        },
        [data, terminalStageSlugs]
    );
    const totalTerminal = allTerminalCompanies.length;

    const formatDate = (dateStr: string) =>
        new Date(dateStr).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
        });

    // Upgrade prompt for basic tier
    const upgradePrompt = (
        <Container size="xl" py="xl">
            <Paper shadow="sm" radius="lg" p="xl" withBorder>
                <Center>
                    <Stack align="center" gap="sm">
                        <IconColumns size={48} color="#6c63ff" stroke={1.5} />
                        <Text fw={600} size="lg">
                            {t('pipeline.upgradeTitle')}
                        </Text>
                        <Text c="dimmed" size="sm" ta="center" maw={400}>
                            {t('pipeline.upgradeDesc')}
                        </Text>
                    </Stack>
                </Center>
            </Paper>
        </Container>
    );

    // Active-tenant settings still resolving after a tenant switch — the deal/company
    // mode is not yet known, so hold with a loader rather than flash the wrong board.
    if (settingsResolving) {
        return (
            <Container size="xl" py="lg" style={{ maxWidth: '100%' }}>
                <Center py={120}>
                    <Loader size="lg" color="violet" />
                </Center>
            </Container>
        );
    }

    // ── Deal-mode board (flag on) ──────────────────────────────────────────
    // Isolated render branch; the company-mode return below is unchanged. The
    // board shows only open deals — closing happens in the deal drawer (E2), so
    // there are no terminal columns and no close-on-drag flow here.
    if (dealMode) {
        return (
            <TierGate feature="pipeline_view" fallback={upgradePrompt}>
                <Container size="xl" py="lg" style={{ maxWidth: '100%' }}>
                    <Flex justify="space-between" align="center" mb="md" wrap="wrap" gap="sm">
                        <Stack gap={0}>
                            <Group gap="xs">
                                <Title order={2} fw={700}>{t('dealPipeline.title')}</Title>
                                <Badge size="lg" variant="light" color="violet">{totalOpenDeals}</Badge>
                            </Group>
                            <Text size="sm" c="dimmed">{t('dealPipeline.subtitle')}</Text>
                        </Stack>
                        <TextInput
                            ref={searchRef}
                            placeholder={t('dealPipeline.search')}
                            leftSection={<IconSearch size={16} />}
                            value={search}
                            onChange={(e) => setSearch(e.currentTarget.value)}
                            radius="md"
                            size="sm"
                            w={220}
                            rightSection={
                                search && (
                                    <ActionIcon variant="subtle" size="sm" onClick={() => setSearch('')}>
                                        <IconX size={14} />
                                    </ActionIcon>
                                )
                            }
                        />
                    </Flex>

                    {(dealLoading || stagesLoading) && (
                        <Center py={120}>
                            <Loader size="lg" color="violet" />
                        </Center>
                    )}

                    {dealError && (
                        <Center py={80}>
                            <Stack align="center" gap="sm">
                                <IconWifi size={48} color="#ccc" stroke={1.5} />
                                <Text c="dimmed" fw={500}>{t('dealPipeline.loadError')}</Text>
                                <Group>
                                    <Button
                                        variant="light"
                                        leftSection={<IconRefresh size={16} />}
                                        onClick={() => queryClient.invalidateQueries({ queryKey: ['deals', 'pipeline'] })}
                                    >
                                        {t('common.retry', 'Yeniden Dene')}
                                    </Button>
                                    <ErrorFeedbackButton context="DealPipeline" />
                                </Group>
                            </Stack>
                        </Center>
                    )}

                    {!dealLoading && !stagesLoading && !dealError && (
                        <DealKanbanBoard
                            columns={dealColumns}
                            isDragEnabled={canDrag}
                            onStageChange={handleDealStageChange}
                        />
                    )}
                </Container>
            </TierGate>
        );
    }

    return (
        <TierGate feature="pipeline_view" fallback={upgradePrompt}>
            <Container size="xl" py="lg" style={{ maxWidth: '100%' }}>
                {/* Header */}
                <Flex justify="space-between" align="center" mb="md" wrap="wrap" gap="sm">
                    <Group gap="sm">
                        <Stack gap={0}>
                            <Group gap="xs">
                                <Title order={2} fw={700}>
                                    {viewMode === 'outcomes'
                                        ? t('pipeline.outcomesTitle')
                                        : viewMode === 'table'
                                        ? t('pipeline.tableTitle')
                                        : t('pipeline.boardTitle')}
                                </Title>
                                <Badge size="lg" variant="light" color="violet">
                                    {viewMode === 'outcomes' ? totalTerminal : totalActive}
                                </Badge>
                            </Group>
                            <Text size="sm" c="dimmed">
                                {viewMode === 'outcomes'
                                    ? t('pipeline.outcomesSubtitle')
                                    : viewMode === 'table'
                                    ? t('pipeline.tableSubtitle')
                                    : t('pipeline.boardSubtitle')}
                            </Text>
                        </Stack>
                    </Group>

                    <Group gap="sm">
                        <TextInput
                            ref={searchRef}
                            placeholder={t('pipeline.search')}
                            leftSection={<IconSearch size={16} />}
                            value={search}
                            onChange={(e) => setSearch(e.currentTarget.value)}
                            radius="md"
                            size="sm"
                            w={220}
                            rightSection={
                                search && (
                                    <ActionIcon variant="subtle" size="sm" onClick={() => setSearch('')}>
                                        <IconX size={14} />
                                    </ActionIcon>
                                )
                            }
                        />
                        {viewMode !== 'outcomes' && (
                            // Single-select: the server treats has_overdue_task and no_task as
                            // mutually exclusive (both → 400), so the UI can only ever pick one.
                            // The explicit "all" option ('') is the way back to an unfiltered board.
                            <SegmentedControl
                                size="xs"
                                value={taskFilter}
                                onChange={(v) => setTaskFilter(v as '' | 'overdue' | 'none')}
                                data={[
                                    { label: t('pipeline.filterAll'), value: '' },
                                    { label: t('pipeline.filterOverdueTask'), value: 'overdue' },
                                    { label: t('pipeline.filterNoTask'), value: 'none' },
                                ]}
                            />
                        )}
                        <MultiSelect
                            size="xs"
                            placeholder={tagFilter.length === 0 ? t('qualification.tags') : undefined}
                            data={(tagOptions ?? []).map((tag) => ({ value: tag.id, label: tag.name }))}
                            value={tagFilter}
                            onChange={setTagFilter}
                            clearable
                            searchable
                            radius="md"
                            w={180}
                            maxDropdownHeight={220}
                        />
                        <SegmentedControl
                            size="xs"
                            value={viewMode}
                            onChange={setViewMode}
                            data={[
                                { label: <IconLayoutKanban size={16} />, value: 'board' },
                                { label: <IconTable size={16} />, value: 'table' },
                                { label: <IconTrophy size={16} />, value: 'outcomes' },
                            ]}
                        />
                    </Group>
                </Flex>

                {/* Loading */}
                {isLoading && (
                    <Center py={120}>
                        <Loader size="lg" color="violet" />
                    </Center>
                )}

                {/* Error */}
                {error && (
                    <Center py={80}>
                        <Stack align="center" gap="sm">
                            <IconWifi size={48} color="#ccc" stroke={1.5} />
                            <Text c="dimmed" fw={500}>{t('pipeline.loadError', 'Pipeline yüklenemedi')}</Text>
                            <Group>
                                <Button
                                    variant="light"
                                    leftSection={<IconRefresh size={16} />}
                                    onClick={() => queryClient.invalidateQueries({ queryKey: ['pipeline'] })}
                                >
                                    {t('common.retry', 'Yeniden Dene')}
                                </Button>
                                <ErrorFeedbackButton context="Pipeline" />
                            </Group>
                        </Stack>
                    </Center>
                )}

                {/* Board View */}
                {!isLoading && !error && data && viewMode === 'board' && (
                    <KanbanBoard
                        columns={data.columns}
                        isDragEnabled={canDrag}
                        onStageChange={handleStageChange}
                        initialFocusStage={focusStage}
                        terminalCounts={terminalCounts}
                    />
                )}

                {/* Table View */}
                {!isLoading && !error && data && viewMode === 'table' && (
                    <Paper shadow="sm" radius="lg" withBorder style={{ overflow: 'hidden' }}>
                        {allCompanies.length === 0 ? (
                            <Center py={80}>
                                <Stack align="center" gap="sm">
                                    <IconColumns size={48} color="#ccc" />
                                    {debouncedSearch ? (
                                        <>
                                            <Text fw={500} c="dimmed">
                                                “{debouncedSearch}” {t('pipeline.noSearchResults', 'için sonuç bulunamadı')}
                                            </Text>
                                            <Button
                                                size="xs"
                                                variant="subtle"
                                                leftSection={<IconX size={14} />}
                                                onClick={() => setSearch('')}
                                            >
                                                {t('filter.clearSearch', 'Aramayı Temizle')}
                                            </Button>
                                        </>
                                    ) : (
                                        <Text fw={500} c="dimmed">{t('pipeline.noData')}</Text>
                                    )}
                                </Stack>
                            </Center>
                        ) : (
                            <Table.ScrollContainer minWidth={1100}>
                                <Table
                                    striped
                                    highlightOnHover
                                    verticalSpacing="sm"
                                    horizontalSpacing="md"
                                    styles={{
                                        thead: {
                                            background: 'linear-gradient(135deg, #1a1b2e 0%, #16213e 100%)',
                                        },
                                        th: {
                                            fontWeight: 600,
                                            fontSize: '0.85rem',
                                            textTransform: 'uppercase',
                                            letterSpacing: '0.5px',
                                            padding: '12px 16px',
                                            whiteSpace: 'nowrap',
                                            color: 'white',
                                        },
                                    }}
                                >
                                    <Table.Thead>
                                        <Table.Tr>
                                            {([
                                                ['name', t('company.name')],
                                                ['stage', t('company.stage')],
                                                ['industry', t('company.industry')],
                                                [null, t('pipeline.owner')],
                                                [null, t('company.nextStep')],
                                                [null, t('pipeline.nextTask')],
                                                [null, t('pipeline.lastContact')],
                                                ['contact_count', t('contacts.title')],
                                                ['days', t('pipeline.daysInStage')],
                                                ['updated_at', t('company.updatedAt')],
                                            ] as const).map(([key, label], i) =>
                                                key ? (
                                                    <Table.Th key={key}>
                                                        <UnstyledButton
                                                            onClick={() => handleTableSort(key as SortKey)}
                                                            style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                                                        >
                                                            <Text size="xs" fw={600} tt="uppercase" style={{ letterSpacing: '0.5px', color: 'white' }}>
                                                                {label}
                                                            </Text>
                                                            {(() => {
                                                                const isSorted = tableSortBy === key;
                                                                const Icon = isSorted
                                                                    ? (tableSortOrder === 'asc' ? IconChevronUp : IconChevronDown)
                                                                    : IconSelector;
                                                                return <Icon size={14} color={isSorted ? '#a78bfa' : 'rgba(255,255,255,0.5)'} />;
                                                            })()}
                                                        </UnstyledButton>
                                                    </Table.Th>
                                                ) : (
                                                    <Table.Th key={`ns-${i}`}>
                                                        <Text size="xs" fw={600} tt="uppercase" c="white" style={{ letterSpacing: '0.5px' }}>
                                                            {label}
                                                        </Text>
                                                    </Table.Th>
                                                )
                                            )}
                                        </Table.Tr>
                                    </Table.Thead>
                                    <Table.Tbody>
                                        {allCompanies.map((company) => {
                                            const days = company.stage_changed_at
                                                ? Math.floor((Date.now() - new Date(company.stage_changed_at).getTime()) / 86400000)
                                                : null;
                                            const nextTask = company.next_task;
                                            const nextTaskOverdue = nextTask ? isTaskOverdue(nextTask.due_at) : false;
                                            const contactAge = getContactAgeDays(company.last_contact_at);
                                            const owner = company.assigned_user;
                                            return (
                                                <Table.Tr
                                                    key={company.id}
                                                    style={{ cursor: 'pointer' }}
                                                    onClick={() => navigate(`/companies/${company.id}`)}
                                                >
                                                    <Table.Td>
                                                        <Group gap="xs" wrap="nowrap">
                                                            <Text size="sm" fw={600}>{company.name}</Text>
                                                            {company.contact_count > 0 && (
                                                                <Badge size="xs" variant="light" color="violet" leftSection={<IconUsers size={10} />}>
                                                                    {company.contact_count}
                                                                </Badge>
                                                            )}
                                                        </Group>
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <Badge
                                                            color={getStageColor(company.stage)}
                                                            variant="light"
                                                            size="sm"
                                                        >
                                                            {t(`stages.${company.stage}`)}
                                                        </Badge>
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <Text size="sm" c="dimmed">{company.industry || '—'}</Text>
                                                    </Table.Td>
                                                    <Table.Td>
                                                        {owner ? (
                                                            <Tooltip label={owner.name || owner.email} withArrow>
                                                                <Group gap={6} wrap="nowrap">
                                                                    <Avatar size={22} radius="xl" variant="light" color="violet">
                                                                        <Text size="10px" fw={700}>
                                                                            {getOwnerInitials(owner.name, owner.email)}
                                                                        </Text>
                                                                    </Avatar>
                                                                    <Text size="sm" lineClamp={1} maw={120}>
                                                                        {owner.name || owner.email}
                                                                    </Text>
                                                                </Group>
                                                            </Tooltip>
                                                        ) : (
                                                            <Text size="xs" c="dimmed">{t('pipeline.unassigned')}</Text>
                                                        )}
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <Text size="sm" lineClamp={1} maw={200}>{company.next_step || '—'}</Text>
                                                    </Table.Td>
                                                    <Table.Td>
                                                        {nextTask ? (
                                                            <Group gap={6} wrap="nowrap">
                                                                <Text size="sm" lineClamp={1} maw={160}>{nextTask.title}</Text>
                                                                <Badge
                                                                    size="xs"
                                                                    variant={nextTaskOverdue ? 'filled' : 'light'}
                                                                    color={nextTaskOverdue ? 'red' : 'gray'}
                                                                    leftSection={nextTaskOverdue ? <IconAlertTriangle size={9} /> : <IconClock size={9} />}
                                                                >
                                                                    {nextTaskOverdue ? t('pipeline.overdue') : formatDate(nextTask.due_at)}
                                                                </Badge>
                                                            </Group>
                                                        ) : (
                                                            <Text size="xs" c="dimmed">{t('pipeline.noTask')}</Text>
                                                        )}
                                                    </Table.Td>
                                                    <Table.Td>
                                                        {contactAge === null ? (
                                                            <Text size="xs" c="dimmed">{t('pipeline.neverContacted')}</Text>
                                                        ) : (
                                                            <Tooltip label={new Date(company.last_contact_at!).toLocaleDateString()} withArrow>
                                                                <Group gap={4} wrap="nowrap">
                                                                    <IconHistory size={13} color="var(--mantine-color-dimmed)" />
                                                                    <Text size="sm" c="dimmed">
                                                                        {contactAge === 0 ? t('pipeline.contactToday') : `${contactAge}${t('pipeline.ageDaysShort')}`}
                                                                    </Text>
                                                                </Group>
                                                            </Tooltip>
                                                        )}
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <Group gap={4}>
                                                            <IconUsers size={14} color="var(--mantine-color-violet-5)" />
                                                            <Text size="sm" fw={500}>{company.contact_count}</Text>
                                                        </Group>
                                                    </Table.Td>
                                                    <Table.Td>
                                                        {days !== null ? (
                                                            <Badge
                                                                size="sm"
                                                                variant="light"
                                                                color={days > 14 ? 'red' : days > 7 ? 'orange' : 'gray'}
                                                            >
                                                                {days}{t('pipeline.days')}
                                                            </Badge>
                                                        ) : (
                                                            <Text size="xs" c="dimmed">—</Text>
                                                        )}
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <Text size="xs" c="dimmed">{formatDate(company.updated_at)}</Text>
                                                    </Table.Td>
                                                </Table.Tr>
                                            );
                                        })}
                                    </Table.Tbody>
                                </Table>
                            </Table.ScrollContainer>
                        )}
                    </Paper>
                )}

                {/* Outcomes View */}
                {!isLoading && !error && data && viewMode === 'outcomes' && (
                    data.terminalColumns && allTerminalCompanies.length > 0 ? (
                        <KanbanBoard
                            columns={data.terminalColumns}
                            isDragEnabled={false}
                            onStageChange={() => {}}
                            stageSlugs={terminalStageSlugs}
                            hideTerminalZones
                            isOutcomesView
                        />
                    ) : (
                        <Center py={80}>
                            <Stack align="center" gap="sm">
                                <IconTrophy size={48} color="#ccc" />
                                {debouncedSearch ? (
                                    <>
                                        <Text fw={500} c="dimmed">
                                            "{debouncedSearch}" {t('pipeline.noSearchResults', 'için sonuç bulunamadı')}
                                        </Text>
                                        <Button
                                            size="xs"
                                            variant="subtle"
                                            leftSection={<IconX size={14} />}
                                            onClick={() => setSearch('')}
                                        >
                                            {t('filter.clearSearch', 'Aramayı Temizle')}
                                        </Button>
                                    </>
                                ) : (
                                    <Text fw={500} c="dimmed">{t('pipeline.noOutcomes', 'Henüz sonuçlanan şirket yok')}</Text>
                                )}
                            </Stack>
                        </Center>
                    )
                )}
            </Container>

            {closingReportState && (
                <ClosingReportModal
                    opened={true}
                    onClose={() => setClosingReportState(null)}
                    companyId={closingReportState.companyId}
                    companyName={closingReportState.companyName}
                    targetStage={closingReportState.targetStage}
                    onSuccess={() => {
                        setClosingReportState(null);
                    }}
                />
            )}
        </TierGate>
    );
}
