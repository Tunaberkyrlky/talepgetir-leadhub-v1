/**
 * NumbersTab — tenant'ın numaraları + yeni numara satın alma akışı:
 * ülke seç (envanter/evrak durumu görünür) → uygun numaraları listele → satın al.
 * $ maliyet yalnız internal rollerde görünür; müşteri numara hakkı kotasını görür.
 */
import { useState } from 'react';
import {
    Alert, Badge, Button, Group, Loader, Modal, Paper, Select, Stack, Table, Text, TextInput,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconInfoCircle, IconPhonePlus, IconSearch, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { showErrorFromApi } from '../../lib/notifications';
import { coldcallApi } from './api';
import { NumberHealthBadge } from './badges';
import type { AvailableNumber } from './types';

export default function NumbersTab() {
    const { t, i18n } = useTranslation();
    const qc = useQueryClient();
    const { user } = useAuth();
    const internal = user?.role === 'superadmin' || user?.role === 'ops_agent';
    const canBuy = internal || user?.role === 'client_admin';

    const [buyOpen, setBuyOpen] = useState(false);
    const [country, setCountry] = useState<string | null>(null);
    const [contains, setContains] = useState('');
    const [results, setResults] = useState<AvailableNumber[] | null>(null);

    const configQuery = useQuery({ queryKey: ['coldcall', 'config'], queryFn: coldcallApi.config });
    const numbersQuery = useQuery({ queryKey: ['coldcall', 'numbers'], queryFn: coldcallApi.numbers });
    const countriesQuery = useQuery({ queryKey: ['coldcall', 'countries'], queryFn: coldcallApi.countries, staleTime: 10 * 60 * 1000 });

    const buyableCountries = (countriesQuery.data ?? []).filter((c) => c.can_buy_number);
    const selectedCountry = buyableCountries.find((c) => c.code === country);

    const searchMutation = useMutation({
        mutationFn: () => coldcallApi.searchNumbers(country!, contains || undefined),
        onSuccess: (data) => setResults(data.numbers),
        onError: (err) => showErrorFromApi(err),
    });

    const purchaseMutation = useMutation({
        mutationFn: (number: AvailableNumber) => coldcallApi.purchaseNumber(number.offer),
        onSuccess: (num) => {
            notifications.show({ color: 'green', message: t('coldcall.numberPurchased', 'Number purchased: {{n}}', { n: num.e164 }) });
            setBuyOpen(false);
            setResults(null);
            qc.invalidateQueries({ queryKey: ['coldcall', 'numbers'] });
            qc.invalidateQueries({ queryKey: ['coldcall', 'config'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    const releaseMutation = useMutation({
        mutationFn: (id: string) => coldcallApi.releaseNumber(id),
        onSuccess: () => {
            notifications.show({ color: 'green', message: t('coldcall.numberReleased', 'Number released') });
            qc.invalidateQueries({ queryKey: ['coldcall', 'numbers'] });
            qc.invalidateQueries({ queryKey: ['coldcall', 'config'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    const confirmRelease = (id: string, e164: string) =>
        modals.openConfirmModal({
            title: t('coldcall.releaseTitle', 'Release number'),
            children: <Text size="sm">{t('coldcall.releaseConfirm', '{{n}} will be released and can no longer be used for calls. Continue?', { n: e164 })}</Text>,
            labels: { confirm: t('coldcall.release', 'Release'), cancel: t('common.cancel', 'Cancel') },
            confirmProps: { color: 'red' },
            onConfirm: () => releaseMutation.mutate(id),
        });

    const numbers = numbersQuery.data ?? [];
    const config = configQuery.data;

    return (
        <Stack>
            <Group justify="space-between">
                <Text size="sm" c="dimmed">
                    {config &&
                        t('coldcall.numberQuota', '{{used}} / {{max}} number slots used', {
                            used: numbers.length,
                            max: config.max_numbers,
                        })}
                </Text>
                {canBuy && (
                    <Button leftSection={<IconPhonePlus size={18} />} onClick={() => setBuyOpen(true)}>
                        {t('coldcall.buyNumber', 'Buy number')}
                    </Button>
                )}
            </Group>

            {numbersQuery.isLoading ? (
                <Group justify="center" p="xl"><Loader /></Group>
            ) : numbers.length === 0 ? (
                <Paper withBorder p="xl" radius="md">
                    <Text c="dimmed">{t('coldcall.noNumbersYet', 'No numbers yet. Buy a local number of your target market — a local caller ID lifts answer rates.')}</Text>
                </Paper>
            ) : (
                <Table verticalSpacing="sm">
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>{t('coldcall.colNumber', 'Number')}</Table.Th>
                            <Table.Th>{t('coldcall.colCountry', 'Country')}</Table.Th>
                            <Table.Th>{t('coldcall.colStatus', 'Status')}</Table.Th>
                            <Table.Th>{t('coldcall.colToday', 'Today')}</Table.Th>
                            <Table.Th>{t('coldcall.colHealth', 'Health')}</Table.Th>
                            <Table.Th>{t('coldcall.colPurchased', 'Purchased')}</Table.Th>
                            {internal && <Table.Th>$/mo</Table.Th>}
                            {canBuy && <Table.Th />}
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {numbers.map((n) => (
                            <Table.Tr key={n.id}>
                                <Table.Td><Text ff="monospace">{n.e164}</Text></Table.Td>
                                <Table.Td><Badge variant="default">{n.country_code}</Badge></Table.Td>
                                <Table.Td>
                                    {n.status === 'active' ? (
                                        <Badge color="green" variant="light">{t('coldcall.numberActive', 'Active')}</Badge>
                                    ) : (
                                        <Badge color="yellow" variant="light">{t('coldcall.numberPendingDocs', 'Awaiting regulatory approval')}</Badge>
                                    )}
                                </Table.Td>
                                <Table.Td>
                                    {n.daily_cap != null ? (
                                        <Text size="sm" c={(n.remaining_today ?? 1) <= 0 ? 'red' : undefined}>
                                            {n.calls_today ?? 0} / {n.daily_cap}
                                        </Text>
                                    ) : (
                                        <Text size="sm" c="dimmed">—</Text>
                                    )}
                                </Table.Td>
                                <Table.Td>
                                    <NumberHealthBadge health={n.health} answerRate={n.answer_rate_7d} />
                                </Table.Td>
                                <Table.Td>
                                    <Text size="sm">{new Date(n.purchased_at).toLocaleDateString(i18n.language === 'tr' ? 'tr-TR' : 'en-GB')}</Text>
                                </Table.Td>
                                {internal && (
                                    <Table.Td><Text size="sm">${Number(n.monthly_cost_usd ?? 0).toFixed(2)}</Text></Table.Td>
                                )}
                                {canBuy && (
                                    <Table.Td>
                                        <Button
                                            size="compact-xs"
                                            variant="subtle"
                                            color="red"
                                            leftSection={<IconTrash size={14} />}
                                            onClick={() => confirmRelease(n.id, n.e164)}
                                        >
                                            {t('coldcall.release', 'Release')}
                                        </Button>
                                    </Table.Td>
                                )}
                            </Table.Tr>
                        ))}
                    </Table.Tbody>
                </Table>
            )}

            {/* Satın alma modalı */}
            <Modal
                opened={buyOpen}
                onClose={() => { setBuyOpen(false); setResults(null); }}
                title={t('coldcall.buyNumberTitle', 'Buy a phone number')}
                size="lg"
            >
                <Stack>
                    <Select
                        label={t('coldcall.country', 'Country')}
                        placeholder={t('coldcall.pickCountry', 'Select country')}
                        searchable
                        value={country}
                        onChange={(v) => { setCountry(v); setResults(null); }}
                        data={buyableCountries.map((c) => ({
                            value: c.code,
                            label: `${i18n.language === 'tr' ? c.name_tr : c.name_en} (${c.dial_code})`,
                        }))}
                    />
                    {selectedCountry?.number_requires_docs && (
                        <Alert color="yellow" icon={<IconInfoCircle size={18} />} variant="light">
                            {t('coldcall.docsRequired', 'This country requires address/identity documents (regulatory bundle). Activation may take days to weeks.')}
                        </Alert>
                    )}
                    <Group align="flex-end">
                        <TextInput
                            label={t('coldcall.contains', 'Digits it should contain (optional)')}
                            placeholder="212"
                            value={contains}
                            onChange={(e) => setContains(e.currentTarget.value.replace(/\D/g, ''))}
                            style={{ flex: 1 }}
                        />
                        <Button
                            leftSection={<IconSearch size={16} />}
                            disabled={!country}
                            loading={searchMutation.isPending}
                            onClick={() => searchMutation.mutate()}
                        >
                            {t('coldcall.searchNumbers', 'Search numbers')}
                        </Button>
                    </Group>

                    {results && (
                        results.length === 0 ? (
                            <Text size="sm" c="dimmed">{t('coldcall.noResults', 'No numbers found for this filter.')}</Text>
                        ) : (
                            <Stack gap="xs">
                                {results.map((r) => (
                                    <Paper key={r.e164} withBorder p="sm" radius="md">
                                        <Group justify="space-between">
                                            <div>
                                                <Text ff="monospace" fw={600}>{r.friendly_name}</Text>
                                                {r.locality && <Text size="xs" c="dimmed">{r.locality}</Text>}
                                            </div>
                                            <Button
                                                size="xs"
                                                loading={purchaseMutation.isPending && purchaseMutation.variables?.offer === r.offer}
                                                onClick={() => purchaseMutation.mutate(r)}
                                            >
                                                {t('coldcall.buy', 'Buy')}
                                            </Button>
                                        </Group>
                                    </Paper>
                                ))}
                            </Stack>
                        )
                    )}
                </Stack>
            </Modal>
        </Stack>
    );
}
