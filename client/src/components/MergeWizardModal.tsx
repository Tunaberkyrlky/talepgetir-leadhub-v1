import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Modal,
    Stack,
    Group,
    Text,
    Button,
    Radio,
    Table,
    Alert,
    Center,
    Loader,
    Badge,
    ScrollArea,
    Divider,
} from '@mantine/core';
import { IconAlertTriangle, IconArrowRight } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';

type EntityType = 'company' | 'contact';
type Winner = 'source' | 'target';

interface MergeWizardModalProps {
    opened: boolean;
    onClose: () => void;
    entityType: EntityType;
    sourceId: string;   // the duplicate that will be disabled
    targetId: string;   // the record that survives
    onSuccess?: () => void;
}

// Field allowlists MUST mirror the merge_companies / merge_contacts RPC (136).
// Order = display order in the comparison table.
const COMPANY_FIELDS = [
    'name', 'website', 'company_phone', 'company_email', 'email_status',
    'location', 'industry', 'employee_size', 'linkedin', 'fit_score',
    'next_step', 'company_summary', 'internal_notes',
    'product_services', 'product_portfolio',
] as const;

const CONTACT_FIELDS = [
    'first_name', 'last_name', 'title', 'email', 'phone_e164',
    'country', 'seniority', 'department', 'linkedin',
] as const;

type AnyRecord = Record<string, unknown>;

function displayValue(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.filter((x) => x != null && x !== '').join(', ');
    return String(v);
}

function recordTitle(entityType: EntityType, rec: AnyRecord | undefined): string {
    if (!rec) return '';
    if (entityType === 'company') return displayValue(rec.name);
    return [rec.first_name, rec.last_name].filter(Boolean).join(' ') || displayValue(rec.email);
}

