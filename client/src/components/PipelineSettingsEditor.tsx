import { useState, useEffect } from 'react';
import {
    Stack,
    Group,
    Paper,
    Text,
    TextInput,
    ActionIcon,
    Button,
    ColorSwatch,
    Popover,
    SimpleGrid,
    Box,
    Loader,
    Center,
    Tooltip,
    Divider,
    Modal,
    Select,
} from '@mantine/core';
import {
    IconArrowRight,
    IconPlus,
    IconTrash,
    IconDeviceFloppy,
    IconArrowBack,
    IconEdit,
    IconGripVertical,
    IconBan,
} from '@tabler/icons-react';
import {
    DndContext,
    closestCenter,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import {
    type PipelineStageGroup,
    DEFAULT_PIPELINE_GROUPS,
    PIPELINE_GROUP_COLORS,
} from '../lib/pipelineConfig';
import { useStages, type StageDefinition } from '../contexts/StagesContext';
import DeactivateStageModal from './DeactivateStageModal';

export interface PipelineSettingsEditorHandle {
    save: () => void;
}

/** Sortable stage row — defined outside to prevent remounting on parent re-render */
function SortableStageRow({ slug, groupColor, stage, isEditing, label, editName, editColor, onEditNameChange, onEditColorChange, onSave, isSaving, onCancel, onStartEdit, onRemoveFromGroup, onDelete, onDeactivate }: {
    slug: string;
    groupColor: string;
    stage: StageDefinition;
    isEditing: boolean;
    label: string;
    editName: string;
    editColor: string;
    onEditNameChange: (v: string) => void;
    onEditColorChange: (v: string) => void;
    onSave: () => void;
    isSaving: boolean;
    onCancel: () => void;
    onStartEdit: () => void;
    onRemoveFromGroup: () => void;
    onDelete: () => void;
    onDeactivate: () => void;
}) {
    const { t } = useTranslation();
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: slug });

    return (
        <Group ref={setNodeRef} justify="space-between" wrap="nowrap" py={4} px="xs"
            style={{
                borderRadius: 6,
                background: `var(--mantine-color-${groupColor}-light)`,
                transform: CSS.Transform.toString(transform),
                transition,
                opacity: isDragging ? 0.5 : 1,
                zIndex: isDragging ? 1 : undefined,
            }}
        >
            <Group gap="xs" wrap="nowrap" style={{ flex: 1 }}>
                <Box {...attributes} {...listeners} style={{ cursor: 'grab', display: 'flex', alignItems: 'center' }}>
                    <IconGripVertical size={14} color="var(--mantine-color-dimmed)" />
                </Box>
                <ColorSwatch color={`var(--mantine-color-${stage.color}-6)`} size={14} />
                {isEditing ? (
                    <Group gap="xs" style={{ flex: 1 }}>
                        <TextInput value={editName} onChange={(e) => onEditNameChange(e.currentTarget.value)} size="xs" style={{ flex: 1 }} />
                        <ColorPickerPopover color={editColor} onChange={onEditColorChange} />
                        <Button size="compact-xs" onClick={onSave} loading={isSaving}>{t('common.save')}</Button>
                        <Button size="compact-xs" variant="subtle" color="gray" onClick={onCancel}>{t('common.cancel', 'İptal')}</Button>
                    </Group>
                ) : (
                    <Text size="sm" fw={500}>{label}</Text>
                )}
            </Group>
            {!isEditing && (
                <Group gap={2}>
                    <Tooltip label={t('common.edit', 'Düzenle')}>
                        <ActionIcon variant="subtle" color="gray" size="xs" onClick={onStartEdit}>
                            <IconEdit size={12} />
                        </ActionIcon>
                    </Tooltip>
                    <Tooltip label={t('pipelineSettings.removeFromGroup', 'Gruptan çıkar')}>
                        <ActionIcon variant="subtle" color="gray" size="xs" onClick={onRemoveFromGroup}>
                            <IconTrash size={12} />
                        </ActionIcon>
                    </Tooltip>
                    <Tooltip label={t('common.delete', 'Sil')}>
                        <ActionIcon variant="subtle" color="red" size="xs" onClick={onDelete}>
                            <IconTrash size={12} />
                        </ActionIcon>
                    </Tooltip>
                    <Tooltip label={t('pipelineSettings.deactivate', 'Devre Dışı Bırak')}>
                        <ActionIcon variant="subtle" color="orange" size="xs" onClick={onDeactivate}>
                            <IconBan size={12} />
                        </ActionIcon>
                    </Tooltip>
                </Group>
            )}
        </Group>
    );
}

