import {
    Stack, Paper, Group, Text, Badge, ActionIcon, Button, Tooltip,
} from '@mantine/core';
import {
    IconMail, IconClock, IconGripVertical, IconTrash, IconPlus, IconAlertTriangle,
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
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { CampaignStep } from '../../types/campaign';

interface Props {
    steps: CampaignStep[];
    onChange: (steps: CampaignStep[]) => void;
    onSelectStep: (index: number) => void;
    selectedIndex: number | null;
    readOnly?: boolean;
}

// Wait-before modeli: her adımın delay'i "bu maili göndermeden önce bekle".
function waitLabel(t: TFunction, days: number, hours: number): string {
    if (!days && !hours) return t('campaign.editor.immediately', 'Immediately');
    const parts: string[] = [];
    if (days) parts.push(`${days}${t('campaign.editor.dayAbbr', 'd')}`);
    if (hours) parts.push(`${hours}${t('campaign.editor.hourAbbr', 'h')}`);
    return t('campaign.editor.waitAfterShort', { wait: parts.join(' '), defaultValue: '{{wait}} later' });
}

function SortableCard({
    step, index, isSelected, onSelect, onDelete, readOnly,
}: {
    step: CampaignStep; index: number; isSelected: boolean;
    onSelect: () => void; onDelete: () => void; readOnly?: boolean;
}) {
    const { t } = useTranslation();
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
        useSortable({ id: `step-${index}`, disabled: readOnly });

    const immediate = !step.delay_days && !step.delay_hours;
    const empty = !step.subject?.trim() || !step.body_html?.trim();

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
                <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                    {!readOnly && (
                        <ActionIcon variant="subtle" color="gray" size="sm" {...attributes} {...listeners} style={{ cursor: 'grab' }}>
                            <IconGripVertical size={14} />
                        </ActionIcon>
                    )}
                    <Badge size="sm" variant="light" color="indigo" leftSection={<IconMail size={12} />}>
                        {index + 1}
                    </Badge>
                    <div style={{ minWidth: 0 }}>
                        <Group gap={4} wrap="nowrap">
                            <IconClock size={11} color="var(--mantine-color-gray-5)" />
                            <Text size="xs" c={immediate ? 'teal.7' : 'dimmed'}>{waitLabel(t, step.delay_days || 0, step.delay_hours || 0)}</Text>
                        </Group>
                        <Group gap={4} wrap="nowrap">
                            <Text size="sm" fw={500} lineClamp={1}>
                                {step.subject || t('campaign.editor.untitledEmail', 'Untitled email')}
                            </Text>
                            {empty && (
                                <Tooltip label={t('campaign.editor.emptyStep', 'Subject or body is empty')} withArrow>
                                    <IconAlertTriangle size={13} color="var(--mantine-color-orange-6)" style={{ flexShrink: 0 }} />
                                </Tooltip>
                            )}
                        </Group>
                    </div>
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
    const { t } = useTranslation();
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

    // Yeni adım her zaman e-posta. İlk adım hemen (delay 0); sonrakiler varsayılan 2 gün bekler.
    const addStep = () => {
        const isFirst = steps.length === 0;
        const s: CampaignStep = {
            step_order: steps.length + 1, step_type: 'email',
            subject: '', body_html: '', body_text: null,
            delay_days: isFirst ? 0 : 2, delay_hours: 0,
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
                <Button variant="light" color="violet" size="xs" leftSection={<IconPlus size={14} />} fullWidth onClick={addStep}>
                    {t('campaign.editor.addEmailStep', 'Add email step')}
                </Button>
            )}
        </Stack>
    );
}
