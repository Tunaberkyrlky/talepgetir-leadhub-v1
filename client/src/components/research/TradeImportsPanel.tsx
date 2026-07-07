import { useEffect, useMemo, useState } from 'react';
import {
    Alert, Badge, Button, FileInput, Group, Loader, Pagination, Paper, Select, Stack, Table, Text,
} from '@mantine/core';
import { IconAlertCircle, IconDatabaseImport, IconEye, IconFileSpreadsheet, IconSearch } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showError, showErrorFromApi, showSuccess } from '../../lib/notifications';
import type { ResearchIcp } from './IcpCard';

interface ResearchProject {
    id: string;
    name: string;
}

interface PreviewRow {
    rowNumber: number;
    companyName: string | null;
    hsCodes: string[];
    exportValue: number | null;
    website: string | null;
    country: string | null;
    currency: string;
    confidence: 'high' | 'medium' | 'low';
    needsReview: boolean;
    reviewReasons: string[];
    rejected: boolean;
}

interface TradePreview {
    fileName: string;
    totalRows: number;
    acceptedRows: number;
    reviewRows: number;
    rejectedRows: number;
    rows: PreviewRow[];
}

interface TradeBatch {
    id: string;
    project_id: string;
    job_id: string | null;
    file_name: string;
    status: 'queued' | 'processing' | 'processed' | 'failed';
    total_rows: number;
    accepted_rows: number;
    review_rows: number;
    rejected_rows: number;
    processed_rows: number;
    linked_companies: number;
    error: string | null;
    created_at: string;
}

interface TradeBatchResponse {
    data: TradeBatch[];
    pagination: { total: number; page: number; limit: number };
}

interface ResearchJob {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    result: { matches?: number; newly_billed?: number } | null;
    error: string | null;
}

const STATUS_COLOR: Record<TradeBatch['status'], string> = {
    queued: 'gray',
    processing: 'blue',
    processed: 'green',
    failed: 'red',
};

function uploadBody(file: File, projectId?: string): FormData {
    const form = new FormData();
    form.append('file', file);
    if (projectId) form.append('project_id', projectId);
    return form;
}

