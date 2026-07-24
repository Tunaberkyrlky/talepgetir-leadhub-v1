import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Stack, Group, Text, ThemeIcon, Select, Button, Alert, Loader, Center, Badge, Paper, Divider, Collapse,
} from '@mantine/core';
import { Dropzone, MIME_TYPES } from '@mantine/dropzone';
import { IconFileImport, IconUpload, IconX, IconFileSpreadsheet, IconInfoCircle, IconCheck, IconAlertCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';
import type { Campaign, CampaignCsvSource } from '../../types/campaign';
import type { CampaignImportResult } from '../../types/import';

interface Props {
    campaignId: string;
}

type ColDef = { key: keyof CampaignCsvSource['columns']; labelKey: string; label: string };
// Alıcı kimliği — yüklemede otomatik bulunur; sadece bunlar görünür.
const REQUIRED_COLS: ColDef[] = [
    { key: 'email', labelKey: 'campaign.csv.colEmail', label: 'Email' },
    { key: 'company', labelKey: 'campaign.csv.colCompany', label: 'Company' },
];
// Opsiyonel (statü/DNC/CRM) — otomatik bulunur, "Diğer kolonlar" altında düzenlenebilir.
const OPTIONAL_COLS: ColDef[] = [
    { key: 'email_status', labelKey: 'campaign.csv.colStatus', label: 'Verification status' },
    { key: 'dnc_status', labelKey: 'campaign.csv.colDnc', label: 'DNC status' },
    { key: 'website', labelKey: 'campaign.csv.colWebsite', label: 'Website' },
    { key: 'location', labelKey: 'campaign.csv.colLocation', label: 'Country / Location' },
    { key: 'industry', labelKey: 'campaign.csv.colIndustry', label: 'Industry' },
];

// Grafta CSV Veri node'una tıklayınca sağ panelde açılır: CSV yükle → temel
// kolonları eşle → "Uygula" ile alıcıları enroll et. Her mailin mesaj/konu kolonu
// email node'larının kendi inspector'ında seçilir (per-node).
export default function CsvSourceInspector({ campaignId }: Props) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const [dropError, setDropError] = useState<string | null>(null);
    const [result, setResult] = useState<CampaignImportResult | null>(null);
    const [showMore, setShowMore] = useState(false);

    const { data: campaign } = useQuery<Campaign>({
        queryKey: ['campaign', campaignId],
        queryFn: async () => (await api.get(`/campaigns/${campaignId}`)).data.data,
    });
    const src = campaign?.csv_source ?? null;
    const headers = src?.headers ?? [];
    const columns = src?.columns ?? {};
    const headerData = headers.map((h) => ({ value: h, label: h }));

    const saveSource = async (next: CampaignCsvSource) => {
        await api.put(`/campaigns/${campaignId}/csv-source`, { csv_source: next });
        qc.invalidateQueries({ queryKey: ['campaign', campaignId] });
    };

    const renderColSelect = (c: ColDef) => (
        <Select
            key={c.key} size="xs" radius="md" clearable searchable
            label={<Text span size="xs">{t(c.labelKey, c.label)}</Text>}
            data={headerData} value={columns[c.key] ?? null}
            placeholder={t('campaign.csv.selectColumn', 'Select column')}
            onChange={(v) => src && saveSource({ ...src, columns: { ...columns, [c.key]: v || undefined } })}
        />
    );

    const uploadMut = useMutation({
        mutationFn: async (file: File) => {
            const fd = new FormData();
            fd.append('file', file);
            fd.append('importType', 'campaign_recipients');
            return (await api.post('/import/preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } })).data;
        },
        onSuccess: async (data) => {
            // Temel kolonları auto-map önerilerinden ön-doldur.
            const cols: CampaignCsvSource['columns'] = {};
            const pick: Record<string, keyof CampaignCsvSource['columns']> = {
                'campaign.email': 'email', 'companies.name': 'company', 'companies.website': 'website',
                'companies.location': 'location', 'companies.industry': 'industry',
                'campaign.email_status': 'email_status', 'campaign.dnc_status': 'dnc_status',
            };
            (data.suggestions || []).forEach((s: { fileHeader: string; dbField: string | null }) => {
                const k = s.dbField ? pick[s.dbField] : undefined;
                if (k && !cols[k]) cols[k] = s.fileHeader;
            });
            await saveSource({
                file_id: data.fileId, file_name: data.fileName, headers: data.headers, columns: cols,
                row_count: data.totalRows, sample_row: data.previewRows?.[0] || undefined,
            });
            setResult(null);
        },
        onError: (err) => showErrorFromApi(err, t('import.uploadError')),
    });

    const applyMut = useMutation({
        mutationFn: async () => (await api.post(`/campaigns/${campaignId}/csv-apply`)).data as CampaignImportResult,
        onSuccess: (data) => {
            setResult(data);
            if (!data.cancelled) showSuccess(t('campaign.csv.doneToast', { count: data.campaign.enrolled, defaultValue: '{{count}} recipients enrolled' }));
            qc.invalidateQueries({ queryKey: ['campaign-enrollments', campaignId] });
            qc.invalidateQueries({ queryKey: ['campaigns'] });
            qc.invalidateQueries({ queryKey: ['campaign', campaignId] });
        },
        onError: (err) => showErrorFromApi(err, t('import.importError')),
    });

    const canApply = !!columns.email && !!columns.company;

    return (
        <Stack gap="sm">
            <Group gap="xs" mb={2}>
                <ThemeIcon size="sm" radius="md" variant="light" color="grape"><IconFileImport size={14} /></ThemeIcon>
                <Text size="sm" fw={600}>{t('campaign.csv.title', 'CSV Data')}</Text>
            </Group>

            {!src ? (
                <>
                    <Text size="xs" c="dimmed">{t('campaign.csv.uploadDesc', 'Upload your recipient list. Then map each email node\'s message and subject columns on that node.')}</Text>
                    <Dropzone
                        onDrop={(files) => files[0] && uploadMut.mutate(files[0])}
                        onReject={() => setDropError(t('import.fileRejected', 'File rejected. Check size and format.'))}
                        maxSize={10 * 1024 * 1024} accept={[MIME_TYPES.csv, MIME_TYPES.xlsx]}
                        loading={uploadMut.isPending} radius="md"
                    >
                        <Group justify="center" gap="sm" mih={110} style={{ pointerEvents: 'none' }}>
                            <Dropzone.Accept><IconUpload size={32} color="var(--mantine-color-grape-6)" /></Dropzone.Accept>
                            <Dropzone.Reject><IconX size={32} color="var(--mantine-color-red-6)" /></Dropzone.Reject>
                            <Dropzone.Idle><IconFileSpreadsheet size={32} color="var(--mantine-color-dimmed)" /></Dropzone.Idle>
                            <Text size="sm" ta="center">{t('campaign.csv.uploadHint', 'Drag a CSV/XLSX here or click')}</Text>
                        </Group>
                    </Dropzone>
                    {dropError && <Alert color="red" radius="md" icon={<IconAlertCircle size={16} />}>{dropError}</Alert>}
                </>
            ) : (
                <>
                    <Paper withBorder radius="md" p="xs" bg="grape.0">
                        <Group justify="space-between" wrap="nowrap">
                            <Text size="xs" c="grape.9" truncate>{src.file_name || 'CSV'}</Text>
                            <Badge size="xs" variant="light" color="grape">{t('campaign.csv.rows', { count: src.row_count ?? 0, defaultValue: '{{count}} rows' })}</Badge>
                        </Group>
                    </Paper>

                    <Text size="xs" fw={600} c="dimmed">{t('campaign.csv.baseCols', 'Recipient columns (auto-detected)')}</Text>
                    {REQUIRED_COLS.map(renderColSelect)}
                    <Group justify="flex-start">
                        <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setShowMore((s) => !s)}>
                            {showMore ? t('campaign.csv.lessCols', 'Fewer columns') : t('campaign.csv.moreCols', 'Other columns (status, DNC…)')}
                        </Button>
                    </Group>
                    <Collapse in={showMore}><Stack gap="xs">{OPTIONAL_COLS.map(renderColSelect)}</Stack></Collapse>

                    <Divider my={2} />
                    <Alert color="grape" variant="light" radius="md" icon={<IconInfoCircle size={16} />} p="xs">
                        <Text size="xs">{t('campaign.csv.perNodeHint2', 'Upload here — that\'s it. On each email node in the graph, choose which column its message and subject come from, then Save and Apply.')}</Text>
                    </Alert>

                    {result && (
                        <Alert color={result.cancelled ? 'yellow' : 'green'} radius="md" p="xs"
                            icon={result.cancelled ? <IconAlertCircle size={16} /> : <IconCheck size={16} />}>
                            <Text size="xs">
                                {t('campaign.csv.result', {
                                    enrolled: result.campaign.enrolled, companies: result.createdCompanies + result.updatedCompanies,
                                    defaultValue: '{{enrolled}} recipients enrolled, {{companies}} companies in CRM.',
                                })}
                            </Text>
                        </Alert>
                    )}

                    <Group justify="space-between">
                        <Button size="xs" variant="subtle" color="gray"
                            onClick={() => saveSource({ ...src, file_id: '', headers: [], columns: {} } as CampaignCsvSource).then(() => qc.invalidateQueries({ queryKey: ['campaign', campaignId] }))}>
                            {t('campaign.csv.reupload', 'Replace file')}
                        </Button>
                        <Button size="xs" color="grape" leftSection={<IconCheck size={14} />}
                            disabled={!canApply} loading={applyMut.isPending} onClick={() => applyMut.mutate()}>
                            {t('campaign.csv.apply', 'Apply — enroll recipients')}
                        </Button>
                    </Group>
                    {!canApply && <Text size="xs" c="red">{t('campaign.csv.needBase', 'Select Email and Company columns first.')}</Text>}
                </>
            )}

            {applyMut.isPending && <Center py="xs"><Loader size="sm" color="grape" /></Center>}
        </Stack>
    );
}
