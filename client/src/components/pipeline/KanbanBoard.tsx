import { useState, useCallback } from 'react';
import {
    Box,
    Paper,
    Text,
    Badge,
    Stack,
    ScrollArea,
    Group,
    Center,
    Loader,
} from '@mantine/core';
import { useTranslation } from 'react-i18next';
import {
    DndContext,
    DragOverlay,
    useDroppable,
    closestCorners,
    PointerSensor,
    useSensor,
    useSensors,
    type DragStartEvent,
    type DragEndEvent,
} from '@dnd-kit/core';
import { PIPELINE_STAGES, getStageColor } from '../../lib/stages';
import PipelineCard, { type PipelineCompany } from './PipelineCard';

interface KanbanBoardProps {
    columns: Record<string, PipelineCompany[]>;
    isDragEnabled: boolean;
    onStageChange: (companyId: string, newStage: string, oldStage: string) => void;
}

/** A single droppable column */
function StageColumn({
    stage,
    companies,
    isDragEnabled,
    isOver,
}: {
    stage: string;
    companies: PipelineCompany[];
    isDragEnabled: boolean;
    isOver: boolean;
}) {
    const { t } = useTranslation();
    const { setNodeRef } = useDroppable({ id: stage });
    const color = getStageColor(stage);

    return (
        <Paper
            ref={setNodeRef}
            radius="lg"
            p={0}
            withBorder
            style={{
                minWidth: 260,
                maxWidth: 300,
                flex: '0 0 280px',
                display: 'flex',
                flexDirection: 'column',
                maxHeight: '100%',
                transition: 'border-color 150ms ease, background-color 150ms ease',
                borderColor: isOver ? `var(--mantine-color-${color}-4)` : undefined,
                backgroundColor: isOver ? `var(--mantine-color-${color}-0)` : undefined,
            }}
        >
            {/* Column Header */}
            <Box
                px="sm"
                py="xs"
                style={{
                    borderBottom: '1px solid var(--mantine-color-default-border)',
                    background: `var(--mantine-color-${color}-0)`,
                    borderRadius: 'var(--mantine-radius-lg) var(--mantine-radius-lg) 0 0',
                }}
            >
                <Group justify="space-between" wrap="nowrap">
                    <Text size="xs" fw={700} tt="uppercase" style={{ letterSpacing: '0.5px' }}>
                        {t(`stages.${stage}`)}
                    </Text>
                    <Badge size="sm" variant="light" color={color} circle>
                        {companies.length}
                    </Badge>
                </Group>
            </Box>

            {/* Cards */}
            <ScrollArea.Autosize mah="calc(100vh - 280px)" offsetScrollbars type="auto">
                <Stack gap="xs" p="xs">
                    {companies.length === 0 ? (
                        <Center py="xl">
                            <Text size="xs" c="dimmed">{t('pipeline.emptyColumn')}</Text>
                        </Center>
                    ) : (
                        companies.map((company) => (
                            <PipelineCard
                                key={company.id}
                                company={company}
                                isDragEnabled={isDragEnabled}
                            />
                        ))
                    )}
                </Stack>
            </ScrollArea.Autosize>
        </Paper>
    );
}

export default function KanbanBoard({
    columns,
    isDragEnabled,
    onStageChange,
}: KanbanBoardProps) {
    const [activeCompany, setActiveCompany] = useState<PipelineCompany | null>(null);
    const [overColumnId, setOverColumnId] = useState<string | null>(null);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
    );

    const handleDragStart = useCallback((event: DragStartEvent) => {
        const company = event.active.data.current?.company as PipelineCompany | undefined;
        if (company) setActiveCompany(company);
    }, []);

    const handleDragOver = useCallback((event: { over: { id: string | number } | null }) => {
        setOverColumnId(event.over ? String(event.over.id) : null);
    }, []);

    const handleDragEnd = useCallback(
        (event: DragEndEvent) => {
            setActiveCompany(null);
            setOverColumnId(null);

            const { active, over } = event;
            if (!over) return;

            const company = active.data.current?.company as PipelineCompany | undefined;
            if (!company) return;

            const newStage = String(over.id);
            if (newStage !== company.stage && PIPELINE_STAGES.includes(newStage as any)) {
                onStageChange(company.id, newStage, company.stage);
            }
        },
        [onStageChange]
    );

    const handleDragCancel = useCallback(() => {
        setActiveCompany(null);
        setOverColumnId(null);
    }, []);

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
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
                {PIPELINE_STAGES.map((stage) => (
                    <StageColumn
                        key={stage}
                        stage={stage}
                        companies={columns[stage] || []}
                        isDragEnabled={isDragEnabled}
                        isOver={overColumnId === stage}
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
