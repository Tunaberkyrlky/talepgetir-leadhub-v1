import { useMemo, useState } from 'react';
import {
    Paper,
    Stack,
    Group,
    Badge,
    Text,
    Table,
    ScrollArea,
    Button,
    SegmentedControl,
    Anchor,
} from '@mantine/core';
import { IconDownload, IconChecklist } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { MatchReport, MatchEntry } from '../../types/import';

// How many ledger rows we render in the table at once. The full set is always
// available via the CSV export, so very large imports stay responsive.
const DISPLAY_LIMIT = 500;

type FilterValue = 'all' | 'created_company' | 'matched_company' | 'duplicates' | 'no_contact';

function csvCell(value: string | number | null): string {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(entries: MatchEntry[], fileName: string) {
    const header = ['row', 'company', 'website', 'company_action', 'contact', 'email', 'contact_action'];
    const lines = [header.join(',')];
    for (const e of entries) {
        lines.push([
            e.row,
            csvCell(e.company),
            csvCell(e.website),
            e.companyAction,
            csvCell(e.contact),
            csvCell(e.email),
            e.contactAction,
        ].join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
}

interface Props {
    report: MatchReport;
    /** Used to name the exported CSV file. */
    fileName?: string;
}

export default function ImportMatchReport({ report, fileName }: Props) {
    const { t } = useTranslation();
    const [filter, setFilter] = useState<FilterValue>('all');

    const { summary, entries, entriesTruncated } = report;

    const filtered = useMemo(() => {
        switch (filter) {
            case 'created_company':
                return entries.filter((e) => e.companyAction === 'created');
            case 'matched_company':
                return entries.filter((e) => e.companyAction === 'matched');
            case 'duplicates':
                return entries.filter((e) => e.contactAction === 'skipped_duplicate');
            case 'no_contact':
                return entries.filter((e) => e.contactAction === 'none');
            default:
                return entries;
        }
    }, [entries, filter]);

    const visible = filtered.slice(0, DISPLAY_LIMIT);

    const companyActionBadge = (action: MatchEntry['companyAction']) =>
        action === 'created' ? (
            <Badge size="xs" variant="light" color="blue">{t('import.report.companyCreated')}</Badge>
        ) : (
            <Badge size="xs" variant="light" color="teal">{t('import.report.companyMatched')}</Badge>
        );

    const contactActionBadge = (action: MatchEntry['contactAction']) => {
        if (action === 'created') return <Badge size="xs" variant="light" color="green">{t('import.report.contactCreated')}</Badge>;
        if (action === 'skipped_duplicate') return <Badge size="xs" variant="light" color="orange">{t('import.report.contactDuplicate')}</Badge>;
        return <Badge size="xs" variant="light" color="gray">{t('import.report.contactNone')}</Badge>;
    };

    return (
        <Paper shadow="sm" radius="lg" p="lg" withBorder>
            <Group justify="space-between" mb="md" wrap="nowrap">
                <Group gap="xs">
                    <IconChecklist size={18} color="var(--mantine-color-violet-6)" />
                    <Text fw={600}>{t('import.report.title')}</Text>
                </Group>
                {entries.length > 0 && (
                    <Button
                        size="xs"
                        variant="light"
                        color="violet"
                        leftSection={<IconDownload size={14} />}
                        onClick={() => downloadCsv(entries, `${(fileName || 'import').replace(/\.[^.]+$/, '')}-denetim.csv`)}
                    >
                        {t('import.report.downloadCsv')}
                    </Button>
                )}
            </Group>

            {/* Summary chips */}
            <Group gap="xs" mb="md">
                <Badge size="lg" variant="light" color="blue">{t('import.report.companyCreated')}: {summary.companiesCreated}</Badge>
                <Badge size="lg" variant="light" color="teal">{t('import.report.companyMatched')}: {summary.companiesMatched}</Badge>
                <Badge size="lg" variant="light" color="green">{t('import.report.contactCreated')}: {summary.contactsCreated}</Badge>
                {summary.contactsSkippedDuplicate > 0 && (
                    <Badge size="lg" variant="light" color="orange">{t('import.report.contactDuplicate')}: {summary.contactsSkippedDuplicate}</Badge>
                )}
                {summary.contactsWithoutName > 0 && (
                    <Badge size="lg" variant="light" color="gray">{t('import.report.contactNone')}: {summary.contactsWithoutName}</Badge>
                )}
                {summary.rowsErrored > 0 && (
                    <Badge size="lg" variant="light" color="red">{t('import.report.rowsErrored')}: {summary.rowsErrored}</Badge>
                )}
            </Group>

            {entries.length === 0 ? (
                <Text size="sm" c="dimmed">{t('import.report.empty')}</Text>
            ) : (
                <>
                    <SegmentedControl
                        size="xs"
                        value={filter}
                        onChange={(v) => setFilter(v as FilterValue)}
                        mb="sm"
                        data={[
                            { value: 'all', label: `${t('import.report.filterAll')} (${entries.length})` },
                            { value: 'created_company', label: t('import.report.filterCreatedCompany') },
                            { value: 'matched_company', label: t('import.report.filterMatchedCompany') },
                            { value: 'duplicates', label: t('import.report.filterDuplicates') },
                            { value: 'no_contact', label: t('import.report.filterNoContact') },
                        ]}
                    />

                    <ScrollArea.Autosize mah={420}>
                        <Table striped highlightOnHover stickyHeader>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th w={60}>{t('import.report.colRow')}</Table.Th>
                                    <Table.Th>{t('import.report.colCompany')}</Table.Th>
                                    <Table.Th>{t('import.report.colContact')}</Table.Th>
                                    <Table.Th>{t('import.report.colStatus')}</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {visible.map((e) => (
                                    <Table.Tr key={e.row}>
                                        <Table.Td><Text size="xs" c="dimmed">{e.row}</Text></Table.Td>
                                        <Table.Td>
                                            <Stack gap={2}>
                                                <Group gap={6} wrap="nowrap">
                                                    <Anchor component={Link} to={`/companies/${e.companyId}`} size="sm" fw={500} lineClamp={1} maw={220}>
                                                        {e.company}
                                                    </Anchor>
                                                    {companyActionBadge(e.companyAction)}
                                                </Group>
                                                {e.website && <Text size="xs" c="dimmed" lineClamp={1} maw={220}>{e.website}</Text>}
                                            </Stack>
                                        </Table.Td>
                                        <Table.Td>
                                            {e.contact ? (
                                                <Stack gap={0}>
                                                    <Text size="sm" lineClamp={1} maw={200}>{e.contact}</Text>
                                                    {e.email && <Text size="xs" c="dimmed" lineClamp={1} maw={200}>{e.email}</Text>}
                                                </Stack>
                                            ) : (
                                                <Text size="xs" c="dimmed">—</Text>
                                            )}
                                        </Table.Td>
                                        <Table.Td>{contactActionBadge(e.contactAction)}</Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </ScrollArea.Autosize>

                    {(filtered.length > DISPLAY_LIMIT || entriesTruncated) && (
                        <Text size="xs" c="dimmed" mt="xs">
                            {t('import.report.truncatedNote', {
                                shown: visible.length,
                                total: filtered.length,
                            })}
                        </Text>
                    )}
                </>
            )}
        </Paper>
    );
}
