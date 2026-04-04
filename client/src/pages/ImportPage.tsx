import { useState, useCallback, useMemo } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
    Container,
    Title,
    Stepper,
    Group,
    Button,
    Paper,
    Text,
    Table,
    Stack,
    Alert,
    SimpleGrid,
    ThemeIcon,
    Card,
    Box,
    Tabs,
    TextInput,
    Progress,
    LoadingOverlay,
    Loader,
    Badge,
    Tooltip,
    Skeleton,
} from '@mantine/core';
import { Dropzone, MIME_TYPES } from '@mantine/dropzone';
import { useDisclosure } from '@mantine/hooks';
import {
    IconUpload,
    IconFileSpreadsheet,
    IconX,
    IconCheck,
    IconArrowLeft,
    IconArrowRight,
    IconAlertCircle,
    IconBuildingSkyscraper,
    IconRefresh,
    IconUsers,
    IconHistory,
    IconChevronDown,
    IconChevronRight,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { showErrorFromApi, getErrorMessage } from '../lib/notifications';
import DataMatchFlow from '../components/DataMatchFlow';
import MappingEditor from '../components/MappingEditor';
import { useImportProgress } from '../contexts/ImportProgressContext';
import { useAuth } from '../contexts/AuthContext';
import type { MappingSuggestion, AvailableField, ImportResult } from '../types/import';

interface ImportJob {
    id: string;
    file_name: string;
    file_type: string;
    status: string;
    total_rows: number;
    success_count: number;
    error_count: number;
    created_at: string;
    completed_at: string | null;
}

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

export default function ImportPage() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const [active, setActive] = useState(0);
    const [previewData, setPreviewData] = useState<PreviewData | null>(null);
    const [mapping, setMapping] = useState<Record<string, string | null>>({});
    const [importResult, setImportResult] = useState<ImportResult | null>(null);
    const [defaultCompanyName, setDefaultCompanyName] = useState('');
    const [dropRejectError, setDropRejectError] = useState<string | null>(null);
    const [uploadProgress, setUploadProgress] = useState(0);
    const { startImport, finishImport, cancelImport } = useImportProgress();
    const { activeTenantId } = useAuth();
    const [historyOpened, { toggle: toggleHistory }] = useDisclosure(false);

    const { data: importJobs, isLoading: jobsLoading } = useQuery({
        queryKey: ['import', 'jobs', activeTenantId],
        queryFn: async () => {
            const res = await api.get('/import/jobs');
            return res.data.data as ImportJob[];
        },
    });

    const missingRequired = useMemo(() =>
        previewData?.availableFields
            .filter((f) => f.required)
            .filter((f) => !Object.values(mapping).includes(f.value)) || [],
        [previewData, mapping]
    );

    const sortedPreviewHeaders = useMemo(() => {
        const headers = previewData?.headers || [];
        const mapped = headers.filter((h) => !!mapping[h]);
        const unmapped = headers.filter((h) => !mapping[h]);
        return [...mapped, ...unmapped];
    }, [previewData, mapping]);

    // Upload mutation
    const uploadMutation = useMutation({
        mutationFn: async (file: File) => {
            const formData = new FormData();
            formData.append('file', file);
            const res = await api.post('/import/preview', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
                onUploadProgress: (progressEvent) => {
                    if (progressEvent.total) {
                        const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                        setUploadProgress(percent);
                    }
                },
            });
            return res.data as PreviewData;
        },
        onMutate: () => {
            setUploadProgress(0);
        },
        onSuccess: (data) => {
            setPreviewData(data);
            // Initialize mapping from suggestions
            const initialMapping: Record<string, string | null> = {};
            data.suggestions.forEach((s) => {
                initialMapping[s.fileHeader] = s.dbField;
            });
            setMapping(initialMapping);
            setActive(1);
        },
        onError: (err) => {
            showErrorFromApi(err, t('import.uploadError'));
        },
    });

    // Execute import mutation
    const executeMutation = useMutation({
        mutationFn: async () => {
            // Step 1: Pre-create job record → get jobId for progress polling
            const beginRes = await api.post('/import/begin', {
                fileName: previewData!.fileName,
                fileType: previewData!.fileType,
                totalRows: previewData!.totalRows,
                mapping,
            });
            const { jobId } = beginRes.data;

            // Step 2: Start polling progress bar
            startImport(jobId, previewData!.totalRows, previewData!.fileName);

            // Step 3: Execute import (geocoding removed — fits within Vercel 30s)
            const res = await api.post('/import/execute', {
                fileId: previewData!.fileId,
                fileName: previewData!.fileName,
                fileType: previewData!.fileType,
                mapping,
                jobId,
                defaultCompanyName: defaultCompanyName.trim() || undefined,
            });
            return res.data as ImportResult;
        },
        onSuccess: (data) => {
            finishImport(data);
            if (!data.cancelled) {
                setImportResult(data);
                setActive(3);
            }
        },
        onError: (err) => {
            showErrorFromApi(err, t('import.importError'));
            cancelImport();
        },
    });

    const handleDrop = useCallback((files: File[]) => {
        if (files.length > 0) {
            setDropRejectError(null);
            uploadMutation.mutate(files[0]);
        }
    }, []);

    const handleReject = useCallback((fileRejections: import('@mantine/dropzone').FileRejection[]) => {
        const rejection = fileRejections[0];
        if (!rejection) return;
        const code = rejection.errors[0]?.code;
        if (code === 'file-too-large') {
            setDropRejectError(t('import.fileTooLarge', 'Dosya boyutu 10 MB sınırını aşıyor. Lütfen daha küçük bir dosya seçin.'));
        } else if (code === 'file-invalid-type') {
            setDropRejectError(t('import.fileInvalidType', 'Geçersiz dosya türü. Yalnızca .csv ve .xlsx dosyaları desteklenmektedir.'));
        } else {
            setDropRejectError(t('import.fileRejected', 'Dosya kabul edilmedi. Boyutunu ve formatını kontrol edin.'));
        }
    }, [t]);

    const handleMappingChange = (fileHeader: string, dbField: string | null) => {
        setMapping((prev) => ({ ...prev, [fileHeader]: dbField }));
    };


    return (
        <Container size="lg" py="lg">
            <Button
                variant="subtle"
                color="gray"
                leftSection={<IconArrowLeft size={16} />}
                onClick={() => navigate('/')}
                mb="xs"
                px={0}
            >
                {t('common.back')}
            </Button>
            <Title order={2} fw={700} mb="xl">
                {t('import.title')}
            </Title>

            <Tabs defaultValue="single" color="violet" mb="xl">
                <Tabs.List mb="lg">
                    <Tabs.Tab value="single" leftSection={<IconFileSpreadsheet size={16} />}>
                        {t('import.singleImportTab')}
                    </Tabs.Tab>
                    <Tabs.Tab value="match" leftSection={<IconUsers size={16} />}>
                        {t('import.matchTab')}
                    </Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="single">
            <Stepper
                active={active}
                onStepClick={(step) => {
                    if (step < active) setActive(step);
                }}
                color="violet"
                mb="xl"
                styles={{
                    stepIcon: {
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingTop: 3,
                    },
                }}
            >
                {/* Step 1: Upload */}
                <Stepper.Step label={t('import.step1')} icon={<IconUpload size={18} />}>
                    <Paper shadow="sm" radius="lg" p="xl" withBorder pos="relative">
                        <LoadingOverlay 
                            visible={uploadMutation.isPending} 
                            zIndex={1000} 
                            overlayProps={{ radius: 'lg', blur: 2 }} 
                            loaderProps={{ 
                                children: (
                                    <Stack align="center" gap="sm">
                                        <Loader size="md" color="violet" />
                                        <Text size="sm" fw={500}>
                                            {uploadProgress < 100 
                                                ? t('import.uploading', `Yükleniyor: %${uploadProgress}`)
                                                : t('import.analyzing', 'Dosya analiz ediliyor...')}
                                        </Text>
                                        {uploadProgress < 100 && (
                                            <Progress value={uploadProgress} w={200} color="violet" size="sm" radius="xl" striped animated />
                                        )}
                                    </Stack>
                                ) 
                            }} 
                        />
                        <Dropzone
                            onDrop={handleDrop}
                            onReject={handleReject}
                            maxSize={10 * 1024 * 1024}
                            accept={[MIME_TYPES.csv, MIME_TYPES.xlsx, 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']}
                            loading={false}
                            radius="lg"
                            styles={{
                                root: {
                                    minHeight: 200,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    borderWidth: 2,
                                    borderStyle: 'dashed',
                                },
                            }}
                        >
                            <Stack align="center" gap="sm">
                                <Dropzone.Accept>
                                    <IconFileSpreadsheet size={48} color="var(--mantine-color-violet-6)" />
                                </Dropzone.Accept>
                                <Dropzone.Reject>
                                    <IconX size={48} color="var(--mantine-color-red-6)" />
                                </Dropzone.Reject>
                                <Dropzone.Idle>
                                    <IconFileSpreadsheet size={48} color="var(--mantine-color-dimmed)" />
                                </Dropzone.Idle>
                                <Text size="lg" fw={500}>
                                    {t('import.uploadTitle')}
                                </Text>
                                <Text size="sm" c="dimmed">
                                    {t('import.uploadDesc')}
                                </Text>
                                <Text size="xs" c="dimmed">
                                    {t('import.uploadLimit')}
                                </Text>
                            </Stack>
                        </Dropzone>

                        {dropRejectError && (
                            <Alert color="red" mt="md" icon={<IconAlertCircle />} withCloseButton onClose={() => setDropRejectError(null)}>
                                {dropRejectError}
                            </Alert>
                        )}
                        {uploadMutation.isError && (
                            <Alert color="red" mt="md" icon={<IconAlertCircle />}>
                                {getErrorMessage(uploadMutation.error, t('import.uploadError'))}
                            </Alert>
                        )}
                    </Paper>
                </Stepper.Step>

                {/* Step 2: Map Columns */}
                <Stepper.Step label={t('import.step2')} icon={<IconFileSpreadsheet size={18} />}>
                    <Paper shadow="sm" radius="lg" p="xl" withBorder>
                        <Text fw={600} mb="md">
                            {previewData?.fileName} — {previewData?.totalRows} {t('import.totalRows').toLowerCase()}
                        </Text>

                        {previewData && (
                            <MappingEditor
                                suggestions={previewData.suggestions}
                                mapping={mapping}
                                availableFields={previewData.availableFields}
                                onMappingChange={handleMappingChange}
                                previewRows={previewData.previewRows}
                            />
                        )}

                        <TextInput
                            label={t('import.defaultCompanyName')}
                            description={t('import.defaultCompanyNameDesc')}
                            placeholder={t('import.defaultCompanyNamePlaceholder')}
                            value={defaultCompanyName}
                            onChange={(e) => setDefaultCompanyName(e.currentTarget.value)}
                            mt="lg"
                            leftSection={<IconBuildingSkyscraper size={16} />}
                        />

                        {missingRequired.length > 0 && (
                            <Alert color="orange" mt="md" icon={<IconAlertCircle size={16} />}>
                                {t('import.requiredFieldsMissing')}: {missingRequired.map((f) => f.label).join(', ')}
                            </Alert>
                        )}

                        <Group justify="flex-end" mt="xl">
                            <Button variant="default" onClick={() => setActive(0)} leftSection={<IconArrowLeft size={16} />}>
                                {t('common.cancel')}
                            </Button>
                            <Button
                                onClick={() => setActive(2)}
                                rightSection={<IconArrowRight size={16} />}
                                color="violet"
                                disabled={missingRequired.length > 0}
                            >
                                {t('import.step3')}
                            </Button>
                        </Group>
                    </Paper>
                </Stepper.Step>

                {/* Step 3: Preview */}
                <Stepper.Step label={t('import.step3')} icon={<IconCheck size={18} />}>
                    <Paper shadow="sm" radius="lg" p="xl" withBorder>
                        <Text fw={600} mb="md">
                            {t('import.preview')}
                        </Text>

                        <Box style={{ overflowX: 'auto' }}>
                            <Table striped highlightOnHover>
                                <Table.Thead>
                                    <Table.Tr>
                                        {sortedPreviewHeaders.map((h) => (
                                            <Table.Th key={h}>
                                                <Stack gap={2}>
                                                    <Text size="xs" fw={600} c={mapping[h] ? 'violet' : 'gray'}>
                                                        {mapping[h] || t('import.unmapped')}
                                                    </Text>
                                                    <Text size="xs" c="dimmed">
                                                        ← {h}
                                                    </Text>
                                                </Stack>
                                            </Table.Th>
                                        ))}
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    {previewData?.previewRows.map((row, i) => (
                                        <Table.Tr key={i}>
                                            {sortedPreviewHeaders.map((h) => (
                                                <Table.Td key={h}>
                                                    <Text size="sm" lineClamp={1} maw={200}>
                                                        {row[h] || '—'}
                                                    </Text>
                                                </Table.Td>
                                            ))}
                                        </Table.Tr>
                                    ))}
                                </Table.Tbody>
                            </Table>
                        </Box>

                        <Group justify="flex-end" mt="xl">
                            <Button variant="default" onClick={() => setActive(1)} leftSection={<IconArrowLeft size={16} />}>
                                {t('import.step2')}
                            </Button>
                            <Button
                                onClick={() => executeMutation.mutate()}
                                loading={executeMutation.isPending}
                                color="violet"
                                rightSection={<IconCheck size={16} />}
                            >
                                {executeMutation.isPending ? t('import.importing') : t('import.startImport')}
                            </Button>
                        </Group>

                        {executeMutation.isError && (
                            <Alert color="red" mt="md" icon={<IconAlertCircle />}>
                                {getErrorMessage(executeMutation.error, t('import.importError'))}
                            </Alert>
                        )}
                    </Paper>
                </Stepper.Step>

                {/* Step 4: Result */}
                <Stepper.Step label={t('import.step4')} icon={<IconCheck size={18} />}>
                    {importResult && (
                        <Stack gap="lg">
                            {/* Summary Cards */}
                            <SimpleGrid cols={3}>
                                <Card shadow="sm" radius="lg" p="lg" withBorder>
                                    <Group>
                                        <ThemeIcon size={48} radius="lg" variant="light" color="green">
                                            <IconCheck size={24} />
                                        </ThemeIcon>
                                        <div>
                                            <Text size="xl" fw={700}>{importResult.successCount}</Text>
                                            <Text size="sm" c="dimmed">{t('import.successCount')}</Text>
                                        </div>
                                    </Group>
                                </Card>
                                <Card shadow="sm" radius="lg" p="lg" withBorder>
                                    <Group>
                                        <ThemeIcon size={48} radius="lg" variant="light" color="blue">
                                            <IconBuildingSkyscraper size={24} />
                                        </ThemeIcon>
                                        <div>
                                            <Text size="xl" fw={700}>
                                                {importResult.createdCompanies} / {importResult.updatedCompanies}
                                            </Text>
                                            <Text size="sm" c="dimmed">
                                                {t('import.createdCompanies')} / {t('import.updatedCompanies')}
                                            </Text>
                                        </div>
                                    </Group>
                                </Card>
                                <Card shadow="sm" radius="lg" p="lg" withBorder>
                                    <Group>
                                        <ThemeIcon size={48} radius="lg" variant="light" color="violet">
                                            <IconUsers size={24} />
                                        </ThemeIcon>
                                        <div>
                                            <Text size="xl" fw={700}>{importResult.createdContacts}</Text>
                                            <Text size="sm" c="dimmed">{t('import.createdContacts')}</Text>
                                        </div>
                                    </Group>
                                </Card>
                            </SimpleGrid>

                            {/* Errors */}
                            {importResult.errors.length > 0 && (
                                <Paper shadow="sm" radius="lg" p="lg" withBorder>
                                    <Text fw={600} mb="md" c="red">
                                        {t('import.errors')} ({importResult.errorCount})
                                    </Text>
                                    <Table striped>
                                        <Table.Thead>
                                            <Table.Tr>
                                                <Table.Th>{t('import.errorRow')}</Table.Th>
                                                <Table.Th>{t('import.errorField')}</Table.Th>
                                                <Table.Th>{t('import.errorMessage')}</Table.Th>
                                            </Table.Tr>
                                        </Table.Thead>
                                        <Table.Tbody>
                                            {importResult.errors.slice(0, 20).map((err, i) => (
                                                <Table.Tr key={i}>
                                                    <Table.Td>{err.row}</Table.Td>
                                                    <Table.Td>{err.field}</Table.Td>
                                                    <Table.Td><Text size="sm" c="red">{err.error}</Text></Table.Td>
                                                </Table.Tr>
                                            ))}
                                        </Table.Tbody>
                                    </Table>
                                </Paper>
                            )}

                            {/* Actions */}
                            <Group justify="center">
                                <Button
                                    variant="default"
                                    onClick={() => navigate('/')}
                                    leftSection={<IconArrowLeft size={16} />}
                                >
                                    {t('import.backToLeads')}
                                </Button>
                                <Button
                                    onClick={() => {
                                        setActive(0);
                                        setPreviewData(null);
                                        setImportResult(null);
                                        setMapping({});
                                        setDefaultCompanyName('');
                                    }}
                                    leftSection={<IconRefresh size={16} />}
                                    color="violet"
                                >
                                    {t('import.importAnother')}
                                </Button>
                            </Group>
                        </Stack>
                    )}
                </Stepper.Step>
            </Stepper>
                </Tabs.Panel>

                <Tabs.Panel value="match">
                    <DataMatchFlow />
                </Tabs.Panel>
            </Tabs>
            {/* Import History — collapsible */}
            <Paper shadow="sm" radius="lg" withBorder mt="xl" style={{ overflow: 'hidden' }}>
                <Group
                    gap="xs"
                    p="md"
                    onClick={toggleHistory}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                >
                    {historyOpened ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}
                    <IconHistory size={18} color="var(--mantine-color-dimmed)" />
                    <Text fw={600} size="sm">{t('import.historyTitle')}</Text>
                    {!historyOpened && importJobs && importJobs.length > 0 && (
                        <Text size="xs" c="dimmed" ml={4}>— {importJobs[0].file_name}</Text>
                    )}
                </Group>

                {historyOpened && (
                    <Box px="md" pb="md">
                        {jobsLoading ? (
                            <Stack gap="xs">
                                {[...Array(3)].map((_, i) => <Skeleton key={i} height={36} radius="sm" />)}
                            </Stack>
                        ) : !importJobs || importJobs.length === 0 ? (
                            <Text size="sm" c="dimmed" ta="center" py="lg">{t('import.historyEmpty')}</Text>
                        ) : (
                            <Table striped highlightOnHover>
                                <Table.Thead>
                                    <Table.Tr>
                                        <Table.Th>{t('import.historyFileName')}</Table.Th>
                                        <Table.Th>{t('import.historyType')}</Table.Th>
                                        <Table.Th>{t('import.historyStatus')}</Table.Th>
                                        <Table.Th>{t('import.historyRows')}</Table.Th>
                                        <Table.Th>{t('import.historyDate')}</Table.Th>
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    {importJobs.map((job) => (
                                        <Table.Tr key={job.id}>
                                            <Table.Td>
                                                <Tooltip label={job.file_name} openDelay={300}>
                                                    <Text size="sm" fw={500} lineClamp={1} maw={300}>{job.file_name}</Text>
                                                </Tooltip>
                                            </Table.Td>
                                            <Table.Td>
                                                <Badge size="sm" variant="light" color={job.file_type === 'csv' ? 'blue' : job.file_type === 'matched' ? 'grape' : 'orange'}>
                                                    {job.file_type.toUpperCase()}
                                                </Badge>
                                            </Table.Td>
                                            <Table.Td>
                                                <Badge size="sm" variant="light" color={
                                                    job.status === 'completed' ? 'green' :
                                                    job.status === 'failed' ? 'red' :
                                                    job.status === 'cancelled' ? 'gray' :
                                                    job.status === 'processing' ? 'yellow' : 'blue'
                                                }>
                                                    {t(`import.status_${job.status}`, job.status)}
                                                </Badge>
                                            </Table.Td>
                                            <Table.Td>
                                                <Text size="sm">
                                                    {job.success_count}/{job.total_rows}
                                                    {job.error_count > 0 && (
                                                        <Text span size="xs" c="red" ml={4}>({job.error_count} {t('import.historyErrors')})</Text>
                                                    )}
                                                </Text>
                                            </Table.Td>
                                            <Table.Td>
                                                <Text size="xs" c="dimmed">
                                                    {new Date(job.created_at).toLocaleDateString(i18n.language === 'tr' ? 'tr-TR' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                                </Text>
                                            </Table.Td>
                                        </Table.Tr>
                                    ))}
                                </Table.Tbody>
                            </Table>
                        )}
                    </Box>
                )}
            </Paper>
        </Container>
    );
}
