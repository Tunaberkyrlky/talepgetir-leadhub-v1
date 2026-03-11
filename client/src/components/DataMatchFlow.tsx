import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
    Stepper,
    Group,
    Button,
    Paper,
    Text,
    Table,
    Select,
    Badge,
    Stack,
    Alert,
    SimpleGrid,
    ThemeIcon,
    Card,
    Box,
    Accordion,
} from '@mantine/core';
import { Dropzone, MIME_TYPES } from '@mantine/dropzone';
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
    IconLink,
    IconKey,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { useImportProgress } from '../contexts/ImportProgressContext';

interface MappingSuggestion {
    fileHeader: string;
    dbField: string | null;
    table: string | null;
    field: string | null;
    confidence: number;
    required: boolean;
}

interface AvailableField {
    value: string;
    label: string;
    table: string;
    field: string;
    required: boolean;
}

interface MatchStrategy {
    type: 'id_key' | 'website' | 'none';
    companyCol: string;
    peopleCol: string;
}

interface MatchPreviewData {
    matchStrategy: MatchStrategy;
    matchedCount: number;
    unmatchedPeopleCount: number;
    unmatchedPeople: Record<string, string>[];
    totalCompanyRows: number;
    totalPeopleRows: number;
    filePath: string;
    fileName: string;
    fileType: string;
    totalRows: number;
    headers: string[];
    suggestions: MappingSuggestion[];
    availableFields: AvailableField[];
    previewRows: Record<string, string>[];
}

interface ImportResult {
    importJobId: string;
    totalRows: number;
    successCount: number;
    errorCount: number;
    errors: { row: number; field: string; error: string }[];
    createdCompanies: number;
    updatedCompanies: number;
    createdContacts: number;
    cancelled?: boolean;
}

