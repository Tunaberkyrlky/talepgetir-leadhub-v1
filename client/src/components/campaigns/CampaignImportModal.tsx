import { useState, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Modal, Stepper, Group, Button, Text, Stack, Badge, Alert, Progress, MultiSelect,
    SimpleGrid, Paper, Loader, Center, Tooltip,
} from '@mantine/core';
import { Dropzone, MIME_TYPES } from '@mantine/dropzone';
import {
    IconUpload, IconX, IconFileSpreadsheet, IconAlertCircle, IconCheck, IconInfoCircle,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';
import MappingEditor from '../MappingEditor';
import { EMAIL_STATUS_COLORS } from './emailStatusColors';
import type {
    MappingSuggestion, AvailableField, CampaignImportPreflight, CampaignImportResult,
} from '../../types/import';
import type { Campaign, CampaignEmailStatus } from '../../types/campaign';

interface PreviewData {
    fileName: string;
    fileType: string;
    fileId: string;
    totalRows: number;
    headers: string[];
    suggestions: MappingSuggestion[];
    availableFields: AvailableField[];
    previewRows: Record<string, string>[];
}

interface Props {
    campaignId: string;
    opened: boolean;
    onClose: () => void;
}

// Zorunlu eşlemeler: alıcı adresi, satır bazlı mesaj, şirket adı (CRM upsert için)
const REQUIRED_FIELDS = ['campaign.email', 'campaign.message', 'companies.name'];

export default function CampaignImportModal({ campaignId, opened, onClose }: Props) {
    const { t } = useTranslation();
    const qc = useQueryClient();

    const [active, setActive] = useState(0);
    const [previewData, setPreviewData] = useState<PreviewData | null>(null);
    const [mapping, setMapping] = useState<Record<string, string | null>>({});
    const [jobId, setJobId] = useState<string | null>(null);
    const [result, setResult] = useState<CampaignImportResult | null>(null);
    const [dropError, setDropError] = useState<string | null>(null);

    // Kampanya (send_statuses için) — editor sayfasıyla aynı query key'i paylaşır
    const { data: campaign } = useQuery<Campaign>({
        queryKey: ['campaign', campaignId],
        queryFn: async () => (await api.get(`/campaigns/${campaignId}`)).data.data,
        enabled: opened,
    });
    const sendStatuses = (campaign?.settings?.send_statuses?.length
        ? campaign.settings.send_statuses
        : ['ok', 'catch_all']) as string[];

    const reset = () => {
        setActive(0); setPreviewData(null); setMapping({}); setJobId(null);
        setResult(null); setDropError(null);
    };
    const handleClose = () => {
        if (executeMut.isPending) return; // çalışırken kapatma — iptal butonu var
        reset();
        onClose();
    };

    // ── 1. Upload ──
    const uploadMut = useMutation({
        mutationFn: async (file: File) => {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('importType', 'campaign_recipients');
            const res = await api.post('/import/preview', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            return res.data as PreviewData;
        },
        onSuccess: (data) => {
            setPreviewData(data);
            const initial: Record<string, string | null> = {};
            data.suggestions.forEach((s) => { initial[s.fileHeader] = s.dbField; });
            setMapping(initial);
            setActive(1);
        },
        onError: (err) => showErrorFromApi(err, t('import.uploadError')),
    });

    const handleDrop = useCallback((files: File[]) => {
        if (files.length > 0) { setDropError(null); uploadMut.mutate(files[0]); }
    }, [uploadMut]);

    const mappedFields = new Set(Object.values(mapping).filter(Boolean) as string[]);
    const missingRequired = REQUIRED_FIELDS.filter((f) => !mappedFields.has(f));

    // ── 3. Ön-uçuş özeti (salt-okunur) ──
    const { data: preflight, isFetching: preflightLoading } = useQuery<CampaignImportPreflight>({
        queryKey: ['campaign-import-preflight', campaignId, previewData?.fileId, mapping, sendStatuses],
        queryFn: async () => (await api.post('/import/campaign-summary', {
            fileId: previewData!.fileId, mapping, campaignId,
        })).data,
        enabled: opened && active === 2 && !!previewData && !result,
    });

    // send_statuses kampanyaya kalıcı yazılır (modal dışında Ayarlar'dan da düzenlenebilir)
    const statusesMut = useMutation({
        mutationFn: async (v: string[]) => api.put(`/campaigns/${campaignId}`, {
            settings: { ...(campaign?.settings || {}), send_statuses: v as CampaignEmailStatus[] },
        }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['campaign', campaignId] }),
        onError: (err) => showErrorFromApi(err),
    });

    // ── Execute + job poll ──
    const executeMut = useMutation({
        mutationFn: async () => {
            const beginRes = await api.post('/import/begin', {
                fileName: previewData!.fileName,
                fileType: previewData!.fileType,
                totalRows: previewData!.totalRows,
                mapping,
                importType: 'campaign_recipients',
                campaignId,
            });
            const newJobId: string = beginRes.data.jobId;
            setJobId(newJobId);
            const res = await api.post('/import/execute', {
                fileId: previewData!.fileId,
                fileName: previewData!.fileName,
                fileType: previewData!.fileType,
                mapping,
                jobId: newJobId,
            });
            return res.data as CampaignImportResult;
        },
        onSuccess: (data) => {
            setResult(data);
            setJobId(null);
            if (!data.cancelled) showSuccess(t('campaign.import.doneToast', { count: data.campaign.enrolled, defaultValue: '{{count}} recipients enrolled' }));
            qc.invalidateQueries({ queryKey: ['campaign-enrollments', campaignId] });
            qc.invalidateQueries({ queryKey: ['campaigns'] });
            qc.invalidateQueries({ queryKey: ['campaign', campaignId] });
        },
        onError: (err) => { setJobId(null); showErrorFromApi(err, t('import.importError')); },
    });

    // Global ImportProgressContext'e bilinçli bağlanmıyoruz — o sessionStorage ile
    // CRM ImportPage'e kilitli. Lokal 2 sn poll modal içinde yeterli.
    const { data: jobProgress } = useQuery<{ progress_count: number; total_rows: number }>({
        queryKey: ['campaign-import-job', jobId],
        queryFn: async () => (await api.get(`/import/jobs/${jobId}`)).data.data,
        enabled: !!jobId && executeMut.isPending,
        refetchInterval: 2000,
    });

    const cancelMut = useMutation({
        mutationFn: async () => api.post(`/import/cancel/${jobId}`),
        onError: (err) => showErrorFromApi(err),
    });

    const progressPct = jobProgress && jobProgress.total_rows > 0
        ? Math.round(((jobProgress.progress_count || 0) / jobProgress.total_rows) * 100)
        : 0;

    const statCard = (label: string, value: number | string, color?: string) => (
        <Paper p="xs" radius="md" withBorder key={label}>
            <Text size="xs" c="dimmed">{label}</Text>
            <Text size="lg" fw={700} c={color}>{value}</Text>
        </Paper>
    );

    const excludedTotal = result ? Object.values(result.campaign.excluded).reduce((a, b) => a + b, 0) : 0;

    return (
        <Modal
            opened={opened} onClose={handleClose} size="xl" radius="lg" centered
            title={t('campaign.import.title', 'Import recipients from CSV')}
            overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
            closeOnClickOutside={!executeMut.isPending}
        >
            <Stepper active={active} size="sm" color="violet" mb="md">
                <Stepper.Step label={t('campaign.import.stepUpload', 'Upload')} />
                <Stepper.Step label={t('campaign.import.stepMap', 'Map columns')} />
                <Stepper.Step label={t('campaign.import.stepRun', 'Preview & run')} />
            </Stepper>

            {/* ── Adım 1: Upload ── */}
            {active === 0 && (
                <Stack gap="sm">
                    <Dropzone
                        onDrop={handleDrop}
                        onReject={() => setDropError(t('import.fileRejected', 'File rejected. Check size and format.'))}
                        maxSize={10 * 1024 * 1024}
                        accept={[MIME_TYPES.csv, MIME_TYPES.xlsx]}
                        loading={uploadMut.isPending}
                        radius="md"
                    >
                        <Group justify="center" gap="xl" mih={140} style={{ pointerEvents: 'none' }}>
                            <Dropzone.Accept><IconUpload size={40} color="var(--mantine-color-violet-6)" stroke={1.5} /></Dropzone.Accept>
                            <Dropzone.Reject><IconX size={40} color="var(--mantine-color-red-6)" stroke={1.5} /></Dropzone.Reject>
                            <Dropzone.Idle><IconFileSpreadsheet size={40} color="var(--mantine-color-dimmed)" stroke={1.5} /></Dropzone.Idle>
                            <div>
                                <Text size="md">{t('campaign.import.uploadHint', 'Drag a CSV/XLSX recipient list here or click to select')}</Text>
                                <Text size="xs" c="dimmed" mt={4}>{t('import.uploadLimit', 'Max 10MB — .csv, .xlsx')}</Text>
                            </div>
                        </Group>
                    </Dropzone>
                    {dropError && <Alert color="red" icon={<IconAlertCircle size={16} />} radius="md">{dropError}</Alert>}
                    <Alert color="grape" variant="light" icon={<IconInfoCircle size={16} />} radius="md">
                        {t('campaign.import.uploadNote', 'Each row becomes a campaign recipient; the row message is sent as the intro email body. Companies and contacts are also created in the CRM.')}
                    </Alert>
                </Stack>
            )}

            {/* ── Adım 2: Map ── */}
            {active === 1 && previewData && (
                <Stack gap="sm">
                    <Group justify="space-between">
                        <Text size="sm" c="dimmed">
                            {previewData.fileName} — {t('campaign.import.rowCount', { count: previewData.totalRows, defaultValue: '{{count}} rows' })}
                        </Text>
                        {missingRequired.length > 0 && (
                            <Badge color="red" variant="light" radius="sm">
                                {t('campaign.import.mapRequired', 'Email, Message and Company columns are required')}
                            </Badge>
                        )}
                    </Group>
                    <MappingEditor
                        suggestions={previewData.suggestions}
                        mapping={mapping}
                        availableFields={previewData.availableFields}
                        onMappingChange={(h, f) => setMapping((p) => ({ ...p, [h]: f }))}
                        previewRows={previewData.previewRows}
                    />
                    <Group justify="space-between" mt="xs">
                        <Button variant="default" radius="md" onClick={() => setActive(0)}>{t('common.back', 'Back')}</Button>
                        <Button color="violet" radius="md" disabled={missingRequired.length > 0} onClick={() => setActive(2)}>
                            {t('common.next', 'Next')}
                        </Button>
                    </Group>
                </Stack>
            )}

            {/* ── Adım 3: Önizleme + çalıştır / sonuç ── */}
            {active === 2 && previewData && !result && (
                <Stack gap="sm">
                    {preflightLoading || !preflight ? (
                        <Center py="xl"><Loader color="violet" /></Center>
                    ) : (
                        <>
                            <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
                                {statCard(t('campaign.import.total', 'Total rows'), preflight.total)}
                                {statCard(t('campaign.import.eligible', 'Eligible to send'), preflight.eligible, 'green')}
                                {statCard(t('campaign.import.invalidEmails', 'Invalid emails'), preflight.invalidEmails, preflight.invalidEmails > 0 ? 'red' : undefined)}
                                {statCard(t('campaign.import.duplicates', 'Duplicates in file'), preflight.duplicatesInFile)}
                            </SimpleGrid>

                            <Group gap="xs">
                                {Object.entries(preflight.byStatus).map(([status, count]) => (
                                    <Badge key={status} variant="light" radius="sm" color={EMAIL_STATUS_COLORS[status] || 'gray'}>
                                        {status}: {count}
                                    </Badge>
                                ))}
                                {preflight.dncExcluded > 0 && (
                                    <Badge variant="light" radius="sm" color="orange">DNC: {preflight.dncExcluded}</Badge>
                                )}
                                {preflight.multiEmailCells > 0 && (
                                    <Tooltip label={t('campaign.import.multiEmailHint', 'Cells with multiple addresses: the first valid one is used, the rest are stored.')}>
                                        <Badge variant="light" radius="sm" color="blue">
                                            {t('campaign.import.multiEmail', { count: preflight.multiEmailCells, defaultValue: '{{count}} multi-email cells' })}
                                        </Badge>
                                    </Tooltip>
                                )}
                            </Group>

                            <MultiSelect
                                label={t('campaign.import.sendStatuses', 'Verification statuses eligible for sending')}
                                description={t('campaign.import.sendStatusesHint', 'invalid and error rows are imported but never sent automatically. This setting is saved on the campaign.')}
                                data={[
                                    { value: 'ok', label: 'ok' },
                                    { value: 'catch_all', label: 'catch_all' },
                                    { value: 'unknown', label: 'unknown' },
                                ]}
                                value={sendStatuses}
                                onChange={(v) => { if (v.length > 0) statusesMut.mutate(v); }}
                                radius="md" size="sm" maw={420}
                                disabled={statusesMut.isPending || executeMut.isPending}
                            />

                            <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />} radius="md">
                                {preflight.dailyLimit
                                    ? t('campaign.import.estimate', {
                                        days: preflight.estimatedDays ?? 0, limit: preflight.dailyLimit,
                                        defaultValue: 'At {{limit}}/day the eligible recipients take ≈{{days}} day(s) to send.',
                                    })
                                    : t('campaign.import.noDailyLimit', 'No daily limit set on this campaign — consider setting one before importing a cold list.')}
                                {' '}{t('campaign.import.junkHint', 'Tip: remove suspicious generic addresses (e.g. donate@/info@) beforehand, or pause them individually after import.')}
                            </Alert>

                            {executeMut.isPending && (
                                <Stack gap={4}>
                                    <Progress value={progressPct} color="violet" radius="xl" animated />
                                    <Group justify="space-between">
                                        <Text size="xs" c="dimmed">{t('campaign.import.running', 'Importing...')}</Text>
                                        <Button size="compact-xs" variant="subtle" color="red" loading={cancelMut.isPending}
                                            onClick={() => cancelMut.mutate()} disabled={!jobId}>
                                            {t('common.cancel', 'Cancel')}
                                        </Button>
                                    </Group>
                                </Stack>
                            )}

                            <Group justify="space-between" mt="xs">
                                <Button variant="default" radius="md" disabled={executeMut.isPending} onClick={() => setActive(1)}>
                                    {t('common.back', 'Back')}
                                </Button>
                                <Button color="violet" radius="md" loading={executeMut.isPending}
                                    disabled={preflight.eligible === 0 && preflight.total === 0}
                                    onClick={() => executeMut.mutate()}>
                                    {t('campaign.import.run', { count: preflight.eligible, defaultValue: 'Import ({{count}} eligible)' })}
                                </Button>
                            </Group>
                        </>
                    )}
                </Stack>
            )}

            {/* ── Sonuç ── */}
            {active === 2 && result && (
                <Stack gap="sm">
                    <Alert
                        color={result.cancelled ? 'yellow' : 'green'} radius="md"
                        icon={result.cancelled ? <IconAlertCircle size={16} /> : <IconCheck size={16} />}
                    >
                        {result.cancelled
                            ? t('campaign.import.cancelledNote', 'Import cancelled — rows written before cancelling remain enrolled.')
                            : t('campaign.import.resultTitle', 'Import completed')}
                    </Alert>
                    <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
                        {statCard(t('campaign.import.enrolled', 'Enrolled (active)'), result.campaign.enrolled, 'green')}
                        {statCard(t('campaign.import.excludedCount', 'Excluded (paused)'), excludedTotal, excludedTotal > 0 ? 'yellow' : undefined)}
                        {statCard(t('campaign.import.alreadyEnrolled', 'Already enrolled'), result.campaign.skippedAlreadyEnrolled)}
                        {statCard(t('campaign.import.errorRows', 'Rows with errors'), result.errorCount, result.errorCount > 0 ? 'red' : undefined)}
                    </SimpleGrid>
                    {Object.keys(result.campaign.excluded).length > 0 && (
                        <Group gap="xs">
                            {Object.entries(result.campaign.excluded).map(([reason, count]) => (
                                <Badge key={reason} variant="light" radius="sm" color="yellow">
                                    {t(`campaign.import.reason.${reason}`, reason)}: {count}
                                </Badge>
                            ))}
                        </Group>
                    )}
                    {result.campaign.estimatedDays != null && !result.cancelled && (
                        <Text size="sm" c="dimmed">
                            {t('campaign.import.resultEstimate', {
                                days: result.campaign.estimatedDays,
                                defaultValue: 'Estimated sending duration: ≈{{days}} day(s) at the current daily limit.',
                            })}
                        </Text>
                    )}
                    <Group justify="flex-end">
                        <Button color="violet" radius="md" onClick={handleClose}>{t('common.close', 'Close')}</Button>
                    </Group>
                </Stack>
            )}
        </Modal>
    );
}
