// client/src/components/DeactivateStageModal.tsx
import { useState, useEffect } from 'react';
import {
    Modal, Stack, Text, Button, Group, Select,
    ScrollArea, Table, Tooltip, Loader, Center, Box,
} from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import { useStages } from '../contexts/StagesContext';

interface Props {
    stageSlug: string | null;       // null = closed
    stageName: string;
    onClose: () => void;
    onSuccess: () => void;
}

interface CompanyRow {
    id: string;
    name: string;
}

export default function DeactivateStageModal({ stageSlug, stageName, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const { allStages, initialStage, getStageLabel } = useStages();

    // Per-company target stage selection: { [companyId]: targetSlug | null }
    const [selections, setSelections] = useState<Record<string, string | null>>({});

    // Fetch companies in this stage when modal opens
    const { data, isLoading } = useQuery({
        queryKey: ['stage-companies', stageSlug],
        queryFn: async () => {
            const res = await api.get(`/settings/stages/${stageSlug}/companies`);
            return res.data as { stage: { id: string; slug: string; display_name: string }; companies: CompanyRow[] };
        },
        enabled: !!stageSlug,
    });

    // Reset selections when a new stage is loaded
    useEffect(() => {
        if (data?.companies) {
            const initial: Record<string, string | null> = {};
            data.companies.forEach((c) => { initial[c.id] = null; });
            setSelections(initial);
        }
    }, [data]);

    const companies = data?.companies || [];
    const pendingCount = Object.values(selections).filter((v) => v === null).length;
    const allAssigned = companies.length > 0 && pendingCount === 0;

    // Target stage options: active stages excluding the stage being deactivated
    const targetOptions = allStages
        .filter((s) => s.is_active && s.slug !== stageSlug)
        .map((s) => ({ value: s.slug, label: getStageLabel(s.slug) }));

    const moveAllToInitial = () => {
        if (!initialStage) return;
        const updated: Record<string, string | null> = {};
        companies.forEach((c) => { updated[c.id] = initialStage.slug; });
        setSelections(updated);
    };

    const deactivateMutation = useMutation({
        mutationFn: async () => {
            const migrations = Object.entries(selections)
                .filter(([, targetStage]) => targetStage !== null)
                .map(([companyId, targetStage]) => ({ companyId, targetStage: targetStage! }));
            await api.post(`/settings/stages/${stageSlug}/deactivate`, { migrations });
        },
        onSuccess: () => {
            showSuccess(t('pipelineSettings.stageDeactivated', 'Aşama devre dışı bırakıldı'));
            onSuccess();
        },
        onError: (err) => {
            showErrorFromApi(err, t('pipelineSettings.saveError'));
        },
    });

    if (!stageSlug) return null;

    return (
        <Modal
            opened={!!stageSlug}
            onClose={onClose}
            title={t('pipelineSettings.deactivateTitle', { name: stageName })}
            size="lg"
            closeOnClickOutside={!deactivateMutation.isPending}
            closeOnEscape={!deactivateMutation.isPending}
        >
            <Stack gap="md">
                {isLoading ? (
                    <Center py="xl"><Loader size="sm" /></Center>
                ) : companies.length === 0 ? (
                    <Text size="sm" c="dimmed">
                        {t('pipelineSettings.noCompaniesInStage', 'Bu aşamada şirket yok. Doğrudan devre dışı bırakılacak.')}
                    </Text>
                ) : (
                    <>
                        <Group justify="space-between" align="center">
                            <Text size="sm" c="dimmed">
                                {t('pipelineSettings.companiesInStage', { count: companies.length })}
                            </Text>
                            <Button
                                variant="light"
                                size="xs"
                                onClick={moveAllToInitial}
                                disabled={!initialStage}
                            >
                                {t('pipelineSettings.moveAllToInitial', { stage: initialStage ? getStageLabel(initialStage.slug) : '' })}
                            </Button>
                        </Group>

                        <ScrollArea.Autosize mah={340}>
                            <Table striped highlightOnHover>
                                <Table.Tbody>
                                    {companies.map((company) => (
                                        <Table.Tr key={company.id}>
                                            <Table.Td style={{ width: '50%' }}>
                                                <Text size="sm" fw={500}>{company.name}</Text>
                                            </Table.Td>
                                            <Table.Td>
                                                <Select
                                                    placeholder={t('pipelineSettings.selectStage', 'Aşama seç')}
                                                    data={targetOptions}
                                                    value={selections[company.id] ?? null}
                                                    onChange={(val) => setSelections((prev) => ({ ...prev, [company.id]: val }))}
                                                    size="xs"
                                                    clearable={false}
                                                />
                                            </Table.Td>
                                        </Table.Tr>
                                    ))}
                                </Table.Tbody>
                            </Table>
                        </ScrollArea.Autosize>
                    </>
                )}

                <Group justify="flex-end" mt="xs">
                    <Button variant="subtle" color="gray" onClick={onClose} disabled={deactivateMutation.isPending}>
                        {t('common.cancel', 'İptal')}
                    </Button>
                    <Tooltip
                        label={t('pipelineSettings.deactivateDisabledTooltip', { count: pendingCount })}
                        disabled={allAssigned || companies.length === 0}
                    >
                        <Box style={{ display: 'inline-block' }}>
                            <Button
                                color="orange"
                                onClick={() => deactivateMutation.mutate()}
                                loading={deactivateMutation.isPending}
                                disabled={companies.length > 0 && !allAssigned}
                            >
                                {t('pipelineSettings.deactivateConfirm', 'Devre Dışı Bırak')}
                            </Button>
                        </Box>
                    </Tooltip>
                </Group>
            </Stack>
        </Modal>
    );
}