export default function DataMatchFlow() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { startImport, finishImport, cancelImport } = useImportProgress();
    const [active, setActive] = useState(0);
    const [companyFile, setCompanyFile] = useState<File | null>(null);
    const [peopleFile, setPeopleFile] = useState<File | null>(null);
    const [previewData, setPreviewData] = useState<MatchPreviewData | null>(null);
    const [mapping, setMapping] = useState<Record<string, string | null>>({});
    const [importResult, setImportResult] = useState<ImportResult | null>(null);

    // Match upload mutation
    const matchMutation = useMutation({
        mutationFn: async ({ company, people }: { company: File; people: File }) => {
            const formData = new FormData();
            formData.append('companyFile', company);
            formData.append('peopleFile', people);
            const res = await api.post('/import/match-preview', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            return res.data as MatchPreviewData;
        },
        onSuccess: (data) => {
            setPreviewData(data);
            const initialMapping: Record<string, string | null> = {};
            data.suggestions.forEach((s) => {
                initialMapping[s.fileHeader] = s.dbField;
            });
            setMapping(initialMapping);
            setActive(1);
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

            // Step 3: Execute import
            const res = await api.post('/import/execute', {
                filePath: previewData!.filePath,
                fileName: previewData!.fileName,
                fileType: previewData!.fileType,
                mapping,
                jobId,
            });
            return res.data as ImportResult;
        },
        onSuccess: (data) => {
            finishImport(data);
            if (!data.cancelled) {
                setImportResult(data);
                setActive(4);
            }
        },
        onError: () => {
            cancelImport();
        },
    });

    const handleCompanyDrop = useCallback((files: File[]) => {
        if (files.length > 0) setCompanyFile(files[0]);
    }, []);

    const handlePeopleDrop = useCallback((files: File[]) => {
        if (files.length > 0) setPeopleFile(files[0]);
    }, []);

    const handleUpload = () => {
        if (companyFile && peopleFile) {
            matchMutation.mutate({ company: companyFile, people: peopleFile });
        }
    };

    const handleMappingChange = (fileHeader: string, dbField: string | null) => {
        setMapping((prev) => ({ ...prev, [fileHeader]: dbField }));
    };

    const getConfidenceBadge = (confidence: number) => {
        if (confidence >= 0.8) return <Badge color="green" size="sm">{'\u2713'} {t('import.confidenceHigh', 'Y\u00fcksek')}</Badge>;
        if (confidence >= 0.6) return <Badge color="yellow" size="sm">~ {t('import.confidenceMedium', 'Orta')}</Badge>;
        return <Badge color="gray" size="sm">? {t('import.confidenceManual', 'Manuel')}</Badge>;
    };

    const availableFieldOptions = (() => {
        if (!previewData) return [];
        const companyFields = previewData.availableFields.filter((f) => f.table === 'companies');
        const contactFields = previewData.availableFields.filter((f) => f.table === 'contacts');
        const groups = [];
        if (companyFields.length > 0) {
            groups.push({ group: 'Şirket', items: companyFields.map((f) => ({ value: f.value, label: f.label })) });
        }
        if (contactFields.length > 0) {
            groups.push({ group: 'Kişi', items: contactFields.map((f) => ({ value: f.value, label: f.label })) });
        }
        return groups;
    })();

    const dropzoneAccept = [MIME_TYPES.csv, MIME_TYPES.xlsx, 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

    const dropzoneStyles = {
        root: {
            minHeight: 180,
            display: 'flex' as const,
            alignItems: 'center' as const,
            justifyContent: 'center' as const,
            borderWidth: 2,
            borderStyle: 'dashed' as const,
        },
    };

    const resetAll = () => {
        setActive(0);
        setCompanyFile(null);
        setPeopleFile(null);
        setPreviewData(null);
        setImportResult(null);
        setMapping({});
    };

    return (
        <Stepper
            active={active}
            onStepClick={(step) => { if (step < active) setActive(step); }}
            color="violet"
            mb="xl"
        >
            {/* Step 1: Upload Two Files */}
            <Stepper.Step label={t('import.matchUploadStep', 'Dosya Y\u00fckle')} icon={<IconUpload size={18} />}>
                <Paper shadow="sm" radius="lg" p="xl" withBorder>
                    <SimpleGrid cols={2}>
                        {/* Company File */}
                        <Stack gap="sm">
                            <Text fw={600} ta="center">
                                <IconBuildingSkyscraper size={16} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                                {t('import.companyFile', '\u015eirket Dosyas\u0131')}
                            </Text>
                            <Dropzone
                                onDrop={handleCompanyDrop}
                                maxSize={10 * 1024 * 1024}
                                accept={dropzoneAccept}
                                radius="lg"
                                styles={dropzoneStyles}
                            >
                                <Stack align="center" gap="xs">
                                    <Dropzone.Accept>
                                        <IconFileSpreadsheet size={40} color="var(--mantine-color-violet-6)" />
                                    </Dropzone.Accept>
                                    <Dropzone.Reject>
                                        <IconX size={40} color="var(--mantine-color-red-6)" />
                                    </Dropzone.Reject>
                                    <Dropzone.Idle>
                                        <IconBuildingSkyscraper size={40} color="var(--mantine-color-dimmed)" />
                                    </Dropzone.Idle>
                                    <Text size="sm" c="dimmed">
                                        {companyFile ? companyFile.name : t('import.uploadCompanyFile', '\u015eirket dosyas\u0131 y\u00fckleyin')}
                                    </Text>
                                </Stack>
                            </Dropzone>
                            {companyFile && (
                                <Badge color="green" variant="light" size="lg" fullWidth>
                                    {companyFile.name}
                                </Badge>
                            )}
                        </Stack>

                        {/* People File */}
                        <Stack gap="sm">
                            <Text fw={600} ta="center">
                                <IconUsers size={16} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                                {t('import.peopleFile', 'Ki\u015fi Dosyas\u0131')}
                            </Text>
                            <Dropzone
                                onDrop={handlePeopleDrop}
                                maxSize={10 * 1024 * 1024}
                                accept={dropzoneAccept}
                                radius="lg"
                                styles={dropzoneStyles}
                            >
                                <Stack align="center" gap="xs">
                                    <Dropzone.Accept>
                                        <IconFileSpreadsheet size={40} color="var(--mantine-color-violet-6)" />
                                    </Dropzone.Accept>
                                    <Dropzone.Reject>
                                        <IconX size={40} color="var(--mantine-color-red-6)" />
                                    </Dropzone.Reject>
                                    <Dropzone.Idle>
                                        <IconUsers size={40} color="var(--mantine-color-dimmed)" />
                                    </Dropzone.Idle>
                                    <Text size="sm" c="dimmed">
                                        {peopleFile ? peopleFile.name : t('import.uploadPeopleFile', 'Ki\u015fi dosyas\u0131 y\u00fckleyin')}
                                    </Text>
                                </Stack>
                            </Dropzone>
                            {peopleFile && (
                                <Badge color="green" variant="light" size="lg" fullWidth>
                                    {peopleFile.name}
                                </Badge>
                            )}
                        </Stack>
                    </SimpleGrid>

                    <Text size="xs" c="dimmed" ta="center" mt="md">
                        {t('import.uploadLimit')}
                    </Text>

                    <Group justify="flex-end" mt="xl">
                        <Button
                            onClick={handleUpload}
                            loading={matchMutation.isPending}
                            disabled={!companyFile || !peopleFile}
                            color="violet"
                            rightSection={<IconArrowRight size={16} />}
                        >
                            {t('import.matchAndContinue', 'E\u015fle\u015ftir ve Devam Et')}
                        </Button>
                    </Group>

                    {matchMutation.isError && (
                        <Alert color="red" mt="md" icon={<IconAlertCircle />}>
                            {(matchMutation.error as any)?.response?.data?.error || t('common.error')}
                        </Alert>
                    )}
                </Paper>
            </Stepper.Step>

            {/* Step 2: Match Results */}
            <Stepper.Step label={t('import.matchResultStep', 'E\u015fle\u015fme')} icon={<IconLink size={18} />}>
                <Paper shadow="sm" radius="lg" p="xl" withBorder>
                    {previewData && (
                        <Stack gap="lg">
                            {/* Strategy Badge */}
                            <Group justify="center">
                                {previewData.matchStrategy.type === 'id_key' ? (
                                    <Badge color="green" size="lg" leftSection={<IconKey size={14} />}>
                                        {t('import.matchById', 'ID/Key kolonu ile e\u015fle\u015ftirildi')}
                                        {' '}({previewData.matchStrategy.companyCol} \u2194 {previewData.matchStrategy.peopleCol})
                                    </Badge>
                                ) : previewData.matchStrategy.type === 'website' ? (
                                    <Badge color="blue" size="lg" leftSection={<IconLink size={14} />}>
                                        {t('import.matchByWebsite', 'Website ile e\u015fle\u015ftirildi')}
                                        {' '}({previewData.matchStrategy.companyCol} \u2194 {previewData.matchStrategy.peopleCol})
                                    </Badge>
                                ) : (
                                    <Badge color="red" size="lg" leftSection={<IconAlertCircle size={14} />}>
                                        {t('import.matchNone', 'E\u015fle\u015ftirme kolonu bulunamad\u0131')}
                                    </Badge>
                                )}
                            </Group>

                            {/* Stats */}
                            <SimpleGrid cols={4}>
                                <Card shadow="xs" radius="md" p="md" withBorder>
                                    <Text size="xl" fw={700} ta="center">{previewData.totalCompanyRows}</Text>
                                    <Text size="sm" c="dimmed" ta="center">{t('import.companyFile', '\u015eirket')}</Text>
                                </Card>
                                <Card shadow="xs" radius="md" p="md" withBorder>
                                    <Text size="xl" fw={700} ta="center">{previewData.totalPeopleRows}</Text>
                                    <Text size="sm" c="dimmed" ta="center">{t('import.peopleFile', 'Ki\u015fi')}</Text>
                                </Card>
                                <Card shadow="xs" radius="md" p="md" withBorder>
                                    <Text size="xl" fw={700} ta="center" c="green">{previewData.matchedCount}</Text>
                                    <Text size="sm" c="dimmed" ta="center">{t('import.matchedCount', 'E\u015fle\u015fen')}</Text>
                                </Card>
                                <Card shadow="xs" radius="md" p="md" withBorder>
                                    <Text size="xl" fw={700} ta="center" c={previewData.unmatchedPeopleCount > 0 ? 'orange' : 'green'}>
                                        {previewData.unmatchedPeopleCount}
                                    </Text>
                                    <Text size="sm" c="dimmed" ta="center">{t('import.unmatchedPeople', 'E\u015fle\u015fmeyen Ki\u015fi')}</Text>
                                </Card>
                            </SimpleGrid>

                            {/* No match error */}
                            {previewData.matchStrategy.type === 'none' && (
                                <Alert color="red" icon={<IconAlertCircle />}>
                                    {t('import.matchNoneDesc', 'Her iki dosyada da ortak bir ID/Key veya Website kolonu bulunamad\u0131. L\u00fctfen dosyalar\u0131n\u0131z\u0131 kontrol edin.')}
                                </Alert>
                            )}

                            {/* Strategy found but zero rows matched */}
                            {previewData.matchStrategy.type !== 'none' && previewData.matchedCount === 0 && (
                                <Alert color="orange" icon={<IconAlertCircle />}>
                                    {t('import.matchZeroRows', 'E\u015fle\u015ftirme kolonu bulundu ancak hi\u00e7bir sat\u0131r e\u015fle\u015fmedi. Dosyalardaki anahtar de\u011ferlerin (\u00f6rn. website/ID) \u00f6rt\u00fc\u015ft\u00fc\u011f\u00fcn\u00fc kontrol edin.')}
                                </Alert>
                            )}

                            {/* Unmatched people accordion */}
                            {previewData.unmatchedPeopleCount > 0 && previewData.matchStrategy.type !== 'none' && (
                                <Accordion variant="contained" radius="md">
                                    <Accordion.Item value="unmatched">
                                        <Accordion.Control>
                                            <Text fw={500} c="orange">
                                                {t('import.orphanWarning', 'Bu ki\u015filer hi\u00e7bir \u015firketle e\u015fle\u015ftirilemedi')}
                                                {' '}({previewData.unmatchedPeopleCount})
                                            </Text>
                                        </Accordion.Control>
                                        <Accordion.Panel>
                                            <Box style={{ overflowX: 'auto' }}>
                                                <Table striped highlightOnHover>
                                                    <Table.Thead>
                                                        <Table.Tr>
                                                            {previewData.unmatchedPeople.length > 0 &&
                                                                Object.keys(previewData.unmatchedPeople[0]).map((h) => (
                                                                    <Table.Th key={h}>{h}</Table.Th>
                                                                ))
                                                            }
                                                        </Table.Tr>
                                                    </Table.Thead>
                                                    <Table.Tbody>
                                                        {previewData.unmatchedPeople.map((row, i) => (
                                                            <Table.Tr key={i}>
                                                                {Object.values(row).map((val, j) => (
                                                                    <Table.Td key={j}>
                                                                        <Text size="xs" lineClamp={1} maw={150}>{val || '\u2014'}</Text>
                                                                    </Table.Td>
                                                                ))}
                                                            </Table.Tr>
                                                        ))}
                                                    </Table.Tbody>
                                                </Table>
                                            </Box>
                                        </Accordion.Panel>
                                    </Accordion.Item>
                                </Accordion>
                            )}

                            <Text size="sm" c="dimmed" ta="center">
                                {t('import.mergedRows', 'Toplam birle\u015ftirilen sat\u0131r')}: {previewData.totalRows}
                            </Text>

                            <Group justify="flex-end">
                                <Button variant="default" onClick={() => setActive(0)} leftSection={<IconArrowLeft size={16} />}>
                                    {t('common.cancel')}
                                </Button>
                                <Button
                                    onClick={() => setActive(2)}
                                    color="violet"
                                    rightSection={<IconArrowRight size={16} />}
                                    disabled={previewData.matchStrategy.type === 'none' || previewData.matchedCount === 0}
                                >
                                    {t('import.step2')}
                                </Button>
                            </Group>
                        </Stack>
                    )}
                </Paper>
            </Stepper.Step>

            {/* Step 3: Map Columns */}
            <Stepper.Step label={t('import.step2')} icon={<IconFileSpreadsheet size={18} />}>
                <Paper shadow="sm" radius="lg" p="xl" withBorder>
                    <Text fw={600} mb="md">
                        {previewData?.fileName} — {previewData?.totalRows} {t('import.totalRows').toLowerCase()}
                    </Text>

                    <Table striped highlightOnHover>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th style={{ width: 32 }} />
                                <Table.Th>{t('import.fileColumn')}</Table.Th>
                                <Table.Th>{t('import.dbField')}</Table.Th>
                                <Table.Th>{t('import.confidence')}</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {previewData?.suggestions.map((s) => {
                                const usedInOtherRows = new Set(
                                    Object.entries(mapping)
                                        .filter(([key, val]) => key !== s.fileHeader && val)
                                        .map(([, val]) => val as string)
                                );
                                const filteredOptions = [
                                    { value: '', label: `— ${t('import.unmapped')}` },
                                    ...availableFieldOptions.map((g) => ({
                                        group: g.group,
                                        items: g.items.filter((opt) => !usedInOtherRows.has(opt.value)),
                                    })).filter((g) => g.items.length > 0),
                                ];
                                const isMapped = !!mapping[s.fileHeader];
                                return (
                                    <Table.Tr key={s.fileHeader}>
                                        <Table.Td>
                                            {isMapped && (
                                                <IconArrowRight size={18} color="var(--mantine-color-violet-6)" />
                                            )}
                                        </Table.Td>
                                        <Table.Td>
                                            <Text fw={500} size="sm">
                                                {s.fileHeader}
                                                {s.required && <Text span c="red" ml={4}>*</Text>}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Select
                                                size="sm"
                                                radius="md"
                                                value={mapping[s.fileHeader] || ''}
                                                onChange={(val) => handleMappingChange(s.fileHeader, val || null)}
                                                data={filteredOptions}
                                                clearable
                                                searchable
                                            />
                                        </Table.Td>
                                        <Table.Td>
                                            {getConfidenceBadge(s.confidence)}
                                        </Table.Td>
                                    </Table.Tr>
                                );
                            })}
                        </Table.Tbody>
                    </Table>

                    <Group justify="flex-end" mt="xl">
                        <Button variant="default" onClick={() => setActive(1)} leftSection={<IconArrowLeft size={16} />}>
                            {t('common.cancel')}
                        </Button>
                        <Button onClick={() => setActive(3)} rightSection={<IconArrowRight size={16} />} color="violet">
                            {t('import.step3')}
                        </Button>
                    </Group>
                </Paper>
            </Stepper.Step>

            {/* Step 4: Preview */}
            <Stepper.Step label={t('import.step3')} icon={<IconCheck size={18} />}>
                <Paper shadow="sm" radius="lg" p="xl" withBorder>
                    <Text fw={600} mb="md">
                        {t('import.preview')}
                    </Text>

                    <Box style={{ overflowX: 'auto' }}>
                        <Table striped highlightOnHover>
                            <Table.Thead>
                                <Table.Tr>
                                    {previewData?.headers.map((h) => (
                                        <Table.Th key={h}>
                                            <Stack gap={2}>
                                                <Text size="xs" c="dimmed">{h}</Text>
                                                <Text size="xs" fw={600} c={mapping[h] ? 'violet' : 'gray'}>
                                                    {'\u2192'} {mapping[h] || t('import.unmapped')}
                                                </Text>
                                            </Stack>
                                        </Table.Th>
                                    ))}
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {previewData?.previewRows.map((row, i) => (
                                    <Table.Tr key={i}>
                                        {previewData.headers.map((h) => (
                                            <Table.Td key={h}>
                                                <Text size="sm" lineClamp={1} maw={200}>
                                                    {row[h] || '\u2014'}
                                                </Text>
                                            </Table.Td>
                                        ))}
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </Box>

                    <Group justify="flex-end" mt="xl">
                        <Button variant="default" onClick={() => setActive(2)} leftSection={<IconArrowLeft size={16} />}>
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
                            {(executeMutation.error as any)?.response?.data?.error || t('common.error')}
                        </Alert>
                    )}
                </Paper>
            </Stepper.Step>

            {/* Step 5: Results */}
            <Stepper.Step label={t('import.step4')} icon={<IconCheck size={18} />}>
                {importResult && (
                    <Stack gap="lg">
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

                        <Group justify="center">
                            <Button
                                variant="default"
                                onClick={() => navigate('/')}
                                leftSection={<IconArrowLeft size={16} />}
                            >
                                {t('import.backToLeads')}
                            </Button>
                            <Button
                                onClick={resetAll}
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
    );
}
