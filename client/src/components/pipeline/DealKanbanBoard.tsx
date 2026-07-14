import { useState, useCallback } from 'react';
import { Box, Paper, Text, Badge, Stack, ScrollArea, Group, Center } from '@mantine/core';
import { useTranslation } from 'react-i18next';
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
import DealCard from './DealCard';
import type { Deal } from '../../types/deal';

interface DealKanbanBoardProps {
    columns: Record<string, Deal[]>;
    isDragEnabled: boolean;
    /** slug-based; the page resolves the slug to a stage_id before the PUT. */
    onStageChange: (dealId: string, newSlug: string, oldSlug: string) => void;
}

// Custom collision: prefer pointerWithin (precise), fall back to rectIntersection
const collisionDetection: CollisionDetection = (args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) return pointerCollisions;
    return rectIntersection(args);
};

/** Resolve over.id to a pipeline stage slug. The deal board renders pipeline
 *  columns only (no terminal drop zones — won/lost deals never appear here), so a
 *  drop resolves to a column slug or the slug of the card it landed on. */
function resolveTargetStage(
    overId: string,
    columns: Record<string, Deal[]>,
    pipelineSlugs: string[],
): string | null {
    if (pipelineSlugs.includes(overId)) return overId;
    for (const stage of pipelineSlugs) {
        if (columns[stage]?.some((d) => d.id === overId)) return stage;
    }
    return null;
}

/** A single droppable pipeline-stage column of deal cards. */
function DealStageColumn({
    stage,
    deals,
    isDragEnabled,
    isOver,
}: {
    stage: string;
    deals: Deal[];
    isDragEnabled: boolean;
    isOver: boolean;
}) {
    const { t } = useTranslation();
    const { getStageColor, getStageLabel } = useStages();
    const { setNodeRef } = useDroppable({ id: stage });
    const color = getStageColor(stage);

    return (
        <Paper
            ref={setNodeRef}
            radius="lg"
            p={0}
            withBorder
            style={{
                flex: '0 0 280px',
                minWidth: 260,
                maxWidth: 300,
                display: 'flex',
                flexDirection: 'column',
                maxHeight: '100%',
                transition: 'border-color 150ms ease, background-color 150ms ease',
                borderColor: isOver ? `var(--mantine-color-${color}-4)` : undefined,
                backgroundColor: isOver ? `var(--mantine-color-${color}-light)` : undefined,
            }}
        >
            {/* Column Header */}
            <Box
                px="sm"
                py="xs"
                style={{
                    borderBottom: '1px solid var(--mantine-color-default-border)',
                    background: `var(--mantine-color-${color}-light)`,
                    borderRadius: 'var(--mantine-radius-lg) var(--mantine-radius-lg) 0 0',
                }}
            >
                <Group justify="space-between" wrap="nowrap">
                    <Text size="xs" fw={700} tt="uppercase" style={{ letterSpacing: '0.5px' }}>
                        {getStageLabel(stage)}
                    </Text>
                    <Badge size="sm" variant="light" color={color} style={{ minWidth: 22, paddingInline: 6 }}>
                        {deals.length}
                    </Badge>
                </Group>
            </Box>

            {/* Cards */}
            <ScrollArea.Autosize mah="calc(100vh - 240px)" offsetScrollbars type="auto">
                <Stack gap="xs" p="xs">
                    {deals.length === 0 ? (
                        <Center py="xl">
                            <Text size="xs" c="dimmed">{t('dealPipeline.empty')}</Text>
                        </Center>
                    ) : (
                        deals.map((deal) => (
                            <DealCard key={deal.id} deal={deal} isDragEnabled={isDragEnabled} />
                        ))
                    )}
                </Stack>
            </ScrollArea.Autosize>
        </Paper>
    );
}

export default function DealKanbanBoard({ columns, isDragEnabled, onStageChange }: DealKanbanBoardProps) {
    const { pipelineStageSlugs } = useStages();
    const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
    const [overColumnId, setOverColumnId] = useState<string | null>(null);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
    );

    const handleDragStart = useCallback((event: DragStartEvent) => {
        const deal = event.active.data.current?.deal as Deal | undefined;
        if (deal) setActiveDeal(deal);
    }, []);

    const handleDragOver = useCallback((event: { over: { id: string | number } | null }) => {
        if (!event.over) {
            setOverColumnId(null);
            return;
        }
        setOverColumnId(resolveTargetStage(String(event.over.id), columns, pipelineStageSlugs));
    }, [columns, pipelineStageSlugs]);

    const handleDragEnd = useCallback(
        (event: DragEndEvent) => {
            setActiveDeal(null);
            setOverColumnId(null);

            const { active, over } = event;
            if (!over) return;

            const deal = active.data.current?.deal as Deal | undefined;
            if (!deal) return;

            const newStage = resolveTargetStage(String(over.id), columns, pipelineStageSlugs);
            if (newStage && newStage !== deal.stage) {
                onStageChange(deal.id, newStage, deal.stage);
            }
        },
        [onStageChange, columns, pipelineStageSlugs]
    );

    const handleDragCancel = useCallback(() => {
        setActiveDeal(null);
        setOverColumnId(null);
    }, []);

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
        >
            <Box
                style={{
                    display: 'flex',
                    gap: 12,
                    overflowX: 'auto',
                    paddingBottom: 8,
                    alignItems: 'flex-start',
                }}
            >
                {pipelineStageSlugs.map((stage) => (
                    <DealStageColumn
                        key={stage}
                        stage={stage}
                        deals={columns[stage] || []}
                        isDragEnabled={isDragEnabled}
                        isOver={overColumnId === stage}
                    />
                ))}
            </Box>

            {/* Drag overlay: floating card that follows cursor */}
            <DragOverlay dropAnimation={null}>
                {activeDeal ? (
                    <Paper shadow="lg" radius="md" p="sm" withBorder style={{ width: 270, opacity: 0.9 }}>
                        <Stack gap={4}>
                            <Text size="sm" fw={600} lineClamp={1}>{activeDeal.title}</Text>
                            {activeDeal.company_name && (
                                <Text size="xs" c="dimmed">{activeDeal.company_name}</Text>
                            )}
                        </Stack>
                    </Paper>
                ) : null}
            </DragOverlay>
        </DndContext>
    );
}
