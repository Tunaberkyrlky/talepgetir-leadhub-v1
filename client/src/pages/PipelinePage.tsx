import { useState, useCallback, useMemo, useRef } from 'react';
import {
    Container,
    Title,
    Flex,
    Group,
    TextInput,
    ActionIcon,
    SegmentedControl,
    Badge,
    Text,
    Paper,
    Stack,
    Table,
    Center,
    Loader,
    Button,
    UnstyledButton,
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
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { TierGate } from '../components/FeatureGate';
import { hasRolePermission } from '../lib/permissions';
import { useStages } from '../contexts/StagesContext';
import KanbanBoard from '../components/pipeline/KanbanBoard';
import type { PipelineCompany } from '../components/pipeline/PipelineCard';
import { useUndoStack } from '../hooks/useUndoStack';
import ClosingReportModal from '../components/ClosingReportModal';
import { TERMINAL_STAGES } from '../lib/stages';
import type { ClosingOutcome } from '../types/activity';

interface PipelineData {
    columns: Record<string, PipelineCompany[]>;
    terminalCounts: Record<string, number>;
    terminalColumns: Record<string, PipelineCompany[]>;
}

export default function PipelinePage() {
    const { t } = useTranslation();
    const { user } = useAuth();
    const { pipelineStageSlugs, terminalStageSlugs, getStageColor } = useStages();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const focusStage = searchParams.get('focus');
    const role = user?.role || '';
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 300);
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

    // Fetch pipeline data
    const { data, isLoading, error } = useQuery<PipelineData>({
        queryKey: ['pipeline', debouncedSearch],
        queryFn: async () => {
            const params = new URLSearchParams();
            if (debouncedSearch) params.set('search', debouncedSearch);
            const res = await api.get(`/companies/pipeline?${params.toString()}`);
            return res.data;
        },
    });

    // Stage change mutation with optimistic update
    const stageMutation = useMutation({
        mutationFn: async ({ companyId, newStage }: { companyId: string; newStage: string }) => {
            const res = await api.patch(`/companies/${companyId}/stage`, { stage: newStage });
            return res.data;
        },
        onMutate: async ({ companyId, newStage }) => {
            // Capture search at mutation time — user may change it before onError fires,
            // which would cause the rollback to write to the wrong cache key.
            const searchSnapshot = debouncedSearch;

            await queryClient.cancelQueries({ queryKey: ['pipeline'] });
            const previous = queryClient.getQueryData<PipelineData>(['pipeline', searchSnapshot]);

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

                queryClient.setQueryData(['pipeline', searchSnapshot], updated);
            }

            return { previous, searchSnapshot };
        },
        onError: (_err, _vars, context) => {
            // Rollback using the search snapshot captured at mutation start
            if (context?.previous) {
                queryClient.setQueryData(['pipeline', context.searchSnapshot], context.previous);
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
            if (TERMINAL_STAGES.includes(newStage as any)) {
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
                            <Button
                                variant="light"
                                leftSection={<IconRefresh size={16} />}
                                onClick={() => queryClient.invalidateQueries({ queryKey: ['pipeline'] })}
                            >
                                {t('common.retry', 'Yeniden Dene')}
                            </Button>
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
                            <Table.ScrollContainer minWidth={700}>
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
                                                [null, t('company.nextStep')],
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
                                                        <Text size="sm" lineClamp={1} maw={200}>{company.next_step || '—'}</Text>
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
