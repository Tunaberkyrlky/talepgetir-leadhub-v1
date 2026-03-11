import { Table, Text, Select, Badge } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { MappingSuggestion, AvailableField } from '../lib/types';

interface MappingEditorProps {
    suggestions: MappingSuggestion[];
    mapping: Record<string, string | null>;
    availableFields: AvailableField[];
    onMappingChange: (fileHeader: string, dbField: string | null) => void;
}

export default function MappingEditor({ suggestions, mapping, availableFields, onMappingChange }: MappingEditorProps) {
    const { t } = useTranslation();

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

    return (
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
                {suggestions.map((s) => {
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
                })}
            </Table.Tbody>
        </Table>
    );
}
