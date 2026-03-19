import { useState, useEffect } from 'react';
import {
    Stack,
    Group,
    Paper,
    Text,
    TextInput,
    Badge,
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
} from '@mantine/core';
import {
    IconArrowRight,
    IconPlus,
    IconTrash,
    IconGripVertical,
    IconDeviceFloppy,
    IconArrowBack,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../lib/api';
import {
    type PipelineStageGroup,
    DEFAULT_PIPELINE_GROUPS,
    PIPELINE_GROUP_COLORS,
    ASSIGNABLE_STAGES,
} from '../lib/pipelineConfig';

export default function PipelineSettingsEditor() {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const [groups, setGroups] = useState<PipelineStageGroup[]>([]);
    const [hasChanges, setHasChanges] = useState(false);

    // Fetch current pipeline config
    const { data, isLoading } = useQuery<PipelineStageGroup[]>({
        queryKey: ['settings', 'pipeline'],
        queryFn: async () => (await api.get('/settings/pipeline')).data.data,
    });

    useEffect(() => {
        if (data) {
            setGroups(data);
            setHasChanges(false);
        }
    }, [data]);

    // Save mutation
    const saveMutation = useMutation({
        mutationFn: async (updatedGroups: PipelineStageGroup[]) => {
            return (await api.put('/settings/pipeline', { groups: updatedGroups })).data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['settings', 'pipeline'] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            setHasChanges(false);
            notifications.show({
                title: t('pipelineSettings.saved'),
                message: t('pipelineSettings.savedDesc'),
                color: 'green',
            });
        },
        onError: () => {
            notifications.show({
                title: t('common.error'),
                message: t('pipelineSettings.saveError'),
                color: 'red',
            });
        },
    });

    // Collect stages already assigned to a group
    const assignedStages = groups.flatMap((g) => g.stages);
    const unassignedStages = ASSIGNABLE_STAGES.filter((s) => !assignedStages.includes(s));

    const updateGroup = (index: number, updates: Partial<PipelineStageGroup>) => {
        setGroups((prev) => prev.map((g, i) => (i === index ? { ...g, ...updates } : g)));
        setHasChanges(true);
    };

    const removeStageFromGroup = (groupIndex: number, stage: string) => {
        setGroups((prev) =>
            prev.map((g, i) =>
                i === groupIndex ? { ...g, stages: g.stages.filter((s) => s !== stage) } : g
            )
        );
        setHasChanges(true);
    };

    const addStageToGroup = (groupIndex: number, stage: string) => {
        setGroups((prev) =>
            prev.map((g, i) =>
                i === groupIndex ? { ...g, stages: [...g.stages, stage] } : g
            )
        );
        setHasChanges(true);
    };

    const addGroup = () => {
        const newId = `group_${Date.now()}`;
        setGroups((prev) => [
            ...prev,
            { id: newId, label: '', color: 'gray', stages: [] },
        ]);
        setHasChanges(true);
    };

    const removeGroup = (index: number) => {
        setGroups((prev) => prev.filter((_, i) => i !== index));
        setHasChanges(true);
    };

    const resetToDefault = () => {
        setGroups(DEFAULT_PIPELINE_GROUPS.map((g) => ({ ...g })));
        setHasChanges(true);
    };

    if (isLoading) {
        return (
            <Center py="xl">
                <Loader size="sm" color="violet" />
            </Center>
        );
    }

    return (
        <Stack gap="md">
            {/* 4-Step Flow Visualization */}
            <Paper p="md" radius="md" withBorder>
                <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="sm" style={{ letterSpacing: '0.5px' }}>
                    {t('pipelineSettings.flowPreview')}
                </Text>
                <Box
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        overflowX: 'auto',
                        paddingBottom: 4,
                    }}
                >
                    {groups.map((group, index) => (
                        <Box key={group.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <Paper
                                p="sm"
                                radius="md"
                                style={{
                                    background: `var(--mantine-color-${group.color}-light)`,
                                    border: `2px solid var(--mantine-color-${group.color}-4)`,
                                    minWidth: 120,
                                    textAlign: 'center',
                                }}
                            >
                                <Text size="xs" fw={700} c={`${group.color}.7`}>
                                    {group.label
                                        ? t(`stageGroups.${group.label}`, group.label)
                                        : `${t('pipelineSettings.phase')} ${index + 1}`}
                                </Text>
                                <Text size="xs" c="dimmed" mt={2}>
                                    {group.stages.length} {t('pipelineSettings.stagesCount')}
                                </Text>
                            </Paper>
                            {index < groups.length - 1 && (
                                <IconArrowRight size={18} color="var(--mantine-color-dimmed)" />
                            )}
                        </Box>
                    ))}
                    {groups.length === 0 && (
                        <Text size="sm" c="dimmed" py="md">
                            {t('pipelineSettings.noGroups')}
                        </Text>
                    )}
                </Box>
            </Paper>

            <Divider />

            {/* Group Editor */}
            <Text size="xs" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.5px' }}>
                {t('pipelineSettings.editGroups')}
            </Text>

            {groups.map((group, index) => (
                <Paper key={group.id} p="md" radius="md" withBorder>
                    <Group justify="space-between" mb="sm">
                        <Group gap="xs">
                            <IconGripVertical size={16} color="var(--mantine-color-dimmed)" />
                            <Text size="sm" fw={600}>
                                {t('pipelineSettings.phase')} {index + 1}
                            </Text>
                        </Group>
                        <Tooltip label={t('pipelineSettings.removeGroup')}>
                            <ActionIcon
                                variant="subtle"
                                color="red"
                                size="sm"
                                onClick={() => removeGroup(index)}
                                disabled={groups.length <= 1}
                            >
                                <IconTrash size={14} />
                            </ActionIcon>
                        </Tooltip>
                    </Group>

                    <Group gap="sm" mb="sm" align="flex-end">
                        <TextInput
                            label={t('pipelineSettings.groupName')}
                            placeholder={t('pipelineSettings.groupNamePlaceholder')}
                            value={group.label ? t(`stageGroups.${group.label}`, group.label) : ''}
                            onChange={(e) => updateGroup(index, { label: e.currentTarget.value })}
                            size="sm"
                            style={{ flex: 1 }}
                        />
                        <ColorPickerPopover
                            color={group.color}
                            onChange={(color) => updateGroup(index, { color })}
                        />
                    </Group>

                    {/* Assigned stages */}
                    <Text size="xs" c="dimmed" mb={4}>
                        {t('pipelineSettings.assignedStages')}
                    </Text>
                    <Group gap={6} mb="sm">
                        {group.stages.map((stage) => (
                            <Badge
                                key={stage}
                                variant="light"
                                color={group.color}
                                size="md"
                                rightSection={
                                    <ActionIcon
                                        variant="transparent"
                                        size="xs"
                                        color={group.color}
                                        onClick={() => removeStageFromGroup(index, stage)}
                                    >
                                        <IconTrash size={10} />
                                    </ActionIcon>
                                }
                            >
                                {t(`stages.${stage}`)}
                            </Badge>
                        ))}
                        {group.stages.length === 0 && (
                            <Text size="xs" c="dimmed" fs="italic">
                                {t('pipelineSettings.noStagesAssigned')}
                            </Text>
                        )}
                    </Group>

                    {/* Add stage dropdown */}
                    {unassignedStages.length > 0 && (
                        <Popover position="bottom-start" withArrow shadow="md">
                            <Popover.Target>
                                <Button
                                    variant="light"
                                    size="xs"
                                    leftSection={<IconPlus size={12} />}
                                    color={group.color}
                                >
                                    {t('pipelineSettings.addStage')}
                                </Button>
                            </Popover.Target>
                            <Popover.Dropdown p="xs">
                                <Stack gap={4}>
                                    {unassignedStages.map((stage) => (
                                        <Button
                                            key={stage}
                                            variant="subtle"
                                            size="xs"
                                            justify="flex-start"
                                            onClick={() => addStageToGroup(index, stage)}
                                        >
                                            {t(`stages.${stage}`)}
                                        </Button>
                                    ))}
                                </Stack>
                            </Popover.Dropdown>
                        </Popover>
                    )}
                </Paper>
            ))}

            {/* Add Group */}
            <Button
                variant="light"
                color="gray"
                leftSection={<IconPlus size={14} />}
                onClick={addGroup}
                size="sm"
            >
                {t('pipelineSettings.addGroup')}
            </Button>

            <Divider />

            {/* Actions */}
            <Group justify="space-between">
                <Button
                    variant="subtle"
                    color="gray"
                    size="sm"
                    leftSection={<IconArrowBack size={14} />}
                    onClick={resetToDefault}
                >
                    {t('pipelineSettings.resetDefault')}
                </Button>
                <Button
                    leftSection={<IconDeviceFloppy size={16} />}
                    onClick={() => saveMutation.mutate(groups)}
                    loading={saveMutation.isPending}
                    disabled={!hasChanges}
                    size="sm"
                >
                    {t('common.save')}
                </Button>
            </Group>
        </Stack>
    );
}

/** Small color picker popover */
function ColorPickerPopover({
    color,
    onChange,
}: {
    color: string;
    onChange: (color: string) => void;
}) {
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
                        <ActionIcon
                            key={c}
                            variant={c === color ? 'filled' : 'subtle'}
                            color={c}
                            size="md"
                            onClick={() => onChange(c)}
                        >
                            <ColorSwatch color={`var(--mantine-color-${c}-6)`} size={14} />
                        </ActionIcon>
                    ))}
                </SimpleGrid>
            </Popover.Dropdown>
        </Popover>
    );
}
