import { Table, Text, Select, Badge, Divider, Group } from '@mantine/core';
import { IconArrowRight, IconLink, IconLinkOff, IconBuildingSkyscraper, IconUsers } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { MappingSuggestion, AvailableField } from '../lib/types';

interface MappingEditorProps {
    suggestions: MappingSuggestion[];
    mapping: Record<string, string | null>;
    availableFields: AvailableField[];
    onMappingChange: (fileHeader: string, dbField: string | null) => void;
    companyHeaders?: string[];
    peopleHeaders?: string[];
}

export default function MappingEditor({ suggestions, mapping, availableFields, onMappingChange, companyHeaders, peopleHeaders }: MappingEditorProps) {
    const { t } = useTranslation();
    const hasSourceInfo = !!(companyHeaders && peopleHeaders);

    const companyHeaderSet = new Set(companyHeaders || []);
    const peopleHeaderSet = new Set(peopleHeaders || []);

    const getSourceBadge = (fileHeader: string) => {
        if (!hasSourceInfo) return null;
        if (companyHeaderSet.has(fileHeader) && !peopleHeaderSet.has(fileHeader)) {
            return <Badge size="xs" variant="light" color="blue" leftSection={<IconBuildingSkyscraper size={10} />}>{t('import.fieldGroupCompany')}</Badge>;
        }
        if (peopleHeaderSet.has(fileHeader) && !companyHeaderSet.has(fileHeader)) {
            return <Badge size="xs" variant="light" color="teal" leftSection={<IconUsers size={10} />}>{t('import.fieldGroupPeople')}</Badge>;
        }
        // Header exists in both (e.g. match key column)
        if (companyHeaderSet.has(fileHeader) && peopleHeaderSet.has(fileHeader)) {
            return <Badge size="xs" variant="light" color="grape">{t('import.sourceShared')}</Badge>;
        }
        return null;
    };

    const getConfidenceBadge = (confidence: number) => {
        if (confidence >= 0.8) return <Badge color="green" size="sm">✓ {t('import.confidenceHigh')}</Badge>;
        if (confidence >= 0.6) return <Badge color="yellow" size="sm">~ {t('import.confidenceMedium')}</Badge>;
        return <Badge color="gray" size="sm">? {t('import.confidenceManual')}</Badge>;
    };

    const companyFields = availableFields.filter((f) => f.table === 'companies');
    const contactFields = availableFields.filter((f) => f.table === 'contacts');
    const groups = [];
    if (companyFields.length > 0) {
        groups.push({ group: t('import.fieldGroupCompany'), items: companyFields.map((f) => ({ value: f.value, label: f.label })) });
    }
    if (contactFields.length > 0) {
        groups.push({ group: t('import.fieldGroupPeople'), items: contactFields.map((f) => ({ value: f.value, label: f.label })) });
    }

    const mappedSuggestions = suggestions.filter((s) => !!mapping[s.fileHeader]);
    const unmappedSuggestions = suggestions.filter((s) => !mapping[s.fileHeader]);

    const renderRow = (s: MappingSuggestion) => {
        const usedInOtherRows = new Set(
            Object.entries(mapping)
                .filter(([key, val]) => key !== s.fileHeader && val)
                .map(([, val]) => val as string)
        );
        const filteredOptions = [
            { value: '', label: `— ${t('import.unmapped')}` },
            ...groups.map((g) => ({
                group: g.group,
                items: g.items.filter((opt) => !usedInOtherRows.has(opt.value)),
            })).filter((g) => g.items.length > 0),
        ];
        const isMapped = !!mapping[s.fileHeader];
        return (
            <Table.Tr key={s.fileHeader}>
                <Table.Td>
                    {isMapped && <IconArrowRight size={18} color="var(--mantine-color-violet-6)" />}
                </Table.Td>
                <Table.Td>
                    <Group gap="xs">
                        <Text fw={500} size="sm">
                            {s.fileHeader}
                            {s.required && <Text span c="red" ml={4}>*</Text>}
                        </Text>
                        {getSourceBadge(s.fileHeader)}
                    </Group>
                </Table.Td>
                <Table.Td>
                    <Select
                        size="sm"
                        radius="md"
                        value={mapping[s.fileHeader] || ''}
                        onChange={(val) => onMappingChange(s.fileHeader, val || null)}
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
    };

    const renderTable = (items: MappingSuggestion[]) => (
        <Table striped highlightOnHover>
            <Table.Thead>
                <Table.Tr>
                    <Table.Th style={{ width: 32 }} />
                    <Table.Th>{t('import.fileColumn')}{hasSourceInfo ? ` / ${t('import.source')}` : ''}</Table.Th>
                    <Table.Th>{t('import.dbField')}</Table.Th>
                    <Table.Th>{t('import.confidence')}</Table.Th>
                </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
                {items.map(renderRow)}
            </Table.Tbody>
        </Table>
    );

    return (
        <>
            {mappedSuggestions.length > 0 && (
                <>
                    <Text size="sm" fw={600} c="violet" mb={4} mt="md">
                        <IconLink size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                        {t('import.mappedColumns')} ({mappedSuggestions.length})
                    </Text>
                    {renderTable(mappedSuggestions)}
                </>
            )}

            {unmappedSuggestions.length > 0 && (
                <>
                    {mappedSuggestions.length > 0 && <Divider my="md" />}
                    <Text size="sm" fw={600} c="dimmed" mb={4}>
                        <IconLinkOff size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                        {t('import.unmappedColumns')} ({unmappedSuggestions.length})
                    </Text>
                    {renderTable(unmappedSuggestions)}
                </>
            )}
        </>
    );
}
