import { useState, useCallback, useEffect, useRef } from 'react';
import {
    Box,
    Paper,
    Text,
    Badge,
    Stack,
    ScrollArea,
    Group,
    Center,
    Tooltip,
    Skeleton,
    Button,
    ThemeIcon,
} from '@mantine/core';
import { IconPlus, IconTrophy, IconXboxX, IconClock, IconBan } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import ActivityTimeline from '../ActivityTimeline';
import ActivityForm from '../ActivityForm';
import { useQuery } from '@tanstack/react-query';
import {
    DndContext,
    DragOverlay,
    useDroppable,
    pointerWithin,
    rectIntersection,
    PointerSensor,
    TouchSensor,
    useSensor,
    useSensors,
    type DragStartEvent,
    type DragEndEvent,
    type CollisionDetection,
} from '@dnd-kit/core';
import { useStages } from '../../contexts/StagesContext';
import api from '../../lib/api';
import PipelineCard, { type PipelineCompany } from './PipelineCard';

interface KanbanBoardProps {
    columns: Record<string, PipelineCompany[]>;
    isDragEnabled: boolean;
    onStageChange: (companyId: string, newStage: string, oldStage: string) => void;
    initialFocusStage?: string | null;
    terminalCounts?: Record<string, number>;
    /** Override which stage slugs to render as columns (defaults to pipelineStageSlugs) */
    stageSlugs?: string[];
    /** Hide the terminal drop zones row */
    hideTerminalZones?: boolean;
    /** Outcomes view: show closing report + read-only activities in spotlight */
    isOutcomesView?: boolean;
}

const TERMINAL_ICONS: Record<string, typeof IconTrophy> = {
    won: IconTrophy,
    lost: IconXboxX,
    on_hold: IconClock,
    cancelled: IconBan,
};

/** Droppable zone for a terminal stage */
function TerminalDropZone({
    stage,
    count,
    isOver,
    isDragging,
}: {
    stage: string;
    count: number;
    isOver: boolean;
    isDragging: boolean;
}) {
    const { getStageColor, getStageLabel } = useStages();
    const { setNodeRef } = useDroppable({ id: stage });
    const color = getStageColor(stage);
    const Icon = TERMINAL_ICONS[stage] || IconBan;

    return (
        <Paper
            ref={setNodeRef}
            radius="md"
            px="md"
            py="xs"
            withBorder
            style={{
                flex: '1 1 0',
                minWidth: 0,
                transition: 'all 200ms ease',
                borderColor: isOver
                    ? `var(--mantine-color-${color}-5)`
                    : isDragging
                    ? `var(--mantine-color-${color}-3)`
                    : 'var(--mantine-color-default-border)',
                backgroundColor: isOver
                    ? `var(--mantine-color-${color}-light)`
                    : undefined,
                transform: isOver ? 'scale(1.03)' : undefined,
                boxShadow: isOver ? `0 0 12px var(--mantine-color-${color}-3)` : undefined,
                opacity: isDragging ? 1 : 0.85,
            }}
        >
            <Group gap="xs" wrap="nowrap" justify="center">
                <ThemeIcon
                    variant="light"
                    color={color}
                    size="sm"
                    radius="xl"
                >
                    <Icon size={14} />
                </ThemeIcon>
                <Text size="xs" fw={600} tt="uppercase" style={{ letterSpacing: '0.3px' }}>
                    {getStageLabel(stage)}
                </Text>
                {count > 0 && (
                    <Badge size="sm" variant="filled" color={color} radius="xl">
                        {count}
                    </Badge>
                )}
            </Group>
        </Paper>
    );
}

