import { useState, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Modal, Stepper, Group, Button, Text, Stack, Badge, Alert, Progress, MultiSelect,
    SimpleGrid, Paper, Loader, Center, Tooltip, TextInput, NumberInput,
} from '@mantine/core';
import { Dropzone, MIME_TYPES } from '@mantine/dropzone';
import {
    IconUpload, IconX, IconFileSpreadsheet, IconAlertCircle, IconCheck, IconInfoCircle,
    IconSpeakerphone, IconArrowRight,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';
import { newId, serializeStepsToNodes } from '../../lib/graph';
import MappingEditor from '../MappingEditor';
import { EMAIL_STATUS_COLORS } from './emailStatusColors';
import type {
    MappingSuggestion, AvailableField, CampaignImportPreflight, CampaignImportResult,
} from '../../types/import';
import type { Campaign, CampaignEmailStatus, CampaignStep } from '../../types/campaign';

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
    /** Mevcut kampanyaya alıcı ekleme (Kitle sekmesi). createMode ile birlikte verilmez. */
    campaignId?: string;
    /** Sıfırdan CSV kampanyası sihirbazı: önce ad+konu ile kampanya oluşturur, sonra import eder. */
    createMode?: boolean;
    opened: boolean;
    onClose: () => void;
    /** createMode'da import bitince yeni kampanyanın id'si — çağıran yönlendirme için kullanır. */
    onCreated?: (id: string) => void;
}

// Zorunlu eşlemeler: alıcı adresi, satır bazlı mesaj, şirket adı (CRM upsert için)
const REQUIRED_FIELDS = ['campaign.email', 'campaign.message', 'companies.name'];
const DEFAULT_SUBJECT = 'Hakkında: {{company_name}}';