export default function TradeImportsPanel() {
    const { t, i18n } = useTranslation();
    const qc = useQueryClient();
    const [projectId, setProjectId] = useState<string | null>(null);
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<TradePreview | null>(null);
    const [batchPage, setBatchPage] = useState(1);
    const [icpId, setIcpId] = useState<string | null>(null);
    const [researchJobId, setResearchJobId] = useState<string | null>(null);
    const [researchBatchId, setResearchBatchId] = useState<string | null>(null);

    const projectsQuery = useQuery<{ data: ResearchProject[] }>({
        queryKey: ['research', 'projects'],
        queryFn: async () => (await api.get('/research/projects')).data,
    });
    const projects = useMemo(() => projectsQuery.data?.data ?? [], [projectsQuery.data]);
    const selectedProjectId = projectId ?? (projects.length === 1 ? projects[0].id : null);

    const icpsQuery = useQuery<{ data: ResearchIcp[] }>({
        queryKey: ['research', 'icps', selectedProjectId],
        queryFn: async () => (await api.get(`/research/icps?project_id=${selectedProjectId}&status=approved`)).data,
        enabled: !!selectedProjectId,
    });
    const approvedIcps = icpsQuery.data?.data ?? [];

    const batchesQuery = useQuery<TradeBatchResponse>({
        queryKey: ['research', 'trade-batches', selectedProjectId, batchPage],
        queryFn: async () => (await api.get(`/research/trade/batches?project_id=${selectedProjectId}&page=${batchPage}&limit=20`)).data,
        enabled: !!selectedProjectId,
        refetchInterval: (query) => query.state.data?.data.some((batch) =>
            batch.status === 'queued' || batch.status === 'processing') ? 2000 : false,
    });
    const batches = batchesQuery.data?.data ?? [];
    const batchPages = Math.ceil((batchesQuery.data?.pagination.total ?? 0) / 20);

    const previewMut = useMutation({
        mutationFn: async () => {
            if (!file) throw new Error('CSV file is required');
            return (await api.post('/research/trade/preview', uploadBody(file), {
                headers: { 'Content-Type': 'multipart/form-data' },
            })).data as TradePreview;
        },
        onSuccess: setPreview,
        onError: (error: unknown) => showErrorFromApi(error),
    });

    const importMut = useMutation({
        mutationFn: async () => {
            if (!file || !selectedProjectId) throw new Error('Project and CSV file are required');
            return (await api.post('/research/trade/import', uploadBody(file, selectedProjectId), {
                headers: { 'Content-Type': 'multipart/form-data' },
            })).data as { batch: TradeBatch };
        },
        onSuccess: (data) => {
            showSuccess(t('research.trade.importQueued', 'Trade import queued: {{count}} rows', {
                count: data.batch.accepted_rows,
            }));
            setFile(null);
            setPreview(null);
            qc.invalidateQueries({ queryKey: ['research', 'trade-batches', selectedProjectId] });
        },
        onError: (error: unknown) => showErrorFromApi(error),
    });

    const researchMut = useMutation({
        mutationFn: async (batchId: string) => {
            if (!icpId) throw new Error('Approved ICP is required');
            return (await api.post(`/research/trade/batches/${batchId}/research`, { icp_id: icpId })).data as ResearchJob;
        },
        onSuccess: (job, batchId) => {
            setResearchBatchId(batchId);
            setResearchJobId(job.id);
        },
        onError: (error: unknown, batchId) => {
            const response = (error as { response?: { status?: number; data?: { job_id?: string } } }).response;
            if (response?.status === 409 && response.data?.job_id) {
                setResearchBatchId(batchId);
                setResearchJobId(response.data.job_id);
                return;
            }
            showErrorFromApi(error);
        },
    });

    const researchJobQuery = useQuery<ResearchJob>({
        queryKey: ['research', 'job', researchJobId],
        queryFn: async () => (await api.get(`/research/jobs/${researchJobId}`)).data,
        enabled: !!researchJobId,
        refetchInterval: (query) => {
            const status = query.state.data?.status;
            return status === 'queued' || status === 'running' ? 2000 : false;
        },
    });
    const researchStatus = researchJobQuery.data?.status;
    useEffect(() => {
        if (researchStatus === 'succeeded') {
            const result = researchJobQuery.data?.result;
            showSuccess(t('research.trade.researchDone', 'Research completed: {{matches}} match, {{billed}} new credit used', {
                matches: result?.matches ?? 0,
                billed: result?.newly_billed ?? 0,
            }));
            qc.invalidateQueries({ queryKey: ['research', 'companies'] });
            qc.invalidateQueries({ queryKey: ['research', 'credits'] });
        } else if (researchStatus === 'failed' || researchStatus === 'canceled') {
            showError(researchJobQuery.data?.error || t('research.trade.researchFailed', 'Research failed'));
        }
        // The status transition is the notification edge; query data objects change on each poll.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [researchStatus]);

    const busy = previewMut.isPending || importMut.isPending;
    const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);

    return (
        <Stack gap="md">
            <Paper withBorder radius="md" p="md">
                <Stack gap="md">
                    <Group align="flex-end" wrap="wrap">
                        <Select
                            label={t('research.trade.project', 'Project')}
                            placeholder={t('research.trade.pickProject', 'Pick a project')}
                            data={projects.map((project) => ({ value: project.id, label: project.name }))}
                            value={selectedProjectId}
                            onChange={(value) => {
                                setProjectId(value);
                                setIcpId(null);
                                setPreview(null);
                                setBatchPage(1);
                            }}
                            searchable
                            w={240}
                        />
                        <Select
                            label={t('research.trade.icp', 'Approved ICP')}
                            placeholder={t('research.trade.pickIcp', 'Pick an ICP')}
                            data={approvedIcps.map((icp) => ({ value: icp.id, label: icp.name }))}
                            value={icpId}
                            onChange={setIcpId}
                            disabled={!selectedProjectId}
                            searchable
                            w={240}
                        />
                        <FileInput
                            label={t('research.trade.file', 'Customs CSV')}
                            placeholder={t('research.trade.pickFile', 'Select CSV')}
                            accept=".csv,text/csv"
                            value={file}
                            onChange={(value) => { setFile(value); setPreview(null); }}
                            leftSection={<IconFileSpreadsheet size={17} />}
                            clearable
                            w={300}
                        />
                        <Button
                            variant="default"
                            leftSection={<IconEye size={17} />}
                            disabled={!file || busy}
                            loading={previewMut.isPending}
                            onClick={() => previewMut.mutate()}
                        >
                            {t('research.trade.preview', 'Preview')}
                        </Button>
                        <Button
                            leftSection={<IconDatabaseImport size={17} />}
                            disabled={!selectedProjectId || !file || !preview || preview.acceptedRows === 0 || busy}
                            loading={importMut.isPending}
                            onClick={() => importMut.mutate()}
                        >
                            {t('research.trade.import', 'Import buyers')}
                        </Button>
                    </Group>

                    {preview && (
                        <>
                            <Group gap="xs">
                                <Badge variant="light">{t('research.trade.total', '{{count}} rows', { count: preview.totalRows })}</Badge>
                                <Badge color="green" variant="light">{t('research.trade.accepted', '{{count}} accepted', { count: preview.acceptedRows })}</Badge>
                                <Badge color="yellow" variant="light">{t('research.trade.review', '{{count}} review', { count: preview.reviewRows })}</Badge>
                                <Badge color="red" variant="light">{t('research.trade.rejected', '{{count}} rejected', { count: preview.rejectedRows })}</Badge>
                            </Group>
                            <Table.ScrollContainer minWidth={760}>
                                <Table striped highlightOnHover>
                                    <Table.Thead>
                                        <Table.Tr>
                                            <Table.Th>#</Table.Th>
                                            <Table.Th>{t('research.trade.company', 'Buyer company')}</Table.Th>
                                            <Table.Th>{t('research.trade.hsCodes', 'HS / GTIP')}</Table.Th>
                                            <Table.Th>{t('research.trade.amount', 'Amount')}</Table.Th>
                                            <Table.Th>{t('research.trade.country', 'Country')}</Table.Th>
                                            <Table.Th>{t('research.trade.quality', 'Quality')}</Table.Th>
                                        </Table.Tr>
                                    </Table.Thead>
                                    <Table.Tbody>
                                        {preview.rows.map((row) => (
                                            <Table.Tr key={row.rowNumber}>
                                                <Table.Td>{row.rowNumber}</Table.Td>
                                                <Table.Td>
                                                    <Text size="sm" fw={500}>{row.companyName ?? '-'}</Text>
                                                    {row.website && <Text size="xs" c="dimmed">{row.website}</Text>}
                                                </Table.Td>
                                                <Table.Td>{row.hsCodes.join(', ') || '-'}</Table.Td>
                                                <Table.Td>{row.exportValue == null ? '-' : `${number.format(row.exportValue)} ${row.currency}`}</Table.Td>
                                                <Table.Td>{row.country ?? '-'}</Table.Td>
                                                <Table.Td>
                                                    <Badge color={row.rejected ? 'red' : row.needsReview ? 'yellow' : 'green'} variant="light">
                                                        {row.rejected
                                                            ? t('research.trade.rowRejected', 'Rejected')
                                                            : row.needsReview
                                                                ? t('research.trade.rowReview', 'Review')
                                                                : t('research.trade.rowReady', 'Ready')}
                                                    </Badge>
                                                    {row.reviewReasons.length > 0 && (
                                                        <Text size="xs" c="dimmed" mt={4}>{row.reviewReasons.join('; ')}</Text>
                                                    )}
                                                </Table.Td>
                                            </Table.Tr>
                                        ))}
                                    </Table.Tbody>
                                </Table>
                            </Table.ScrollContainer>
                        </>
                    )}
                </Stack>
            </Paper>

            <Group justify="space-between">
                <Text fw={600}>{t('research.trade.history', 'Import history')}</Text>
                {batchesQuery.isFetching && <Loader size="xs" />}
            </Group>
            {selectedProjectId && batches.length === 0 && !batchesQuery.isLoading && (
                <Text size="sm" c="dimmed">{t('research.trade.empty', 'No customs CSV has been imported for this project.')}</Text>
            )}
            {batches.map((batch) => (
                <Paper key={batch.id} withBorder radius="md" p="sm">
                    <Group justify="space-between" align="flex-start" wrap="wrap">
                        <div>
                            <Text size="sm" fw={600}>{batch.file_name}</Text>
                            <Text size="xs" c="dimmed">{new Date(batch.created_at).toLocaleString(i18n.language)}</Text>
                        </div>
                        <Group gap="xs">
                            <Badge variant="light">{t('research.trade.total', '{{count}} rows', { count: batch.total_rows })}</Badge>
                            <Badge color="green" variant="light">{t('research.trade.seeded', '{{count}} seeded', { count: batch.processed_rows })}</Badge>
                            <Badge color="yellow" variant="light">{t('research.trade.review', '{{count}} review', { count: batch.review_rows })}</Badge>
                            <Badge color={STATUS_COLOR[batch.status]}>{t(`research.trade.status.${batch.status}`, batch.status)}</Badge>
                            <Button
                                size="xs"
                                leftSection={<IconSearch size={15} />}
                                disabled={batch.status !== 'processed' || batch.processed_rows < 1 || !icpId ||
                                    researchStatus === 'queued' || researchStatus === 'running'}
                                loading={researchMut.isPending && researchMut.variables === batch.id ||
                                    researchBatchId === batch.id && (researchStatus === 'queued' || researchStatus === 'running')}
                                onClick={() => researchMut.mutate(batch.id)}
                            >
                                {t('research.trade.research', 'Research')}
                            </Button>
                        </Group>
                    </Group>
                    {batch.status === 'failed' && batch.error && (
                        <Alert mt="sm" color="red" icon={<IconAlertCircle size={16} />} py="xs">
                            {batch.error}
                        </Alert>
                    )}
                </Paper>
            ))}
            {batchPages > 1 && (
                <Group justify="center">
                    <Pagination value={batchPage} onChange={setBatchPage} total={batchPages} />
                </Group>
            )}
        </Stack>
    );
}
