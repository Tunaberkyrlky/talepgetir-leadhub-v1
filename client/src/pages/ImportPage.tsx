import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
    Container,
    Title,
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
    Tabs,
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
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import DataMatchFlow from '../components/DataMatchFlow';

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

interface PreviewData {
    fileName: string;
    fileType: string;
    filePath: string;
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
}

export default function ImportPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [active, setActive] = useState(0);
    const [previewData, setPreviewData] = useState<PreviewData | null>(null);
    const [mapping, setMapping] = useState<Record<string, string | null>>({});
    const [importResult, setImportResult] = useState<ImportResult | null>(null);

    // Upload mutation
    const uploadMutation = useMutation({
        mutationFn: async (file: File) => {
            const formData = new FormData();
            formData.append('file', file);
            const res = await api.post('/import/preview', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            return res.data as PreviewData;
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
    });

    // Execute import mutation
    const executeMutation = useMutation({
        mutationFn: async () => {
            const res = await api.post('/import/execute', {
                filePath: previewData!.filePath,
                fileName: previewData!.fileName,
                fileType: previewData!.fileType,
                mapping,
            });
            return res.data as ImportResult;
        },
        onSuccess: (data) => {
            setImportResult(data);
            setActive(3);
        },
    });

    const handleDrop = useCallback((files: File[]) => {
        if (files.length > 0) {
            uploadMutation.mutate(files[0]);
        }
    }, []);

    const handleMappingChange = (fileHeader: string, dbField: string | null) => {
        setMapping((prev) => ({ ...prev, [fileHeader]: dbField }));
    };

    const getConfidenceBadge = (confidence: number) => {
        if (confidence >= 0.8) return <Badge color="green" size="sm">✓ Yüksek</Badge>;
        if (confidence >= 0.6) return <Badge color="yellow" size="sm">~ Orta</Badge>;
        return <Badge color="gray" size="sm">? Manuel</Badge>;
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
                        {t('import.singleImportTab', 'Tekli Dosya')}
                    </Tabs.Tab>
                    <Tabs.Tab value="match" leftSection={<IconUsers size={16} />}>
                        {t('import.matchTab', 'Veri Eşleştirme')}
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
            >
                {/* Step 1: Upload */}
                <Stepper.Step label={t('import.step1')} icon={<IconUpload size={18} />}>
                    <Paper shadow="sm" radius="lg" p="xl" withBorder>
                        <Dropzone
                            onDrop={handleDrop}
                            maxSize={10 * 1024 * 1024}
                            accept={[MIME_TYPES.csv, MIME_TYPES.xlsx, 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']}
                            loading={uploadMutation.isPending}
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

                        {uploadMutation.isError && (
                            <Alert color="red" mt="md" icon={<IconAlertCircle />}>
                                {(uploadMutation.error as any)?.response?.data?.error || t('common.error')}
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
                            <Button variant="default" onClick={() => setActive(0)} leftSection={<IconArrowLeft size={16} />}>
                                {t('common.cancel')}
                            </Button>
                            <Button onClick={() => setActive(2)} rightSection={<IconArrowRight size={16} />} color="violet">
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
                                        {previewData?.headers.map((h) => (
                                            <Table.Th key={h}>
                                                <Stack gap={2}>
                                                    <Text size="xs" c="dimmed">{h}</Text>
                                                    <Text size="xs" fw={600} c={mapping[h] ? 'violet' : 'gray'}>
                                                        → {mapping[h] || t('import.unmapped')}
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
                                {(executeMutation.error as any)?.response?.data?.error || t('common.error')}
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
        </Container>
    );
}
