/**
 * CreditHistoryTab — müşterinin kendi kredi (dakika) cüzdanı hareket geçmişi.
 * Ledger: tarih, tür (yükleme/kullanım/düzeltme/iade/başlangıç), +/- dakika, işlem sonrası
 * kalan bakiye, açıklama. $ ASLA yok — server endpoint'i zaten $ döndürmüyor.
 */
import { useState } from 'react';
import { Button, Group, Loader, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { coldcallApi } from './api';
import type { CreditLedgerRow } from './types';

const PAGE_SIZE = 50;

function kindLabel(t: (k: string, f: string) => string, kind: CreditLedgerRow['kind']): string {
    const map: Record<string, string> = {
        grant: t('coldcall.credit.kindGrant', 'Yükleme'),
        usage: t('coldcall.credit.kindUsage', 'Kullanım'),
        adjustment: t('coldcall.credit.kindAdjustment', 'Düzeltme'),
        refund: t('coldcall.credit.kindRefund', 'İade'),
        initial: t('coldcall.credit.kindInitial', 'Başlangıç'),
    };
    return map[kind] ?? kind;
}

export default function CreditHistoryTab() {
    const { t, i18n } = useTranslation();
    // Cursor sayfalama: her "Daha fazla" tıklaması bir önceki sayfanın son created_at'ini before olarak yollar.
    const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
    const [rows, setRows] = useState<CreditLedgerRow[]>([]);

    const currentCursor = cursors[cursors.length - 1];
    const pageQuery = useQuery({
        queryKey: ['coldcall', 'creditsLedger', currentCursor],
        queryFn: () => coldcallApi.creditsLedger({ limit: PAGE_SIZE, before: currentCursor }),
    });

    const pageRows = pageQuery.data ?? [];
    const allRows = cursors.length > 1 ? [...rows, ...pageRows] : pageRows;
    const hasMore = pageRows.length === PAGE_SIZE;

    function loadMore() {
        if (pageRows.length === 0) return;
        setRows(allRows);
        setCursors((prev) => [...prev, pageRows[pageRows.length - 1].created_at]);
    }

    if (pageQuery.isLoading && cursors.length === 1) {
        return <Group justify="center" p="xl"><Loader /></Group>;
    }

    if (allRows.length === 0) {
        return (
            <Text c="dimmed" p="md">
                {t('coldcall.credit.historyEmpty', 'Henüz bir kredi hareketi yok.')}
            </Text>
        );
    }

    return (
        <>
            <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>{t('coldcall.credit.colDate', 'Tarih')}</Table.Th>
                        <Table.Th>{t('coldcall.credit.colKind', 'Tür')}</Table.Th>
                        <Table.Th>{t('coldcall.credit.colAmount', 'Miktar')}</Table.Th>
                        <Table.Th>{t('coldcall.credit.colBalance', 'Kalan')}</Table.Th>
                        <Table.Th>{t('coldcall.credit.colReason', 'Açıklama')}</Table.Th>
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {allRows.map((r) => {
                        const positive = Number(r.delta_minutes) >= 0;
                        return (
                            <Table.Tr key={r.id}>
                                <Table.Td>
                                    <Text size="sm">{new Date(r.created_at).toLocaleString(i18n.language === 'tr' ? 'tr-TR' : 'en-GB')}</Text>
                                </Table.Td>
                                <Table.Td><Text size="sm">{kindLabel(t, r.kind)}</Text></Table.Td>
                                <Table.Td>
                                    <Text size="sm" fw={600} c={positive ? 'green' : 'red'}>
                                        {positive ? '+' : ''}{Math.round(Number(r.delta_minutes) * 10) / 10} {t('coldcall.credit.minutesShort', 'dk')}
                                    </Text>
                                </Table.Td>
                                <Table.Td>
                                    <Text size="sm">{Math.round(Number(r.balance_after) * 10) / 10} {t('coldcall.credit.minutesShort', 'dk')}</Text>
                                </Table.Td>
                                <Table.Td>
                                    <Text size="sm" c="dimmed">{r.reason || '—'}</Text>
                                </Table.Td>
                            </Table.Tr>
                        );
                    })}
                </Table.Tbody>
            </Table>
            {hasMore && (
                <Group justify="center" mt="md">
                    <Button variant="default" loading={pageQuery.isFetching} onClick={loadMore}>
                        {t('coldcall.credit.loadMore', 'Daha fazla')}
                    </Button>
                </Group>
            )}
        </>
    );
}