/** Lazy-loaded detail panel for a single company card */
function CompanyDetailCell({ companyId }: { companyId: string }) {
    const { t } = useTranslation();
    const ref = useRef<HTMLDivElement>(null);
    const [isVisible, setIsVisible] = useState(false);
    const [formOpened, setFormOpened] = useState(false);
    const [typeFilter] = useState('');

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const observer = new IntersectionObserver(
            ([entry]) => { if (entry.isIntersecting) { setIsVisible(true); observer.disconnect(); } },
            { threshold: 0.1 },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // Fetch contacts for ActivityForm selector
    const { data } = useQuery<{ contacts: { id: string; first_name: string; last_name?: string | null }[] }>({
        queryKey: ['company', companyId],
        queryFn: async () => (await api.get(`/companies/${companyId}`)).data.data,
        enabled: isVisible,
        staleTime: 60_000,
    });

    return (
        <Box ref={ref} style={{ flex: 1, minWidth: 0 }}>
            {!isVisible ? (
                <Stack gap={6}>
                    <Skeleton height={12} width="60%" radius="sm" />
                    <Skeleton height={10} width="80%" radius="sm" />
                </Stack>
            ) : (
                <Stack gap="xs">
                    <Button
                        size="compact-xs"
                        variant="light"
                        leftSection={<IconPlus size={14} />}
                        onClick={() => setFormOpened(true)}
                    >
                        {t('activities.addActivity')}
                    </Button>
                    <ActivityTimeline companyId={companyId} compact typeFilter={typeFilter} hideEmpty />
                    <ActivityForm
                        opened={formOpened}
                        onClose={() => setFormOpened(false)}
                        companyId={companyId}
                        contacts={data?.contacts}
                    />
                </Stack>
            )}
        </Box>
    );
}

/** Spotlight panel for outcomes view — shows closing report + read-only activities */
function OutcomeDetailCell({ companyId, closingReport }: { companyId: string; closingReport?: { summary: string; detail: string | null; outcome: string; occurred_at: string } | null }) {
    const { t } = useTranslation();
    const ref = useRef<HTMLDivElement>(null);
    const [isVisible, setIsVisible] = useState(false);

    const OUTCOME_COLORS: Record<string, string> = { won: 'green', lost: 'red', on_hold: 'gray', cancelled: 'dark' };
    const OUTCOME_ICONS: Record<string, React.ReactNode> = {
        won: <IconTrophy size={12} />, lost: <IconXboxX size={12} />,
        on_hold: <IconClock size={12} />, cancelled: <IconBan size={12} />,
    };

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const observer = new IntersectionObserver(
            ([entry]) => { if (entry.isIntersecting) { setIsVisible(true); observer.disconnect(); } },
            { threshold: 0.1 },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const formatDate = (d: string) => new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

    return (
        <Box ref={ref} style={{ flex: 1, minWidth: 0 }}>
            {!isVisible ? (
                <Stack gap={6}>
                    <Skeleton height={12} width="60%" radius="sm" />
                    <Skeleton height={10} width="80%" radius="sm" />
                </Stack>
            ) : (
                <Stack gap="xs">
                    {closingReport && (
                        <Stack gap={4}>
                            <Group gap="xs">
                                <Badge
                                    size="sm"
                                    variant="filled"
                                    color={OUTCOME_COLORS[closingReport.outcome] || 'gray'}
                                    leftSection={OUTCOME_ICONS[closingReport.outcome]}
                                >
                                    {t(`activity.closingReport.${closingReport.outcome}`, closingReport.outcome)}
                                </Badge>
                                <Text size="xs" c="dimmed">{formatDate(closingReport.occurred_at)}</Text>
                            </Group>
                            <Text size="xs" fw={500} lineClamp={2}>{closingReport.summary}</Text>
                            {closingReport.detail && (
                                <Text size="xs" c="dimmed" lineClamp={1}>{closingReport.detail}</Text>
                            )}
                        </Stack>
                    )}
                    <ActivityTimeline companyId={companyId} compact hideEmpty />
                </Stack>
            )}
        </Box>
    );
}

/** A single droppable column */
function StageColumn({
    stage,
    companies,
    isDragEnabled,
    isOver,
    isSpotlight,
    isCollapsed,
    onHeaderClick,
    isOutcomesView = false,
}: {
    stage: string;
    companies: PipelineCompany[];
    isDragEnabled: boolean;
    isOver: boolean;
    isSpotlight: boolean;
    isCollapsed: boolean;
    onHeaderClick: (stage: string) => void;
    isOutcomesView?: boolean;
}) {
    const { t } = useTranslation();
    const { getStageColor, getStageLabel } = useStages();
    const { setNodeRef } = useDroppable({ id: stage });
    const color = getStageColor(stage);

    // Collapsed column — vertical title + badge
    if (isCollapsed) {
        return (
            <Paper
                ref={setNodeRef}
                radius="lg"
                p={0}
                withBorder
                style={{
                    flex: '0 0 48px',
                    minWidth: 48,
                    maxWidth: 48,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    maxHeight: '100%',
                    overflow: 'hidden',
                    transition: 'flex 300ms ease, min-width 300ms ease, max-width 300ms ease, border-color 150ms ease, background-color 150ms ease',
                    borderColor: isOver ? `var(--mantine-color-${color}-4)` : undefined,
                    backgroundColor: `var(--mantine-color-${color}-light)`,
                    cursor: 'pointer',
                }}
                onClick={() => onHeaderClick(stage)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onHeaderClick(stage); } }}
            >
                <Box py="sm" px={4} style={{ textAlign: 'center' }}>
                    <Badge size="sm" variant="light" color={color} mb="xs" style={{ minWidth: 22, paddingInline: 6 }}>
                        {companies.length}
                    </Badge>
                    <Text
                        size="xs"
                        fw={700}
                        tt="uppercase"
                        style={{
                            writingMode: 'vertical-rl',
                            textOrientation: 'mixed',
                            letterSpacing: '1px',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {getStageLabel(stage)}
                    </Text>
                </Box>
            </Paper>
        );
    }

    // Normal or spotlight column
    const flexStyle = isSpotlight
        ? { flex: '1 1 auto', minWidth: 500, maxWidth: 'none' as const }
        : { flex: '0 0 280px', minWidth: 260, maxWidth: 300 };

    return (
        <Paper
            ref={setNodeRef}
            radius="lg"
            p={0}
            withBorder
            style={{
                ...flexStyle,
                display: 'flex',
                flexDirection: 'column',
                maxHeight: '100%',
                transition: 'flex 300ms ease, min-width 300ms ease, max-width 300ms ease, border-color 150ms ease, background-color 150ms ease',
                borderColor: isOver
                    ? `var(--mantine-color-${color}-4)`
                    : isSpotlight
                    ? `var(--mantine-color-${color}-5)`
                    : undefined,
                backgroundColor: isOver ? `var(--mantine-color-${color}-light)` : undefined,
            }}
        >
            {/* Column Header */}
            <Tooltip
                label={isSpotlight ? t('pipeline.spotlight.exit') : t('pipeline.spotlight.hint')}
                position="top"
                withArrow
                openDelay={500}
            >
                <Box
                    px="sm"
                    py="xs"
                    style={{
                        borderBottom: '1px solid var(--mantine-color-default-border)',
                        background: `var(--mantine-color-${color}-light)`,
                        borderRadius: 'var(--mantine-radius-lg) var(--mantine-radius-lg) 0 0',
                        cursor: 'pointer',
                    }}
                    onClick={() => onHeaderClick(stage)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onHeaderClick(stage); } }}
                >
                    <Group justify="space-between" wrap="nowrap">
                        <Text size="xs" fw={700} tt="uppercase" style={{ letterSpacing: '0.5px' }}>
                            {getStageLabel(stage)}
                        </Text>
                        <Badge size="sm" variant="light" color={color} style={{ minWidth: 22, paddingInline: 6 }}>
                            {companies.length}
                        </Badge>
                    </Group>
                </Box>
            </Tooltip>

            {/* Cards */}
            <ScrollArea.Autosize mah="calc(100vh - 280px)" offsetScrollbars type="auto">
                <Stack gap="xs" p="xs">
                    {companies.length === 0 ? (
                        <Center py="xl">
                            <Text size="xs" c="dimmed">{t('pipeline.emptyColumn')}</Text>
                        </Center>
                    ) : (
                        companies.map((company) =>
                            isSpotlight ? (
                                <Box
                                    key={company.id}
                                    style={{
                                        display: 'flex',
                                        gap: 12,
                                        alignItems: 'start',
                                    }}
                                >
                                    <Box style={{ flex: '0 0 260px', minWidth: 260 }}>
                                        <PipelineCard company={company} isDragEnabled={isDragEnabled} />
                                    </Box>
                                    <Paper
                                        p="sm"
                                        radius="md"
                                        withBorder
                                        style={{
                                            flex: 1,
                                            minWidth: 0,
                                            background: 'var(--mantine-color-default-hover)',
                                        }}
                                    >
                                        {isOutcomesView ? (
                                            <OutcomeDetailCell companyId={company.id} closingReport={company.closing_report} />
                                        ) : (
                                            <CompanyDetailCell companyId={company.id} />
                                        )}
                                    </Paper>
                                </Box>
                            ) : (
                                <PipelineCard
                                    key={company.id}
                                    company={company}
                                    isDragEnabled={isDragEnabled}
                                />
                            )
                        )
                    )}
                </Stack>
            </ScrollArea.Autosize>
        </Paper>
    );
}

