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
    Drawer,
    Tooltip,
    Modal,
    Button,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    IconSearch,
    IconX,
    IconLayoutKanban,
    IconTable,
    IconColumns,
    IconTrophy,
    IconXboxX,
    IconClock,
    IconUsers,
    IconSettings,
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
import PipelineSettingsEditor, { type PipelineSettingsEditorHandle } from '../components/PipelineSettingsEditor';

interface PipelineData {
    columns: Record<string, PipelineCompany[]>;
    terminalCounts: Record<string, number>;
}

export default function PipelinePage() {
    const { t } = useTranslation();
    const { user } = useAuth();
    const { pipelineStageSlugs, getStageColor } = useStages();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const focusStage = searchParams.get('focus');
    const role = user?.role || '';
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 300);
    const [viewMode, setViewMode] = useState<string>('board');
    const [settingsOpened, { open: openSettings, close: closeSettings }] = useDisclosure(false);
    const [confirmCloseOpened, setConfirmCloseOpened] = useState(false);
    const settingsDirtyRef = useRef(false);
    const settingsSaveRef = useRef<PipelineSettingsEditorHandle | null>(null);

    const handleSettingsClose = useCallback(() => {
        if (settingsDirtyRef.current) {
            setConfirmCloseOpened(true);
        } else {
            closeSettings();
        }
    }, [closeSettings]);

    const handleConfirmDiscard = useCallback(() => {
        setConfirmCloseOpened(false);
        settingsDirtyRef.current = false;
        closeSettings();
    }, [closeSettings]);

    const handleConfirmSave = useCallback(() => {
        settingsSaveRef.current?.save();
        setConfirmCloseOpened(false);
    }, []);

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
            await queryClient.cancelQueries({ queryKey: ['pipeline'] });
            const previous = queryClient.getQueryData<PipelineData>(['pipeline', debouncedSearch]);

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

                queryClient.setQueryData(['pipeline', debouncedSearch], updated);
            }

            return { previous };
        },
        onError: (_err, _vars, context) => {
            // Rollback on error
            if (context?.previous) {
                queryClient.setQueryData(['pipeline', debouncedSearch], context.previous);
            }
            notifications.show({
                title: t('common.error'),
                message: t('pipeline.moveError'),
                color: 'red',
            });
        },
        onSuccess: () => {
            notifications.show({
                message: t('pipeline.stageMoved'),
                color: 'green',
            });
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['pipeline'] });
            queryClient.invalidateQueries({ queryKey: ['companies'] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
        },
    });

    const handleStageChange = useCallback(
        (companyId: string, newStage: string, _oldStage: string) => {
            stageMutation.mutate({ companyId, newStage });
        },
        [stageMutation]
    );

    // Flatten all companies for table view
    const allCompanies = useMemo(
        () => (data ? pipelineStageSlugs.flatMap((stage) => data.columns[stage] || []) : []),
        [data]
    );

    const totalActive = allCompanies.length;
    const terminalCounts = data?.terminalCounts || {};

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
                        <Title order={2} fw={700}>
                            {t('nav.pipeline')}
                        </Title>
                        <Badge size="lg" variant="light" color="violet">{totalActive}</Badge>
                    </Group>

                    <Group gap="sm">
                        <TextInput
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
                            ]}
                        />
                        <Tooltip label={t('settings.pipelineTab')}>
                            <ActionIcon variant="light" color="gray" size="lg" radius="md" onClick={openSettings}>
                                <IconSettings size={18} />
                            </ActionIcon>
                        </Tooltip>
                    </Group>
                </Flex>

                {/* Terminal stage summary */}
                {(terminalCounts.won > 0 || terminalCounts.lost > 0 || terminalCounts.on_hold > 0) && (
                    <Group gap="xs" mb="md">
                        {terminalCounts.won > 0 && (
                            <Badge size="md" variant="light" color="green" leftSection={<IconTrophy size={12} />}>
                                {t('stages.won')}: {terminalCounts.won}
                            </Badge>
                        )}
                        {terminalCounts.lost > 0 && (
                            <Badge size="md" variant="light" color="red" leftSection={<IconXboxX size={12} />}>
                                {t('stages.lost')}: {terminalCounts.lost}
                            </Badge>
                        )}
                        {terminalCounts.on_hold > 0 && (
                            <Badge size="md" variant="light" color="gray" leftSection={<IconClock size={12} />}>
                                {t('stages.on_hold')}: {terminalCounts.on_hold}
                            </Badge>
                        )}
                    </Group>
                )}

                {/* Loading */}
                {isLoading && (
                    <Center py={120}>
                        <Loader size="lg" color="violet" />
                    </Center>
                )}

                {/* Error */}
                {error && (
                    <Center py={80}>
                        <Text c="red">{t('common.error')}</Text>
                    </Center>
                )}

                {/* Board View */}
                {!isLoading && !error && data && viewMode === 'board' && (
                    <KanbanBoard
                        columns={data.columns}
                        isDragEnabled={canDrag}
                        onStageChange={handleStageChange}
                        initialFocusStage={focusStage}
                    />
                )}

                {/* Table View */}
                {!isLoading && !error && data && viewMode === 'table' && (
                    <Paper shadow="sm" radius="lg" withBorder style={{ overflow: 'hidden' }}>
                        {allCompanies.length === 0 ? (
                            <Center py={80}>
                                <Stack align="center" gap="sm">
                                    <IconColumns size={48} color="#ccc" />
                                    <Text fw={500} c="dimmed">{t('pipeline.noData')}</Text>
                                </Stack>
                            </Center>
                        ) : (
                            <Table.ScrollContainer minWidth={600}>
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
                                            <Table.Th>{t('company.name')}</Table.Th>
                                            <Table.Th>{t('company.stage')}</Table.Th>
                                            <Table.Th>{t('company.industry')}</Table.Th>
                                            <Table.Th>{t('company.nextStep')}</Table.Th>
                                            <Table.Th>{t('pipeline.daysInStage')}</Table.Th>
                                            <Table.Th>{t('company.updatedAt')}</Table.Th>
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
                                                        <Text size="sm" lineClamp={1}>{company.next_step || '—'}</Text>
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
            </Container>

            <Drawer
                opened={settingsOpened}
                onClose={handleSettingsClose}
                title={t('settings.pipelineTab')}
                position="right"
                size="lg"
                padding="md"
            >
                <PipelineSettingsEditor
                    onDirtyChange={(dirty) => { settingsDirtyRef.current = dirty; }}
                    saveRef={settingsSaveRef}
                    onSaveSuccess={() => { settingsDirtyRef.current = false; closeSettings(); }}
                />
            </Drawer>

            <Modal
                opened={confirmCloseOpened}
                onClose={() => setConfirmCloseOpened(false)}
                title={t('pipelineSettings.unsavedTitle')}
                size="sm"
                centered
            >
                <Text size="sm" mb="lg">{t('pipelineSettings.unsavedDesc')}</Text>
                <Group justify="flex-end">
                    <Button variant="subtle" color="gray" onClick={handleConfirmDiscard}>
                        {t('pipelineSettings.discard')}
                    </Button>
                    <Button onClick={handleConfirmSave}>
                        {t('common.save')}
                    </Button>
                </Group>
            </Modal>
        </TierGate>
    );
}