export default function PipelineSettingsEditor({ onDirtyChange, saveRef, onSaveSuccess }: {
    onDirtyChange?: (dirty: boolean) => void;
    saveRef?: React.MutableRefObject<PipelineSettingsEditorHandle | null>;
    onSaveSuccess?: () => void;
}) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const { allStages, pipelineStageSlugs, getStageLabel, refetch } = useStages();

    const sortSensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    );

    // ─── Stage CRUD state ───
    const [editingSlug, setEditingSlug] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [editColor, setEditColor] = useState('gray');
    const [addingInGroup, setAddingInGroup] = useState<number | null>(null);
    const [newName, setNewName] = useState('');
    const [newColor, setNewColor] = useState('blue');
    const [deleteSlug, setDeleteSlug] = useState<string | null>(null);
    const [reassignTo, setReassignTo] = useState<string | null>(null);
    const [deleteCompanyCount, setDeleteCompanyCount] = useState(0);
    const [deactivateSlug, setDeactivateSlug] = useState<string | null>(null);
    const [deactivateStageName, setDeactivateStageName] = useState('');

    // ─── Group state ───
    const [groups, setGroups] = useState<PipelineStageGroup[]>([]);
    const [hasGroupChanges, setHasGroupChanges] = useState(false);

    const initialStages = allStages.filter((s) => s.stage_type === 'initial');
    const pipelineStages = allStages.filter((s) => s.stage_type === 'pipeline');
    const terminalStages = allStages.filter((s) => s.stage_type === 'terminal');
    const stageMap = new Map(allStages.map((s) => [s.slug, s]));

    // ─── Fetch groups ───
    const { data: groupData, isLoading: groupsLoading } = useQuery<PipelineStageGroup[]>({
        queryKey: ['settings', 'pipeline'],
        queryFn: async () => (await api.get('/settings/pipeline')).data.data,
    });

    useEffect(() => {
        if (groupData) { setGroups(groupData); setHasGroupChanges(false); }
    }, [groupData]);

    useEffect(() => {
        onDirtyChange?.(hasGroupChanges);
    }, [hasGroupChanges, onDirtyChange]);

    const invalidateAll = () => {
        queryClient.invalidateQueries({ queryKey: ['settings', 'stages'] });
        queryClient.invalidateQueries({ queryKey: ['settings', 'pipeline'] });
        queryClient.invalidateQueries({ queryKey: ['pipeline'] });
        queryClient.invalidateQueries({ queryKey: ['statistics'] });
        refetch();
    };

    // ─── Stage mutations ───
    const createMutation = useMutation({
        mutationFn: async (payload: { display_name: string; color: string; sort_order: number }) =>
            (await api.post('/settings/stages', { ...payload, stage_type: 'pipeline' })).data,
        onSuccess: (data) => {
            invalidateAll();
            // Auto-assign new stage to the group where it was created
            if (addingInGroup !== null && data?.data?.slug) {
                setGroups((prev) => prev.map((g, i) =>
                    i === addingInGroup ? { ...g, stages: [...g.stages, data.data.slug] } : g
                ));
                setHasGroupChanges(true);
            }
            setNewName(''); setNewColor('blue'); setAddingInGroup(null);
            showSuccess(t('pipelineSettings.stageCreated'));
        },
        onError: (err) => {
            showErrorFromApi(err, t('pipelineSettings.saveError'));
        },
    });

    const updateMutation = useMutation({
        mutationFn: async ({ slug, ...payload }: { slug: string; display_name?: string; color?: string }) =>
            (await api.put(`/settings/stages/${slug}`, payload)).data,
        onSuccess: () => {
            invalidateAll(); setEditingSlug(null);
            showSuccess(t('pipelineSettings.saved'));
        },
        onError: (err) => {
            showErrorFromApi(err, t('pipelineSettings.saveError'));
        },
    });

    const deleteMutation = useMutation({
        mutationFn: async ({ slug, reassign_to }: { slug: string; reassign_to?: string }) =>
            (await api.delete(`/settings/stages/${slug}`, { data: { reassign_to } })).data,
        onSuccess: (_data, vars) => {
            invalidateAll();
            // Also remove from groups
            setGroups((prev) => prev.map((g) => ({ ...g, stages: g.stages.filter((s) => s !== vars.slug) })));
            setHasGroupChanges(true);
            setDeleteSlug(null); setReassignTo(null); setDeleteCompanyCount(0);
            showSuccess(t('pipelineSettings.stageDeleted'));
        },
        onError: (err: any) => {
            const data = err?.response?.data;
            if (data?.company_count) { setDeleteCompanyCount(data.company_count); }
            else { showErrorFromApi(err, t('pipelineSettings.saveError')); }
        },
    });

    const reorderMutation = useMutation({
        mutationFn: async (order: string[]) => (await api.put('/settings/stages-reorder', { order })).data,
        onSuccess: () => { invalidateAll(); },
    });

    // ─── Group mutations ───
    const saveGroupsMutation = useMutation({
        mutationFn: async (updatedGroups: PipelineStageGroup[]) => {
            // Save group config
            await api.put('/settings/pipeline', { groups: updatedGroups });
            // Reorder stages globally based on group order
            const allSlugs = [
                ...initialStages.map((s) => s.slug),
                ...updatedGroups.flatMap((g) => g.stages),
                ...pipelineStageSlugs.filter((s) => !updatedGroups.some((g) => g.stages.includes(s))),
                ...terminalStages.map((s) => s.slug),
            ];
            await api.put('/settings/stages-reorder', { order: allSlugs });
        },
        onSuccess: () => {
            invalidateAll();
            setHasGroupChanges(false);
            showSuccess(t('pipelineSettings.saved'));
            onSaveSuccess?.();
        },
        onError: (err) => {
            showErrorFromApi(err, t('pipelineSettings.saveError'));
        },
    });

    // Expose save to parent
    if (saveRef) saveRef.current = { save: () => saveGroupsMutation.mutate(groups) };

    // ─── Stage actions ───
    const startEdit = (stage: StageDefinition) => {
        setEditingSlug(stage.slug); setEditName(stage.display_name); setEditColor(stage.color);
    };
    const saveEdit = () => {
        if (!editingSlug) return;
        updateMutation.mutate({ slug: editingSlug, display_name: editName, color: editColor });
    };
    const handleDelete = (slug: string) => {
        setDeleteSlug(slug); setDeleteCompanyCount(0); setReassignTo(null);
        deleteMutation.mutate({ slug });
    };
    const confirmDeleteWithReassign = () => {
        if (!deleteSlug || !reassignTo) return;
        deleteMutation.mutate({ slug: deleteSlug, reassign_to: reassignTo });
    };

    const handleDeactivate = (stage: StageDefinition) => {
        setDeactivateSlug(stage.slug);
        setDeactivateStageName(getStageLabel(stage.slug));
    };

    const handleStageDragEnd = (groupIndex: number, event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;

        const group = groups[groupIndex];
        const oldIdx = group.stages.indexOf(String(active.id));
        const newIdx = group.stages.indexOf(String(over.id));
        if (oldIdx < 0 || newIdx < 0) return;

        const newStages = arrayMove(group.stages, oldIdx, newIdx);
        setGroups((prev) => prev.map((g, i) => i === groupIndex ? { ...g, stages: newStages } : g));
        setHasGroupChanges(true);

        // Also reorder globally
        const allSlugs = [
            ...initialStages.map((s) => s.slug),
            ...groups.flatMap((g, i) => i === groupIndex ? newStages : g.stages),
            ...pipelineStageSlugs.filter((s) => !groups.some((g) => g.stages.includes(s))),
            ...terminalStages.map((s) => s.slug),
        ];
        reorderMutation.mutate(allSlugs);
    };

    // ─── Group actions ───
    const assignedStages = groups.flatMap((g) => g.stages);
    const unassignedPipelineStages = pipelineStageSlugs.filter((s) => !assignedStages.includes(s));

    const updateGroup = (index: number, updates: Partial<PipelineStageGroup>) => {
        setGroups((prev) => prev.map((g, i) => (i === index ? { ...g, ...updates } : g)));
        setHasGroupChanges(true);
    };
    const removeStageFromGroup = (gi: number, stage: string) => {
        setGroups((prev) => prev.map((g, i) => i === gi ? { ...g, stages: g.stages.filter((s) => s !== stage) } : g));
        setHasGroupChanges(true);
    };
    const addStageToGroup = (gi: number, stage: string) => {
        setGroups((prev) => prev.map((g, i) => i === gi ? { ...g, stages: [...g.stages, stage] } : g));
        setHasGroupChanges(true);
    };
    const addGroup = () => {
        setGroups((prev) => [...prev, { id: `group_${Date.now()}`, label: '', color: 'gray', stages: [] }]);
        setHasGroupChanges(true);
    };
    const removeGroup = (index: number) => {
        setGroups((prev) => prev.filter((_, i) => i !== index));
        setHasGroupChanges(true);
    };
    const resetGroups = () => {
        setGroups(DEFAULT_PIPELINE_GROUPS.map((g) => ({ ...g })));
        setHasGroupChanges(true);
    };

    // SortableStageRow is defined outside the component (see above)

    // ─── Simple stage row (initial / terminal) ───
    const renderSimpleStageRow = (stage: StageDefinition) => {
        const isEditing = editingSlug === stage.slug;
        return (
            <Paper key={stage.slug} p="xs" radius="md" withBorder>
                <Group justify="space-between" wrap="nowrap">
                    <Group gap="xs" wrap="nowrap" style={{ flex: 1 }}>
                        <ColorSwatch color={`var(--mantine-color-${stage.color}-6)`} size={16} />
                        {isEditing ? (
                            <Group gap="xs" style={{ flex: 1 }}>
                                <TextInput value={editName} onChange={(e) => setEditName(e.currentTarget.value)} size="xs" style={{ flex: 1 }} />
                                <ColorPickerPopover color={editColor} onChange={setEditColor} />
                                <Button size="compact-xs" onClick={saveEdit} loading={updateMutation.isPending}>{t('common.save')}</Button>
                                <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setEditingSlug(null)}>{t('common.cancel', 'İptal')}</Button>
                            </Group>
                        ) : (
                            <Text size="sm" fw={500}>{getStageLabel(stage.slug)}</Text>
                        )}
                    </Group>
                    {!isEditing && (
                        <Tooltip label={t('common.edit', 'Düzenle')}>
                            <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => startEdit(stage)}>
                                <IconEdit size={14} />
                            </ActionIcon>
                        </Tooltip>
                    )}
                </Group>
            </Paper>
        );
    };

    if (allStages.length === 0 || groupsLoading) {
        return <Center py="xl"><Loader size="sm" color="violet" /></Center>;
    }

    return (
        <Stack gap="lg">
            {/* ═══ Flow Preview ═══ */}
            <Paper p="md" radius="md" withBorder>
                <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="sm" style={{ letterSpacing: '0.5px' }}>
                    {t('pipelineSettings.flowPreview')}
                </Text>
                <Box style={{ display: 'flex', alignItems: 'center', gap: 4, overflowX: 'auto', paddingBottom: 4 }}>
                    {groups.map((group, index) => (
                        <Box key={group.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <Paper p="sm" radius="md" style={{
                                background: `var(--mantine-color-${group.color}-light)`,
                                border: `2px solid var(--mantine-color-${group.color}-4)`,
                                minWidth: 120, textAlign: 'center',
                            }}>
                                <Text size="xs" fw={700} c={`${group.color}.7`}>
                                    {group.label ? t(`stageGroups.${group.label}`, group.label) : `${t('pipelineSettings.phase')} ${index + 1}`}
                                </Text>
                                <Text size="xs" c="dimmed" mt={2}>
                                    {group.stages.length} {t('pipelineSettings.stagesCount')}
                                </Text>
                            </Paper>
                            {index < groups.length - 1 && <IconArrowRight size={18} color="var(--mantine-color-dimmed)" />}
                        </Box>
                    ))}
                    {groups.length === 0 && <Text size="sm" c="dimmed" py="md">{t('pipelineSettings.noGroups')}</Text>}
                </Box>
            </Paper>

            {/* ═══ Initial Stage ═══ */}
            {initialStages.length > 0 && (
                <>
                    <Text size="xs" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.5px' }}>
                        {t('pipelineSettings.initialStage')}
                    </Text>
                    {initialStages.map((s) => renderSimpleStageRow(s))}
                </>
            )}

            <Divider />

            {/* ═══ Groups with inline stages ═══ */}
            <Text size="xs" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.5px' }}>
                {t('pipelineSettings.editGroups')}
            </Text>

            {groups.map((group, gi) => (
                <Paper key={group.id} p="md" radius="md" withBorder>
                    {/* Group name + color + delete */}
                    <Group gap="sm" mb="md" align="flex-end">
                        <TextInput label={t('pipelineSettings.stageName')} placeholder={t('pipelineSettings.groupNamePlaceholder')}
                            value={group.label ? t(`stageGroups.${group.label}`, group.label) : ''}
                            onChange={(e) => updateGroup(gi, { label: e.currentTarget.value })} size="sm" style={{ flex: 1 }} />
                        <ColorPickerPopover color={group.color} onChange={(color) => updateGroup(gi, { color })} />
                        <Tooltip label={t('pipelineSettings.removeGroup')}>
                            <ActionIcon variant="subtle" color="red" size="lg" onClick={() => removeGroup(gi)} disabled={groups.length <= 1}>
                                <IconTrash size={14} />
                            </ActionIcon>
                        </Tooltip>
                    </Group>

                    {/* Inline stages */}
                    <Text size="xs" c="dimmed" mb={6}>{t('pipelineSettings.assignedStages')}</Text>
                    <DndContext
                        sensors={sortSensors}
                        collisionDetection={closestCenter}
                        onDragEnd={(event) => handleStageDragEnd(gi, event)}
                    >
                        <SortableContext items={group.stages} strategy={verticalListSortingStrategy}>
                            <Stack gap={4} mb="sm">
                                {group.stages.length === 0 && (
                                    <Text size="xs" c="dimmed" fs="italic" py={4}>{t('pipelineSettings.noStagesAssigned')}</Text>
                                )}
                                {group.stages.map((slug) => {
                                    const stg = stageMap.get(slug);
                                    if (!stg) return null;
                                    return (
                                        <SortableStageRow
                                            key={slug}
                                            slug={slug}
                                            groupColor={group.color}
                                            stage={stg}
                                            isEditing={editingSlug === slug}
                                            label={getStageLabel(slug)}
                                            editName={editName}
                                            editColor={editColor}
                                            onEditNameChange={setEditName}
                                            onEditColorChange={setEditColor}
                                            onSave={saveEdit}
                                            isSaving={updateMutation.isPending}
                                            onCancel={() => setEditingSlug(null)}
                                            onStartEdit={() => startEdit(stg)}
                                            onRemoveFromGroup={() => removeStageFromGroup(gi, slug)}
                                            onDelete={() => handleDelete(slug)}
                                            onDeactivate={() => handleDeactivate(stg)}
                                        />
                                    );
                                })}
                            </Stack>
                        </SortableContext>
                    </DndContext>

                    {/* Add existing or create new stage */}
                    <Group gap="xs">
                        {unassignedPipelineStages.length > 0 && (
                            <Popover position="bottom-start" withArrow shadow="md">
                                <Popover.Target>
                                    <Button variant="light" size="xs" leftSection={<IconPlus size={12} />} color={group.color}>
                                        {t('pipelineSettings.addStage')}
                                    </Button>
                                </Popover.Target>
                                <Popover.Dropdown p="xs">
                                    <Stack gap={4}>
                                        {unassignedPipelineStages.map((slug) => (
                                            <Button key={slug} variant="subtle" size="xs" justify="flex-start" onClick={() => addStageToGroup(gi, slug)}>
                                                {getStageLabel(slug)}
                                            </Button>
                                        ))}
                                    </Stack>
                                </Popover.Dropdown>
                            </Popover>
                        )}

                        {addingInGroup === gi ? (
                            <Group gap="xs">
                                <TextInput placeholder={t('pipelineSettings.newStageName')} value={newName}
                                    onChange={(e) => setNewName(e.currentTarget.value)} size="xs" style={{ width: 160 }} />
                                <ColorPickerPopover color={newColor} onChange={setNewColor} />
                                <Button size="compact-xs"
                                    onClick={() => createMutation.mutate({ display_name: newName, color: newColor, sort_order: pipelineStages.length + 1 })}
                                    loading={createMutation.isPending} disabled={!newName.trim()}>{t('common.save')}</Button>
                                <Button size="compact-xs" variant="subtle" color="gray"
                                    onClick={() => setAddingInGroup(null)}>{t('common.cancel', 'İptal')}</Button>
                            </Group>
                        ) : (
                            <Button variant="subtle" size="xs" color="gray" leftSection={<IconPlus size={12} />}
                                onClick={() => { setAddingInGroup(gi); setNewName(''); setNewColor(group.color); }}>
                                {t('pipelineSettings.addNewStage')}
                            </Button>
                        )}
                    </Group>
                </Paper>
            ))}

            <Button variant="light" color="gray" leftSection={<IconPlus size={14} />} onClick={addGroup} size="sm">
                {t('pipelineSettings.addGroup')}
            </Button>

            <Divider />

            {/* ═══ Terminal Stages ═══ */}
            <Text size="xs" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.5px' }}>
                {t('pipelineSettings.terminalStages')}
            </Text>
            {terminalStages.map((s) => renderSimpleStageRow(s))}

            <Divider />

            {/* ═══ Actions ═══ */}
            <Group justify="space-between">
                <Button variant="subtle" color="gray" size="sm" leftSection={<IconArrowBack size={14} />} onClick={resetGroups}>
                    {t('pipelineSettings.resetDefault')}
                </Button>
                <Button leftSection={<IconDeviceFloppy size={16} />} onClick={() => saveGroupsMutation.mutate(groups)}
                    loading={saveGroupsMutation.isPending} disabled={!hasGroupChanges} size="sm">
                    {t('common.save')}
                </Button>
            </Group>

            {/* ═══ Delete Modal ═══ */}
            <Modal opened={deleteCompanyCount > 0 && deleteSlug !== null}
                onClose={() => { setDeleteSlug(null); setDeleteCompanyCount(0); }}
                title={t('pipelineSettings.deleteStageTitle')} size="sm">
                <Stack gap="md">
                    <Text size="sm">{t('pipelineSettings.deleteStageDesc', { count: deleteCompanyCount })}</Text>
                    <Select label={t('pipelineSettings.reassignTo')}
                        data={allStages.filter((s) => s.slug !== deleteSlug).map((s) => ({ value: s.slug, label: getStageLabel(s.slug) }))}
                        value={reassignTo} onChange={setReassignTo} size="sm" />
                    <Group justify="flex-end">
                        <Button variant="subtle" color="gray" onClick={() => { setDeleteSlug(null); setDeleteCompanyCount(0); }}>
                            {t('common.cancel', 'İptal')}
                        </Button>
                        <Button color="red" onClick={confirmDeleteWithReassign} disabled={!reassignTo} loading={deleteMutation.isPending}>
                            {t('pipelineSettings.deleteAndMove')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            {/* ═══ Deactivate Modal ═══ */}
            <DeactivateStageModal
                stageSlug={deactivateSlug}
                stageName={deactivateStageName}
                onClose={() => setDeactivateSlug(null)}
                onSuccess={() => {
                    setDeactivateSlug(null);
                    invalidateAll();
                }}
            />
        </Stack>
    );
}

// ─── Shared ───

function ColorPickerPopover({ color, onChange }: { color: string; onChange: (color: string) => void }) {
    return (
        <Popover position="bottom" withArrow shadow="md">
            <Popover.Target>
                <ActionIcon variant="light" color={color} size="lg" radius="md">
                    <ColorSwatch color={`var(--mantine-color-${color}-6)`} size={18} />
                </ActionIcon>
            </Popover.Target>
            <Popover.Dropdown p="xs">
                <SimpleGrid cols={4} spacing={6}>
                    {PIPELINE_GROUP_COLORS.map((c) => (
                        <ActionIcon key={c} variant={c === color ? 'filled' : 'subtle'} color={c} size="md" onClick={() => onChange(c)}>
                            <ColorSwatch color={`var(--mantine-color-${c}-6)`} size={14} />
                        </ActionIcon>
                    ))}
                </SimpleGrid>
            </Popover.Dropdown>
        </Popover>
    );
}
