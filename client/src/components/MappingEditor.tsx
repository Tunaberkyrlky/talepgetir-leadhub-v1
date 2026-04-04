import { Table, Text, Select, Badge, Divider, Group, Stack, Tooltip } from '@mantine/core';
import { IconArrowRight, IconLink, IconLinkOff, IconBuildingSkyscraper, IconUsers } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import type { MappingSuggestion, AvailableField } from '../types/import';

interface MappingEditorProps {
    suggestions: MappingSuggestion[];
    mapping: Record<string, string | null>;
    availableFields: AvailableField[];
    onMappingChange: (fileHeader: string, dbField: string | null) => void;
    companyHeaders?: string[];
    peopleHeaders?: string[];
    previewRows?: Record<string, string>[];
}

export default function MappingEditor({ suggestions, mapping, availableFields, onMappingChange, previewRows }: MappingEditorProps) {
    const { t } = useTranslation();
    const { user } = useAuth();

    // Inverse mapping: dbFieldValue → fileHeader
    const inverseMapping: Record<string, string> = {};
    for (const [fileHeader, dbField] of Object.entries(mapping)) {
        if (dbField) inverseMapping[dbField] = fileHeader;
    }

    // File headers already assigned to some DB field
    const usedFileHeaders = new Set(Object.values(inverseMapping));

    const getFieldLabel = (f: AvailableField): string => {
        if (f.field === 'custom_field_1' && user?.tenantSettings?.custom_field_1_label) {
            return `${user.tenantSettings.custom_field_1_label} (Custom)`;
        }
        if (f.field === 'custom_field_2' && user?.tenantSettings?.custom_field_2_label) {
            return `${user.tenantSettings.custom_field_2_label} (Custom)`;
        }
        if (f.field === 'custom_field_3' && user?.tenantSettings?.custom_field_3_label) {
            return `${user.tenantSettings.custom_field_3_label} (Custom)`;
        }
        return f.label;
    };

    const getConfidenceBadge = (confidence: number) => {
        if (confidence >= 0.8) return <Badge color="green" size="sm">✓ {t('import.confidenceHigh')}</Badge>;
        if (confidence >= 0.6) return <Badge color="yellow" size="sm">~ {t('import.confidenceMedium')}</Badge>;
        return <Badge color="gray" size="sm">? {t('import.confidenceManual')}</Badge>;
    };

    const getColumnValues = (fileHeader: string): string[] => {
        if (!previewRows || previewRows.length === 0) return [];
        const values = previewRows.map((row) => row[fileHeader]).filter((v) => v != null && v !== '');
        return [...new Set(values)];
    };

    const handleChange = (dbFieldValue: string, selectedFileHeader: string | null) => {
        // Unmap old file header for this DB field
        const prevFileHeader = inverseMapping[dbFieldValue];
        if (prevFileHeader) {
            onMappingChange(prevFileHeader, null);
        }
        if (selectedFileHeader) {
            onMappingChange(selectedFileHeader, dbFieldValue);
        }
    };

    const renderRow = (f: AvailableField) => {
        const dbFieldValue = f.value;
        const mappedFileHeader = inverseMapping[dbFieldValue] || null;
        const isMapped = !!mappedFileHeader;

        // Build file column options — disable headers already used by other DB fields
        const fileHeaderOptions = suggestions.map((s) => ({
            value: s.fileHeader,
            label: s.fileHeader,
            disabled: usedFileHeaders.has(s.fileHeader) && s.fileHeader !== mappedFileHeader,
        }));

        // Confidence: use suggestion confidence if the auto-suggested DB field matches current mapping
        const suggestion = suggestions.find((s) => s.fileHeader === mappedFileHeader);
        const confidence = suggestion && suggestion.dbField === dbFieldValue ? suggestion.confidence : (isMapped ? 0.5 : 0);

        return (
            <Table.Tr key={dbFieldValue}>
                <Table.Td style={{ width: 32 }}>
                    {isMapped && <IconArrowRight size={18} color="var(--mantine-color-violet-6)" />}
                </Table.Td>
                <Table.Td style={{ width: '38%' }}>
                    <Group gap="xs">
                        {f.table === 'companies'
                            ? <IconBuildingSkyscraper size={14} color="var(--mantine-color-blue-5)" />
                            : <IconUsers size={14} color="var(--mantine-color-teal-5)" />
                        }
                        <Text fw={500} size="sm" c={f.table === 'companies' ? 'blue' : 'teal'}>
                            {getFieldLabel(f)}
                            {f.required && <Text span c="red" ml={4}>*</Text>}
                        </Text>
                    </Group>
                </Table.Td>
                <Table.Td>
                    <Select
                        size="sm"
                        radius="md"
                        style={{ width: 280 }}
                        value={mappedFileHeader || null}
                        onChange={(val) => handleChange(dbFieldValue, val || null)}
                        data={fileHeaderOptions}
                        clearable
                        searchable
                        placeholder={t('import.selectColumn')}
                    />
                </Table.Td>
                <Table.Td>
                    {isMapped && previewRows && previewRows.length > 0 && (
                        <Tooltip
                            multiline
                            w={280}
                            position="bottom-start"
                            withArrow
                            label={
                                <Stack gap={2}>
                                    <Text size="xs" fw={600} c="white">
                                        {mappedFileHeader} ({getColumnValues(mappedFileHeader).length})
                                    </Text>
                                    {getColumnValues(mappedFileHeader).map((val, i) => (
                                        <Text key={i} size="xs" c="white" style={{ wordBreak: 'break-word' }}>{val}</Text>
                                    ))}
                                    {getColumnValues(mappedFileHeader).length === 0 && (
                                        <Text size="xs" c="dimmed" fs="italic">{t('import.noValues')}</Text>
                                    )}
                                </Stack>
                            }
                        >
                            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {previewRows[0]?.[mappedFileHeader] || '—'}
                            </Text>
                        </Tooltip>
                    )}
                </Table.Td>
                <Table.Td style={{ width: 120 }}>
                    {isMapped && getConfidenceBadge(confidence)}
                </Table.Td>
            </Table.Tr>
        );
    };

    const mappedFields = availableFields.filter((f) => !!inverseMapping[f.value]);
    const unmappedFields = availableFields.filter((f) => !inverseMapping[f.value]);

    const renderTable = (fields: AvailableField[]) => (
        <Table striped highlightOnHover>
            <Table.Thead>
                <Table.Tr>
                    <Table.Th style={{ width: 32 }} />
                    <Table.Th style={{ width: '38%' }}>{t('import.dbField')}</Table.Th>
                    <Table.Th>{t('import.fileColumn')}</Table.Th>
                    <Table.Th>{t('import.sampleValues')}</Table.Th>
                    <Table.Th style={{ width: 120 }}>{t('import.confidence')}</Table.Th>
                </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
                {fields.map(renderRow)}
            </Table.Tbody>
        </Table>
    );

    return (
        <>
            {mappedFields.length > 0 && (
                <>
                    <Text size="sm" fw={600} c="violet" mb={4} mt="md">
                        <IconLink size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                        {t('import.mappedColumns')} ({mappedFields.length})
                    </Text>
                    {renderTable(mappedFields)}
                </>
            )}

            {unmappedFields.length > 0 && (
                <>
                    {mappedFields.length > 0 && <Divider my="md" />}
                    <Text size="sm" fw={600} c="dimmed" mb={4}>
                        <IconLinkOff size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                        {t('import.unmappedColumns')} ({unmappedFields.length})
                    </Text>
                    {renderTable(unmappedFields)}
                </>
            )}
        </>
    );
}
