import { useState } from 'react';
import { Popover, Tooltip, ActionIcon, Text, Divider, Stack, Button, Group, Box, Checkbox } from '@mantine/core';
import { IconAdjustments, IconGripVertical } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
    DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ColumnDef } from '../../hooks/useColumnConfig';

function SortableColumnItem({ id, label, checked, onToggle }: {
    id: string;
    label: string;
    checked: boolean;
    onToggle: () => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
    return (
        <Group ref={setNodeRef} style={style} justify="space-between" wrap="nowrap">
            <Group gap="xs" wrap="nowrap" style={{ flex: 1 }}>
                <Box
                    {...attributes}
                    {...listeners}
                    style={{ cursor: 'grab', display: 'flex', alignItems: 'center', touchAction: 'none' }}
                >
                    <IconGripVertical size={14} color="gray" />
                </Box>
                <Checkbox checked={checked} onChange={onToggle} label={<Text size="sm">{label}</Text>} size="xs" />
            </Group>
        </Group>
    );
}

interface ColumnManagerPopoverProps<K extends string> {
    columns: ColumnDef<K>[];
    labels: Record<K, string>;
    onToggle: (key: K) => void;
    onReorder: (activeId: string, overId: string) => void;
    onReset: () => void;
}

/**
 * The column show/hide/reorder popover shared by the CRM list pages. Owns its own
 * open state and the drag sensors; the parent supplies the columns, their labels,
 * and the mutation callbacks (from useColumnConfig).
 */
export function ColumnManagerPopover<K extends string>({
    columns, labels, onToggle, onReorder, onReset,
}: ColumnManagerPopoverProps<K>) {
    const { t } = useTranslation();
    const [opened, setOpened] = useState(false);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (over && active.id !== over.id) onReorder(String(active.id), String(over.id));
    };

    return (
        <Popover opened={opened} onChange={setOpened} position="bottom-end" shadow="md" withArrow>
            <Popover.Target>
                <Tooltip label={t('leads.editColumns')} withArrow position="left">
                    <ActionIcon
                        variant="subtle"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); setOpened(o => !o); }}
                        style={{ color: 'rgba(255,255,255,0.6)' }}
                    >
                        <IconAdjustments size={16} />
                    </ActionIcon>
                </Tooltip>
            </Popover.Target>
            <Popover.Dropdown p="sm" style={{ minWidth: 240, maxHeight: 400, overflowY: 'auto' }}>
                <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="xs" style={{ letterSpacing: '0.5px' }}>
                    {t('leads.columns')}
                </Text>
                <Divider mb="xs" />
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <SortableContext items={columns.map(c => c.key)} strategy={verticalListSortingStrategy}>
                        <Stack gap={6}>
                            {columns.map((col) => (
                                <SortableColumnItem
                                    key={col.key}
                                    id={col.key}
                                    label={labels[col.key]}
                                    checked={col.visible}
                                    onToggle={() => onToggle(col.key)}
                                />
                            ))}
                        </Stack>
                    </SortableContext>
                </DndContext>
                <Divider mt="xs" mb="xs" />
                <Button size="xs" variant="subtle" color="gray" fullWidth onClick={onReset}>
                    {t('leads.resetColumns')}
                </Button>
            </Popover.Dropdown>
        </Popover>
    );
}