export default function CampaignImportModal({ campaignId, createMode, opened, onClose, onCreated }: Props) {
    const { t } = useTranslation();
    const qc = useQueryClient();

    // createMode artık tek adım: kampanyayı oluşturur, CSV yükleme editördeki CSV Veri
    // node'unda yapılır (tek temiz akış). existing-mode klasik yükle→eşle→çalıştır.
    const stepKeys = createMode ? ['campaign'] : ['upload', 'map', 'preview'];
    const idxOf = (k: string) => stepKeys.indexOf(k);

    const [active, setActive] = useState(0);
    const [previewData, setPreviewData] = useState<PreviewData | null>(null);
    const [mapping, setMapping] = useState<Record<string, string | null>>({});
    const [jobId, setJobId] = useState<string | null>(null);
    const [result, setResult] = useState<CampaignImportResult | null>(null);
    const [dropError, setDropError] = useState<string | null>(null);

    // createMode adım 0 alanları
    const [campaignName, setCampaignName] = useState('');
    const [dailyLimit, setDailyLimit] = useState<number | ''>(40);
    const [createdId, setCreatedId] = useState<string | null>(null);

    // Etkin kampanya id'si: mevcut modda prop, createMode'da oluşturulan taslak.
    const activeCampaignId = campaignId ?? createdId ?? undefined;

    // Kampanya (send_statuses için) — editor sayfasıyla aynı query key'i paylaşır
    const { data: campaign } = useQuery<Campaign>({
        queryKey: ['campaign', activeCampaignId],
        queryFn: async () => (await api.get(`/campaigns/${activeCampaignId}`)).data.data,
        enabled: opened && !!activeCampaignId,
    });
    const sendStatuses = (campaign?.settings?.send_statuses?.length
        ? campaign.settings.send_statuses
        : ['ok', 'catch_all']) as string[];

    const reset = () => {
        setActive(0); setPreviewData(null); setMapping({}); setJobId(null);
        setResult(null); setDropError(null);
        setCampaignName(''); setDailyLimit(40); setCreatedId(null);
    };
    const handleClose = () => {
        if (executeMut.isPending || createCampaignMut.isPending) return; // çalışırken kapatma
        reset();
        onClose();
    };

    // ── createMode adım 0: kampanya + graf (intro + N follow-up) oluştur ──
    const createCampaignMut = useMutation({
        mutationFn: async () => {
            const settings = typeof dailyLimit === 'number' && dailyLimit > 0 ? { daily_limit: dailyLimit } : {};
            const r = await api.post('/campaigns', { name: campaignName.trim(), settings });
            const cid = r.data.data.id as string;
            // Tek intro email adımı. Follow-up'ları kullanıcı GRAFTA ekler (Mail + Koşul
            // node'ları) — süre/kolon kararları veriyi gördükten sonra orada verilir.
            const intro: CampaignStep = {
                id: newId(), step_order: 1, step_type: 'email',
                subject: DEFAULT_SUBJECT, body_html: '', body_text: null, // fallback; gerçek konu CSV kolonundan
                delay_days: 0, delay_hours: 0,
            };
            await api.put(`/campaigns/${cid}/steps`, { nodes: serializeStepsToNodes([intro]) });
            return cid;
        },
        onSuccess: (cid) => {
            qc.invalidateQueries({ queryKey: ['campaigns'] });
            const nav = onCreated;
            reset(); onClose();
            nav?.(cid); // editöre git — CSV'yi orada CSV Veri node'undan yükle
        },
        onError: (err) => showErrorFromApi(err),
    });

    // ── Upload ──
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
            setActive(idxOf('map'));
        },
        onError: (err) => showErrorFromApi(err, t('import.uploadError')),
    });

    const handleDrop = useCallback((files: File[]) => {
        if (files.length > 0) { setDropError(null); uploadMut.mutate(files[0]); }
    }, [uploadMut]);

    const mappedFields = new Set(Object.values(mapping).filter(Boolean) as string[]);
    const missingRequired = REQUIRED_FIELDS.filter((f) => !mappedFields.has(f));

    // ── Ön-uçuş özeti (salt-okunur) ──
    const { data: preflight, isFetching: preflightLoading } = useQuery<CampaignImportPreflight>({
        queryKey: ['campaign-import-preflight', activeCampaignId, previewData?.fileId, mapping, sendStatuses],
        queryFn: async () => (await api.post('/import/campaign-summary', {
            fileId: previewData!.fileId, mapping, campaignId: activeCampaignId,
        })).data,
        enabled: opened && stepKeys[active] === 'preview' && !!previewData && !!activeCampaignId && !result,
    });

    // send_statuses kampanyaya kalıcı yazılır
    const statusesMut = useMutation({
        mutationFn: async (v: string[]) => api.put(`/campaigns/${activeCampaignId}`, {
            settings: { ...(campaign?.settings || {}), send_statuses: v as CampaignEmailStatus[] },
        }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['campaign', activeCampaignId] }),
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
                campaignId: activeCampaignId,
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
            qc.invalidateQueries({ queryKey: ['campaign-enrollments', activeCampaignId] });
            qc.invalidateQueries({ queryKey: ['campaigns'] });
            qc.invalidateQueries({ queryKey: ['campaign', activeCampaignId] });
        },
        onError: (err) => { setJobId(null); showErrorFromApi(err, t('import.importError')); },
    });

    // Lokal 2 sn poll (global ImportProgressContext'e bilinçli bağlanmıyoruz).
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
    const stepKey = stepKeys[active];

    return (
        <Modal
            opened={opened} onClose={handleClose} size="xl" radius="lg" centered
            title={createMode
                ? t('campaign.import.createTitle', 'New campaign from CSV')
                : t('campaign.import.title', 'Import recipients from CSV')}
            overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
            closeOnClickOutside={!executeMut.isPending && !createCampaignMut.isPending}
        >
            {!createMode && (
                <Stepper active={active} size="sm" color="violet" mb="md">
                    <Stepper.Step label={t('campaign.import.stepUpload', 'Upload')} />
                    <Stepper.Step label={t('campaign.import.stepMap', 'Map columns')} />
                    <Stepper.Step label={t('campaign.import.stepRun', 'Preview & run')} />
                </Stepper>
            )}

            {/* ── Adım 0 (createMode): Kampanya + konu ── */}
            {stepKey === 'campaign' && (
                <Stack gap="sm">
                    <TextInput
                        label={t('campaign.import.nameLabel', 'Campaign name')}
                        placeholder={t('campaign.import.namePlaceholder', 'e.g. Russia cold outreach - March')}
                        value={campaignName} onChange={(e) => setCampaignName(e.currentTarget.value)}
                        required radius="md"
                    />
                    <NumberInput
                        label={t('campaign.import.dailyLimitLabel', 'Daily send limit')}
                        description={t('campaign.import.dailyLimitDesc', 'Spreads the drip and protects mailbox reputation. You can change it later in campaign settings.')}
                        min={1} max={500} radius="md" maw={260}
                        value={dailyLimit}
                        onChange={(v) => setDailyLimit(typeof v === 'number' ? v : '')}
                    />

                    <Alert color="grape" variant="light" icon={<IconInfoCircle size={16} />} radius="md">
                        {t('campaign.import.createNote3', 'A draft campaign is created and opened in the editor. There, click the CSV Data node to upload your list, then build your follow-ups in the graph.')}
                    </Alert>
                    <Group justify="flex-end" mt="xs">
                        <Button variant="default" radius="md" onClick={handleClose}>{t('common.cancel', 'Cancel')}</Button>
                        <Button color="violet" radius="md" rightSection={<IconArrowRight size={16} />}
                            disabled={!campaignName.trim()} loading={createCampaignMut.isPending}
                            onClick={() => createCampaignMut.mutate()}>
                            {t('campaign.import.createGo', 'Create & open editor')}
                        </Button>
                    </Group>
                </Stack>
            )}

            {/* ── Upload ── */}
            {stepKey === 'upload' && (
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
                    {createMode && (
                        <Group justify="flex-start">
                            <Button variant="subtle" color="gray" radius="md" onClick={() => setActive(idxOf('campaign'))}>
                                {t('common.back', 'Back')}
                            </Button>
                        </Group>
                    )}
                </Stack>
            )}

            {/* ── Map ── */}
            {stepKey === 'map' && previewData && (
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
                        <Button variant="default" radius="md" onClick={() => setActive(idxOf('upload'))}>{t('common.back', 'Back')}</Button>
                        <Button color="violet" radius="md" disabled={missingRequired.length > 0} onClick={() => setActive(idxOf('preview'))}>
                            {t('common.next', 'Next')}
                        </Button>
                    </Group>
                </Stack>
            )}

            {/* ── Önizleme + çalıştır ── */}
            {stepKey === 'preview' && previewData && !result && (
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
                                <Button variant="default" radius="md" disabled={executeMut.isPending} onClick={() => setActive(idxOf('map'))}>
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
            {stepKey === 'preview' && result && (
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
                        {statCard(t('campaign.import.createdCompanies', 'Companies in CRM'), result.createdCompanies + result.updatedCompanies)}
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
                    <Alert color="blue" variant="light" icon={<IconSpeakerphone size={16} />} radius="md">
                        {t('campaign.import.nextStep', 'Recipients and their messages are ready as a draft. Open the campaign to review and click Activate to start sending (a connected mailbox is required).')}
                    </Alert>
                    <Group justify="flex-end">
                        {createMode && createdId
                            ? (
                                <>
                                    <Button variant="default" radius="md" onClick={handleClose}>{t('common.close', 'Close')}</Button>
                                    <Button color="violet" radius="md" rightSection={<IconArrowRight size={16} />}
                                        onClick={() => { const id = createdId; reset(); onClose(); onCreated?.(id); }}>
                                        {t('campaign.import.openCampaign', 'Open campaign')}
                                    </Button>
                                </>
                            )
                            : <Button color="violet" radius="md" onClick={handleClose}>{t('common.close', 'Close')}</Button>}
                    </Group>
                </Stack>
            )}
        </Modal>
    );
}
