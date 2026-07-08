/**
 * CountriesTab — ülke tarife/erişim tablosu.
 * Müşteri: kategori + dakika çarpanı + engel nedeni + numara envanteri.
 * Internal roller ek olarak $/dk COGS ve numara kirasını görür.
 */
import { useMemo, useState } from 'react';
import { Badge, Group, Loader, Table, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { coldcallApi } from './api';
import { TierBadge } from './badges';

export default function CountriesTab() {
    const { t, i18n } = useTranslation();
    const { user } = useAuth();
    const internal = user?.role === 'superadmin' || user?.role === 'ops_agent';
    const [search, setSearch] = useState('');

    const countriesQuery = useQuery({ queryKey: ['coldcall', 'countries'], queryFn: coldcallApi.countries, staleTime: 10 * 60 * 1000 });

    const rows = useMemo(() => {
        const list = countriesQuery.data ?? [];
        const q = search.trim().toLowerCase();
        const filtered = q
            ? list.filter((c) =>
                c.name_tr.toLowerCase().includes(q) ||
                c.name_en.toLowerCase().includes(q) ||
                c.dial_code.includes(q) ||
                c.code.toLowerCase().includes(q))
            : list;
        // Aranabilirler önce (ucuzdan pahalıya), engelliler sonda
        return [...filtered].sort((a, b) => {
            if (a.callable !== b.callable) return a.callable ? -1 : 1;
            if (a.multiplier !== b.multiplier) return a.multiplier - b.multiplier;
            return (i18n.language === 'tr' ? a.name_tr : a.name_en).localeCompare(i18n.language === 'tr' ? b.name_tr : b.name_en);
        });
    }, [countriesQuery.data, search, i18n.language]);

    if (countriesQuery.isLoading) return <Group justify="center" p="xl"><Loader /></Group>;

    return (
        <>
            <Group justify="space-between" mb="sm">
                <TextInput
                    placeholder={t('coldcall.searchCountry', 'Search country or dial code…')}
                    leftSection={<IconSearch size={16} />}
                    value={search}
                    onChange={(e) => setSearch(e.currentTarget.value)}
                    w={280}
                />
                <Group gap="xs">
                    <Badge color="green" variant="light">1x</Badge>
                    <Badge color="yellow" variant="light">2x</Badge>
                    <Badge color="orange" variant="light">4x</Badge>
                    <Text size="xs" c="dimmed">{t('coldcall.multiplierLegend', 'Quota multiplier: 1 talk minute uses this many quota minutes')}</Text>
                </Group>
            </Group>
            <Table highlightOnHover verticalSpacing="xs" stickyHeader>
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>{t('coldcall.colCountry', 'Country')}</Table.Th>
                        <Table.Th>{t('coldcall.colDialCode', 'Code')}</Table.Th>
                        <Table.Th>{t('coldcall.colTariff', 'Tariff')}</Table.Th>
                        {internal && <Table.Th>$/min (COGS)</Table.Th>}
                        <Table.Th>{t('coldcall.colNumberInventory', 'Local numbers')}</Table.Th>
                        {internal && <Table.Th>{t('coldcall.colNumberCost', 'Number $/mo')}</Table.Th>}
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {rows.map((c) => (
                        <Table.Tr key={c.code} opacity={c.callable ? 1 : 0.6}>
                            <Table.Td>
                                <Text size="sm" fw={500}>{i18n.language === 'tr' ? c.name_tr : c.name_en}</Text>
                            </Table.Td>
                            <Table.Td><Text size="sm" ff="monospace">{c.dial_code}</Text></Table.Td>
                            <Table.Td><TierBadge country={c} /></Table.Td>
                            {internal && (
                                <Table.Td>
                                    <Text size="sm">{c.out_usd_per_min != null ? `$${c.out_usd_per_min.toFixed(3)}` : '—'}</Text>
                                </Table.Td>
                            )}
                            <Table.Td>
                                {c.can_buy_number ? (
                                    c.number_requires_docs ? (
                                        <Badge color="yellow" variant="light">{t('coldcall.inventoryDocs', 'Available (docs required)')}</Badge>
                                    ) : (
                                        <Badge color="green" variant="light">{t('coldcall.inventoryAvailable', 'Available')}</Badge>
                                    )
                                ) : (
                                    <Text size="sm" c="dimmed">—</Text>
                                )}
                            </Table.Td>
                            {internal && (
                                <Table.Td>
                                    <Text size="sm">{c.number_monthly_usd != null ? `$${Number(c.number_monthly_usd).toFixed(2)}` : '—'}</Text>
                                </Table.Td>
                            )}
                        </Table.Tr>
                    ))}
                </Table.Tbody>
            </Table>
        </>
    );
}
