import {
    Stack, Paper, Group, Text, Badge, ActionIcon, Button, Tooltip,
} from '@mantine/core';
import {
    IconGripVertical, IconTrash, IconPlus, IconAlertTriangle,
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
import { newId } from '../../lib/graph';

interface Props {
    steps: CampaignStep[];
    onChange: (steps: CampaignStep[]) => void;
    onSelectStep: (index: number) => void;
    selectedIndex: number | null;
    readOnly?: boolean;
}

// Wait-before modeli: her adımın delay'i "bu maili göndermeden önce bekle".
function waitLabel(t: TFunction, days: number, hours: number): string {
    const parts: string[] = [];
    if (days) parts.push(`${days}${t('campaign.editor.dayAbbr', 'd')}`);
    if (hours) parts.push(`${hours}${t('campaign.editor.hourAbbr', 'h')}`);
    return t('campaign.editor.waitAfterShort', { wait: parts.join(' '), defaultValue: '{{wait}} later' });
}

function SortableCard({
    step, index, total, cumLabel, cumImmediate, isSelected, onSelect, onDelete, readOnly,
}: {
    step: CampaignStep; index: number; total: number; cumLabel: string; cumImmediate: boolean;
    isSelected: boolean; onSelect: () => void; onDelete: () => void; readOnly?: boolean;
}) {
    const { t } = useTranslation();
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
        useSortable({ id: `step-${index}`, disabled: readOnly });

    const hasWait = !!(step.delay_days || step.delay_hours);
    const empty = !step.subject?.trim() || !step.body_html?.trim();
    const isLast = index === total - 1;

    return (
        <Group
            ref={setNodeRef}
            gap="sm" wrap="nowrap" align="stretch"
            style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
        >
            {/* Rail — numaralı node + bağlayıcı çizgi */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 26 }}>
                <div style={{
                    width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                    background: cumImmediate ? 'var(--mantine-color-teal-6)' : 'var(--mantine-color-indigo-6)',
                    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 700,
                }}>{index + 1}</div>
                {!isLast && <div style={{ width: 2, flex: 1, minHeight: 14, marginTop: 2, background: 'var(--mantine-color-gray-3)' }} />}
            </div>

            {/* Adım kartı */}
            <Paper
                flex={1} p="sm" radius="md" withBorder mb="xs"
                shadow={isSelected ? 'sm' : undefined}
                onClick={onSelect}
                styles={{ root: {
                    cursor: 'pointer',
                    borderColor: isSelected ? 'var(--mantine-color-violet-5)' : undefined,
                    borderWidth: isSelected ? 2 : 1,
                } }}
            >
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                    <div style={{ minWidth: 0 }}>
                        <Group gap={6} wrap="nowrap">
                            <Badge size="xs" variant="light" color={cumImmediate ? 'teal' : 'indigo'}>{cumLabel}</Badge>
                            {hasWait && (
                                <Text size="xs" c="dimmed">{waitLabel(t, step.delay_days || 0, step.delay_hours || 0)}</Text>
                            )}
                        </Group>
                        <Group gap={4} wrap="nowrap" mt={3}>
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
                    {!readOnly && (
                        <Group gap={2} wrap="nowrap">
                            <ActionIcon variant="subtle" color="gray" size="sm" {...attributes} {...listeners} style={{ cursor: 'grab' }}>
                                <IconGripVertical size={14} />
                            </ActionIcon>
                            <ActionIcon variant="subtle" color="red" size="sm" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
                                <IconTrash size={14} />
                            </ActionIcon>
                        </Group>
                    )}
                </Group>
            </Paper>
        </Group>
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
        const moved = arrayMove(steps, oldIdx, newIdx); // orijinal ref'leri korur
        const selStep = selectedIndex !== null ? steps[selectedIndex] : null;
        onChange(moved.map((s, i) => ({ ...s, step_order: i + 1 })));
        // Seçili adımı yeni konumuna taşı ki StepEditor doğru içerikle kalsın.
        if (selStep) {
            const ni = moved.indexOf(selStep);
            if (ni !== -1 && ni !== selectedIndex) onSelectStep(ni);
        }
    };

    // Yeni adım her zaman e-posta. İlk adım hemen (delay 0); sonrakiler varsayılan 2 gün bekler.
    const addStep = () => {
        const isFirst = steps.length === 0;
        const s: CampaignStep = {
            id: newId(), // stabil id → {nodes} kaydında upsert (UUID churn yok)
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

    // Kümülatif gün — her adıma kadarki beklemelerin toplamı (gönderim "Gün N"de).
    // Render'da değişken mutasyonundan kaçınmak için saf hesap (adım sayısı küçük).
    const cumAt = (idx: number) => steps
        .slice(0, idx + 1)
        .reduce((a, s) => a + (s.delay_days || 0) + (s.delay_hours || 0) / 24, 0);

    return (
        <Stack gap={0}>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={steps.map((_, i) => `step-${i}`)} strategy={verticalListSortingStrategy}>
                    {steps.map((step, i) => {
                        const cumDays = cumAt(i);
                        const immediate = cumDays === 0;
                        const cumLabel = immediate
                            ? t('campaign.editor.immediately', 'Immediately')
                            : `${t('campaign.editor.day', 'Day')} ${Math.round(cumDays)}`;
                        return (
                            <SortableCard key={`step-${i}`} step={step} index={i} total={steps.length}
                                cumLabel={cumLabel} cumImmediate={immediate}
                                isSelected={selectedIndex === i}
                                onSelect={() => onSelectStep(i)}
                                onDelete={() => deleteStep(i)}
                                readOnly={readOnly}
                            />
                        );
                    })}
                </SortableContext>
            </DndContext>
            {!readOnly && (
                <Button variant="light" color="violet" size="xs" leftSection={<IconPlus size={14} />} fullWidth onClick={addStep} mt={steps.length ? 4 : 0}>
                    {t('campaign.editor.addEmailStep', 'Add email step')}
                </Button>
            )}
        </Stack>
    );
}
