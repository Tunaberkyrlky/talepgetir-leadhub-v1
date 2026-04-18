import {
    Stack, Paper, Group, Text, Badge, ActionIcon, Button, Menu,
} from '@mantine/core';
import {
    IconMail, IconClock, IconGripVertical, IconTrash, IconPlus,
} from '@tabler/icons-react';
import {
    DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
    sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CampaignStep } from '../../types/campaign';

interface Props {
    steps: CampaignStep[];
    onChange: (steps: CampaignStep[]) => void;
    onSelectStep: (index: number) => void;
    selectedIndex: number | null;
    readOnly?: boolean;
}

function SortableCard({
    step, index, isSelected, onSelect, onDelete, readOnly,
}: {
    step: CampaignStep; index: number; isSelected: boolean;
    onSelect: () => void; onDelete: () => void; readOnly?: boolean;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
        useSortable({ id: `step-${index}`, disabled: readOnly });

    const isEmail = step.step_type === 'email';

    return (
        <Paper
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
            p="sm" radius="md" withBorder shadow={isSelected ? 'sm' : undefined}
            onClick={onSelect}
            styles={{ root: {
                cursor: 'pointer',
                borderColor: isSelected ? 'var(--mantine-color-violet-5)' : undefined,
                borderWidth: isSelected ? 2 : 1,
            } }}
        >
            <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                    {!readOnly && (
                        <ActionIcon variant="subtle" color="gray" size="sm" {...attributes} {...listeners} style={{ cursor: 'grab' }}>
                            <IconGripVertical size={14} />
                        </ActionIcon>
                    )}
                    <Badge size="sm" variant="light" color={isEmail ? 'indigo' : 'orange'}
                        leftSection={isEmail ? <IconMail size={12} /> : <IconClock size={12} />}
                    >
                        {index + 1}
                    </Badge>
                    <Text size="sm" fw={500} lineClamp={1}>
                        {isEmail ? (step.subject || 'Untitled email') : `${step.delay_days || 0}d ${step.delay_hours || 0}h wait`}
                    </Text>
                </Group>
                {!readOnly && (
                    <ActionIcon variant="subtle" color="red" size="sm" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
                        <IconTrash size={14} />
                    </ActionIcon>
                )}
            </Group>
        </Paper>
    );
}

export default function SequenceTimeline({ steps, onChange, onSelectStep, selectedIndex, readOnly }: Props) {
    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const oldIdx = steps.findIndex((_, i) => `step-${i}` === active.id);
        const newIdx = steps.findIndex((_, i) => `step-${i}` === over.id);
        onChange(arrayMove(steps, oldIdx, newIdx).map((s, i) => ({ ...s, step_order: i + 1 })));
    };

    const addStep = (type: 'email' | 'delay') => {
        const s: CampaignStep = {
            step_order: steps.length + 1, step_type: type,
            subject: type === 'email' ? '' : null, body_html: type === 'email' ? '' : null,
            body_text: null, delay_days: type === 'delay' ? 1 : 0, delay_hours: 0,
        };
        onChange([...steps, s]);
        onSelectStep(steps.length);
    };

    const deleteStep = (i: number) => {
        const updated = steps.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, step_order: idx + 1 }));
        onChange(updated);
        if (selectedIndex === i) onSelectStep(Math.max(0, i - 1));
    };

    return (
        <Stack gap="xs">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={steps.map((_, i) => `step-${i}`)} strategy={verticalListSortingStrategy}>
                    {steps.map((step, i) => (
                        <SortableCard key={`step-${i}`} step={step} index={i}
                            isSelected={selectedIndex === i}
                            onSelect={() => onSelectStep(i)}
                            onDelete={() => deleteStep(i)}
                            readOnly={readOnly}
                        />
                    ))}
                </SortableContext>
            </DndContext>
            {!readOnly && (
                <Menu shadow="md" width={200}>
                    <Menu.Target>
                        <Button variant="light" color="violet" size="xs" leftSection={<IconPlus size={14} />} fullWidth>
                            Add Step
                        </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                        <Menu.Item leftSection={<IconMail size={14} />} onClick={() => addStep('email')}>Email Step</Menu.Item>
                        <Menu.Item leftSection={<IconClock size={14} />} onClick={() => addStep('delay')}>Delay Step</Menu.Item>
                    </Menu.Dropdown>
                </Menu>
            )}
        </Stack>
    );
}
