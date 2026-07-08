/**
 * CallsTab — çağrı geçmişi: durum, süre, sonuç, AI özet önizlemesi;
 * satıra tıklayınca kayıt + transkript + özet drawer'ı açılır.
 */
import { useState } from 'react';
import { Badge, Group, Loader, Pagination, Table, Text, Tooltip } from '@mantine/core';
import { IconFileMusic, IconSparkles } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { coldcallApi } from './api';
import { CallStatusBadge, SentimentBadge } from './badges';
import { dispositionLabel } from './labels';
import CallDetailDrawer from './CallDetailDrawer';

const PAGE_SIZE = 25;

export default function CallsTab() {
    const { t, i18n } = useTranslation();
    const [page, setPage] = useState(1);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const listQuery = useQuery({
        queryKey: ['coldcall', 'callsList', page],
        queryFn: () => coldcallApi.listCalls({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
        refetchInterval: 5000,
    });

    if (listQuery.isLoading) return <Group justify="center" p="xl"><Loader /></Group>;

    const calls = listQuery.data?.calls ?? [];
    const total = listQuery.data?.total ?? 0;

    if (calls.length === 0) {
        return <Text c="dimmed" p="md">{t('coldcall.noCalls', 'No calls yet — make your first call from the Dialer tab.')}</Text>;
    }

    return (
        <>
            <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>{t('coldcall.colWhen', 'When')}</Table.Th>
                        <Table.Th>{t('coldcall.colCompany', 'Company')}</Table.Th>
                        <Table.Th>{t('coldcall.colNumber', 'Number')}</Table.Th>
                        <Table.Th>{t('coldcall.colStatus', 'Status')}</Table.Th>
                        <Table.Th>{t('coldcall.colDuration', 'Duration')}</Table.Th>
                        <Table.Th>{t('coldcall.colOutcome', 'Outcome')}</Table.Th>
                        <Table.Th>{t('coldcall.colSummary', 'AI summary')}</Table.Th>
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {calls.map((c) => (
                        <Table.Tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedId(c.id)}>
                            <Table.Td>
                                <Text size="sm">{new Date(c.created_at).toLocaleString(i18n.language === 'tr' ? 'tr-TR' : 'en-GB')}</Text>
                            </Table.Td>
                            <Table.Td>
                                <Text size="sm">{c.company?.name ?? '—'}</Text>
                            </Table.Td>
                            <Table.Td>
                                <Group gap={4}>
                                    <Text size="sm" ff="monospace">{c.to_e164}</Text>
                                    {c.to_country && <Badge size="xs" variant="default">{c.to_country}</Badge>}
                                    {Number(c.rate_multiplier) > 1 && (
                                        <Tooltip label={t('coldcall.multiplierHint', '1 talk minute uses {{m}} quota minutes', { m: Number(c.rate_multiplier) })}>
                                            <Badge size="xs" color="orange" variant="light">{Number(c.rate_multiplier)}x</Badge>
                                        </Tooltip>
                                    )}
                                </Group>
                            </Table.Td>
                            <Table.Td><CallStatusBadge status={c.status} /></Table.Td>
                            <Table.Td>
                                <Text size="sm">{c.duration_sec ? `${Math.floor(c.duration_sec / 60)}:${String(c.duration_sec % 60).padStart(2, '0')}` : '—'}</Text>
                            </Table.Td>
                            <Table.Td><Text size="sm">{dispositionLabel(t, c.disposition)}</Text></Table.Td>
                            <Table.Td maw={280}>
                                <Group gap={6} wrap="nowrap">
                                    {c.recording_status === 'stored' && (
                                        <Tooltip label={t('coldcall.hasRecording', 'Recording available')}>
                                            <IconFileMusic size={16} color="var(--mantine-color-violet-6)" />
                                        </Tooltip>
                                    )}
                                    {c.summary ? (
                                        <>
                                            <IconSparkles size={14} color="var(--mantine-color-violet-6)" style={{ flexShrink: 0 }} />
                                            <Text size="xs" lineClamp={2}>{c.summary}</Text>
                                            <SentimentBadge sentiment={c.sentiment} />
                                        </>
                                    ) : c.transcript_status === 'pending' ? (
                                        <Text size="xs" c="dimmed">{t('coldcall.summaryPendingShort', 'Generating…')}</Text>
                                    ) : (
                                        <Text size="xs" c="dimmed">—</Text>
                                    )}
                                </Group>
                            </Table.Td>
                        </Table.Tr>
                    ))}
                </Table.Tbody>
            </Table>
            {total > PAGE_SIZE && (
                <Group justify="center" mt="md">
                    <Pagination total={Math.ceil(total / PAGE_SIZE)} value={page} onChange={setPage} />
                </Group>
            )}
            <CallDetailDrawer callId={selectedId} onClose={() => setSelectedId(null)} />
        </>
    );
}