export default function MergeWizardModal({
    opened,
    onClose,
    entityType,
    sourceId,
    targetId,
    onSuccess,
}: MergeWizardModalProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const fields = entityType === 'company' ? COMPANY_FIELDS : CONTACT_FIELDS;

    // winners[field] = which record's value the target keeps. Default resolves once
    // the preview loads (empty side auto-yields to the filled side).
    const [winners, setWinners] = useState<Record<string, Winner>>({});

    const base = entityType === 'company' ? '/companies' : '/contacts';

    const preview = useQuery({
        queryKey: ['merge-preview', entityType, sourceId, targetId],
        enabled: opened && !!sourceId && !!targetId,
        queryFn: async () => {
            const [srcRes, tgtRes] = await Promise.all([
                api.get(`${base}/${sourceId}`),
                api.get(`${base}/${targetId}`),
            ]);
            const source = srcRes.data.data as AnyRecord;
            const target = tgtRes.data.data as AnyRecord;

            // Best-effort child-record counts that will move off the source.
            const counts: Record<string, number> = {};
            try {
                if (entityType === 'company') {
                    counts.contacts = Number(source.contact_count ?? 0);
                    const [tasksRes, actsRes] = await Promise.all([
                        api.get(`/tasks`, { params: { company_id: sourceId, limit: 1 } }),
                        api.get(`/activities`, { params: { company_id: sourceId, limit: 1 } }),
                    ]);
                    counts.tasks = Number(tasksRes.data?.pagination?.total ?? 0);
                    counts.activities = Number(actsRes.data?.pagination?.total ?? 0);
                } else {
                    const companyId = String(source.company_id || '');
                    const reqs: Promise<unknown>[] = [
                        api.get(`/tasks`, { params: { contact_id: sourceId, limit: 1 } }),
                    ];
                    if (companyId) {
                        reqs.push(api.get(`/activities`, { params: { company_id: companyId, contact_id: sourceId, limit: 1 } }));
                    }
                    const [tasksRes, actsRes] = await Promise.all(reqs) as Array<{ data?: { pagination?: { total?: number } } }>;
                    counts.tasks = Number(tasksRes?.data?.pagination?.total ?? 0);
                    counts.activities = Number(actsRes?.data?.pagination?.total ?? 0);
                }
            } catch {
                // Counts are advisory only — never block the merge on a failed preview count.
            }

            return { source, target, counts };
        },
    });

    // Seed default winners whenever fresh preview data arrives.
    useEffect(() => {
        if (!preview.data) return;
        const { source, target } = preview.data;
        const next: Record<string, Winner> = {};
        for (const f of fields) {
            const srcEmpty = displayValue(source[f]).trim() === '';
            const tgtEmpty = displayValue(target[f]).trim() === '';
            // Prefer the filled value; when target is empty and source has one, take source.
            next[f] = tgtEmpty && !srcEmpty ? 'source' : 'target';
        }
        setWinners(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [preview.data, entityType]);

    const mergeMutation = useMutation({
        mutationFn: async () => {
            const res = await api.post(`${base}/merge`, {
                source_id: sourceId,
                target_id: targetId,
                field_winners: winners,
            });
            return res.data;
        },
        onSuccess: (data) => {
            showSuccess(t('merge.success'));
            if (entityType === 'company') {
                queryClient.invalidateQueries({ queryKey: ['company'] });
                queryClient.invalidateQueries({ queryKey: ['companies'] });
                queryClient.invalidateQueries({ queryKey: ['pipeline'] });
                queryClient.invalidateQueries({ queryKey: ['statistics'] });
            } else {
                queryClient.invalidateQueries({ queryKey: ['person'] });
                queryClient.invalidateQueries({ queryKey: ['contacts'] });
                queryClient.invalidateQueries({ queryKey: ['company'] });
            }
            queryClient.invalidateQueries({ queryKey: ['merge-preview'] });
            onSuccess?.();
            onClose();
            return data;
        },
        onError: (err) => showErrorFromApi(err),
    });

    const rows = useMemo(() => {
        if (!preview.data) return [];
        const { source, target } = preview.data;
        return fields
            .map((f) => ({
                field: f as string,
                sourceValue: displayValue(source[f]),
                targetValue: displayValue(target[f]),
            }))
            // Hide rows where both sides are empty — nothing to choose.
            .filter((r) => r.sourceValue.trim() !== '' || r.targetValue.trim() !== '');
    }, [preview.data, fields]);

    const pick = (field: string, w: Winner) => setWinners((prev) => ({ ...prev, [field]: w }));

    const sourceTitle = recordTitle(entityType, preview.data?.source);
    const targetTitle = recordTitle(entityType, preview.data?.target);
    const counts = preview.data?.counts ?? {};
    const countEntries = Object.entries(counts).filter(([, n]) => Number(n) > 0);

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={t('merge.title')}
            size="lg"
            radius="lg"
            centered
            overlayProps={{ backgroundOpacity: 0.45, blur: 4 }}
            styles={{ title: { fontWeight: 700, fontSize: '1.1rem' } }}
        >
            {preview.isLoading ? (
                <Center py="xl"><Loader /></Center>
            ) : preview.isError ? (
                <Alert icon={<IconAlertTriangle size={16} />} color="red" variant="light" radius="md">
                    {t('merge.loadError')}
                </Alert>
            ) : (
                <Stack gap="md">
                    <Alert icon={<IconAlertTriangle size={16} />} color="orange" variant="light" radius="md">
                        <Text size="sm">
                            {t('merge.directionNotice')}
                        </Text>
                        <Group gap="xs" mt={6} wrap="nowrap" align="center">
                            <Badge color="gray" variant="light" radius="sm">{sourceTitle || t('merge.source')}</Badge>
                            <IconArrowRight size={16} />
                            <Badge color="teal" variant="light" radius="sm">{targetTitle || t('merge.target')}</Badge>
                        </Group>
                    </Alert>

                    <div>
                        <Text size="sm" fw={600} mb={4}>{t('merge.fieldTableTitle')}</Text>
                        <ScrollArea.Autosize mah={340}>
                            <Table striped highlightOnHover withTableBorder verticalSpacing="xs" fz="sm">
                                <Table.Thead>
                                    <Table.Tr>
                                        <Table.Th>{t('merge.fieldColumn')}</Table.Th>
                                        <Table.Th>{t('merge.keepSource')}</Table.Th>
                                        <Table.Th>{t('merge.keepTarget')}</Table.Th>
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    {rows.map((r) => (
                                        <Table.Tr key={r.field}>
                                            <Table.Td>
                                                <Text size="xs" fw={600} c="dimmed">
                                                    {t(`merge.fields.${r.field}`)}
                                                </Text>
                                            </Table.Td>
                                            <Table.Td
                                                onClick={() => pick(r.field, 'source')}
                                                style={{ cursor: 'pointer' }}
                                            >
                                                <Group gap="xs" wrap="nowrap" align="flex-start">
                                                    <Radio
                                                        checked={winners[r.field] === 'source'}
                                                        onChange={() => pick(r.field, 'source')}
                                                        size="xs"
                                                        mt={2}
                                                        aria-label={`${t('merge.keepSource')} ${t(`merge.fields.${r.field}`)}`}
                                                    />
                                                    <Text size="xs" lineClamp={2} c={r.sourceValue ? undefined : 'dimmed'}>
                                                        {r.sourceValue || t('merge.empty')}
                                                    </Text>
                                                </Group>
                                            </Table.Td>
                                            <Table.Td
                                                onClick={() => pick(r.field, 'target')}
                                                style={{ cursor: 'pointer' }}
                                            >
                                                <Group gap="xs" wrap="nowrap" align="flex-start">
                                                    <Radio
                                                        checked={winners[r.field] === 'target'}
                                                        onChange={() => pick(r.field, 'target')}
                                                        size="xs"
                                                        mt={2}
                                                        color="teal"
                                                        aria-label={`${t('merge.keepTarget')} ${t(`merge.fields.${r.field}`)}`}
                                                    />
                                                    <Text size="xs" lineClamp={2} c={r.targetValue ? undefined : 'dimmed'}>
                                                        {r.targetValue || t('merge.empty')}
                                                    </Text>
                                                </Group>
                                            </Table.Td>
                                        </Table.Tr>
                                    ))}
                                </Table.Tbody>
                            </Table>
                        </ScrollArea.Autosize>
                    </div>

                    <Divider />

                    <div>
                        <Text size="sm" fw={600} mb={4}>{t('merge.moveTitle')}</Text>
                        {countEntries.length === 0 ? (
                            <Text size="xs" c="dimmed">{t('merge.moveNone')}</Text>
                        ) : (
                            <Group gap="sm">
                                {countEntries.map(([k, n]) => (
                                    <Badge key={k} variant="light" color="blue" radius="sm">
                                        {t(`merge.moved.${k}`, { defaultValue: k })}: {n}
                                    </Badge>
                                ))}
                            </Group>
                        )}
                    </div>

                    <Text size="xs" c="dimmed">{t('merge.disableNotice')}</Text>

                    <Group justify="flex-end" mt="xs">
                        <Button variant="default" radius="md" onClick={onClose}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            color="orange"
                            radius="md"
                            loading={mergeMutation.isPending}
                            disabled={rows.length === 0}
                            onClick={() => mergeMutation.mutate()}
                        >
                            {t('merge.confirm')}
                        </Button>
                    </Group>
                </Stack>
            )}
        </Modal>
    );
}