// Custom collision: prefer pointerWithin (precise), fall back to rectIntersection
const collisionDetection: CollisionDetection = (args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) return pointerCollisions;
    return rectIntersection(args);
};

/** Resolve over.id to a stage name — handles dropping on a card (UUID), column (stage), or terminal zone */
function resolveTargetStage(
    overId: string,
    columns: Record<string, PipelineCompany[]>,
    pipelineSlugs: string[],
    terminalSlugs: string[],
): string | null {
    if (pipelineSlugs.includes(overId)) return overId;
    if (terminalSlugs.includes(overId)) return overId;
    for (const stage of pipelineSlugs) {
        if (columns[stage]?.some((c) => c.id === overId)) return stage;
    }
    return null;
}

export default function KanbanBoard({
    columns,
    isDragEnabled,
    onStageChange,
    initialFocusStage,
    terminalCounts = {},
    stageSlugs: customStageSlugs,
    hideTerminalZones = false,
    isOutcomesView = false,
}: KanbanBoardProps) {
    const { pipelineStageSlugs, terminalStageSlugs } = useStages();
    const stageSlugs = customStageSlugs || pipelineStageSlugs;
    const [activeCompany, setActiveCompany] = useState<PipelineCompany | null>(null);
    const [overColumnId, setOverColumnId] = useState<string | null>(null);
    const [spotlightStage, setSpotlightStage] = useState<string | null>(initialFocusStage ?? null);

    const toggleSpotlight = useCallback((stage: string) => {
        setSpotlightStage((prev) => (prev === stage ? null : stage));
    }, []);

    useEffect(() => {
        if (!spotlightStage) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setSpotlightStage(null);
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [spotlightStage]);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
    );

    const handleDragStart = useCallback((event: DragStartEvent) => {
        const company = event.active.data.current?.company as PipelineCompany | undefined;
        if (company) setActiveCompany(company);
    }, []);

    const handleDragOver = useCallback((event: { over: { id: string | number } | null }) => {
        if (!event.over) {
            setOverColumnId(null);
            return;
        }
        const id = String(event.over.id);
        const stage = resolveTargetStage(id, columns, stageSlugs, terminalStageSlugs);
        setOverColumnId(stage);
    }, [columns, stageSlugs, terminalStageSlugs]);

    const handleDragEnd = useCallback(
        (event: DragEndEvent) => {
            setActiveCompany(null);
            setOverColumnId(null);

            const { active, over } = event;
            if (!over) return;

            const company = active.data.current?.company as PipelineCompany | undefined;
            if (!company) return;

            const newStage = resolveTargetStage(String(over.id), columns, stageSlugs, terminalStageSlugs);
            if (newStage && newStage !== company.stage) {
                onStageChange(company.id, newStage, company.stage);
            }
        },
        [onStageChange, columns, stageSlugs, terminalStageSlugs]
    );

    const handleDragCancel = useCallback(() => {
        setActiveCompany(null);
        setOverColumnId(null);
    }, []);

    const isDragging = activeCompany !== null;

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
        >
            {/* Terminal stage drop zones */}
            {!hideTerminalZones && terminalStageSlugs.length > 0 && (
                <Box
                    style={{
                        display: 'flex',
                        gap: 8,
                        marginBottom: 12,
                    }}
                >
                    {terminalStageSlugs.map((slug) => (
                        <TerminalDropZone
                            key={slug}
                            stage={slug}
                            count={terminalCounts[slug] || 0}
                            isOver={overColumnId === slug}
                            isDragging={isDragging}
                        />
                    ))}
                </Box>
            )}

            <Box
                style={{
                    display: 'flex',
                    gap: 12,
                    overflowX: 'auto',
                    paddingBottom: 8,
                    alignItems: 'flex-start',
                }}
            >
                {stageSlugs.map((stage) => (
                    <StageColumn
                        key={stage}
                        stage={stage}
                        companies={columns[stage] || []}
                        isDragEnabled={isDragEnabled}
                        isOver={overColumnId === stage}
                        isSpotlight={spotlightStage === stage}
                        isCollapsed={spotlightStage !== null && spotlightStage !== stage}
                        onHeaderClick={toggleSpotlight}
                        isOutcomesView={isOutcomesView}
                    />
                ))}
            </Box>

            {/* Drag overlay: floating card that follows cursor */}
            <DragOverlay dropAnimation={null}>
                {activeCompany ? (
                    <Paper shadow="lg" radius="md" p="sm" withBorder style={{ width: 270, opacity: 0.9 }}>
                        <Stack gap={4}>
                            <Text size="sm" fw={600} lineClamp={1}>{activeCompany.name}</Text>
                            {activeCompany.industry && (
                                <Text size="xs" c="dimmed">{activeCompany.industry}</Text>
                            )}
                        </Stack>
                    </Paper>
                ) : null}
            </DragOverlay>
        </DndContext>
    );
}
