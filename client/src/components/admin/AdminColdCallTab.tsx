/**
 * Cold Call admin paneli — tenant bazında kullanım, COGS $ ve dakika cüzdanı yönetimi.
 * Superadmin-only yüzey: bu sekme yalnız AdminPage.tsx'in role guard'ı (user.role ===
 * 'superadmin') arkasında render edilir, bu yüzden $ COGS kolonları burada güvenlidir.
 * Bu bileşen ve altındakiler ASLA müşteri tarafında (coldcall/ klasörü) yeniden kullanılmamalı.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Table, Button, Group, Badge, Text, Stack, Center, Loader, Paper, Box,
    Modal, NumberInput, TextInput, Drawer, Tooltip, Alert,
} from '@mantine/core';
import { IconCreditCard, IconHistory, IconPlugConnected, IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';
import { coldcallAdminApi, type ColdCallUsageRow, type ColdCallAdminLedgerRow } from './coldcallAdminApi';

// ── kredi hareket türü etiketleri — CreditHistoryTab.tsx (müşteri tarafı) ile aynı i18n
// anahtarları yeniden kullanılır, bunlar zaten locale dosyalarında var; yeni anahtar gerekmez.
function kindLabel(t: (k: string, f: string) => string, kind: ColdCallAdminLedgerRow['kind']): string {
    const map: Record<string, string> = {
        grant: t('coldcall.credit.kindGrant', 'Yükleme'),
        usage: t('coldcall.credit.kindUsage', 'Kullanım'),
        adjustment: t('coldcall.credit.kindAdjustment', 'Düzeltme'),
        refund: t('coldcall.credit.kindRefund', 'İade'),
        initial: t('coldcall.credit.kindInitial', 'Başlangıç'),
    };
    return map[kind] ?? kind;
}

function fmtUsd(n: number): string {
    return `$${n.toFixed(2)}`;
}

function fmtMinutes(n: number): string {
    return `${Math.round(n * 10) / 10}`;
}

// ── Kredi geçmişi (admin, tam görünüm — created_by/source/idempotency_key dahil) ────────────
function ColdCallAdminLedgerList({ tenantId }: { tenantId: string }) {
    const { t, i18n } = useTranslation();
    const PAGE_SIZE = 50;
    const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
    const [rows, setRows] = useState<ColdCallAdminLedgerRow[]>([]);
    const currentCursor = cursors[cursors.length - 1];

    const pageQuery = useQuery({
        queryKey: ['admin', 'coldcall', 'ledger', tenantId, currentCursor],
        queryFn: () => coldcallAdminApi.ledger(tenantId, { limit: PAGE_SIZE, before: currentCursor }),
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
        return <Center py="xl"><Loader /></Center>;
    }

    if (allRows.length === 0) {
        return <Text c="dimmed" p="md">{t('admin.coldcall.ledgerEmpty', 'Henüz bir kredi hareketi yok.')}</Text>;
    }

    return (
        <Stack gap="sm">
            <Table.ScrollContainer minWidth={640}>
                <Table highlightOnHover verticalSpacing="sm">
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>{t('admin.coldcall.colDate', 'Tarih')}</Table.Th>
                            <Table.Th>{t('admin.coldcall.colKind', 'Tür')}</Table.Th>
                            <Table.Th>{t('admin.coldcall.colAmount', 'Miktar')}</Table.Th>
                            <Table.Th>{t('admin.coldcall.colLedgerBalance', 'Kalan')}</Table.Th>
                            <Table.Th>{t('admin.coldcall.colSource', 'Kaynak')}</Table.Th>
                            <Table.Th>{t('admin.coldcall.colCreatedBy', 'Yükleyen')}</Table.Th>
                            <Table.Th>{t('admin.coldcall.colReason', 'Açıklama')}</Table.Th>
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
                                            {positive ? '+' : ''}{fmtMinutes(Number(r.delta_minutes))} {t('coldcall.credit.minutesShort', 'dk')}
                                        </Text>
                                    </Table.Td>
                                    <Table.Td><Text size="sm">{fmtMinutes(Number(r.balance_after))} {t('coldcall.credit.minutesShort', 'dk')}</Text></Table.Td>
                                    <Table.Td><Text size="xs" c="dimmed">{r.source || '—'}</Text></Table.Td>
                                    <Table.Td>
                                        {r.created_by ? (
                                            <Tooltip label={r.created_by}>
                                                <Text size="xs" c="dimmed" ff="monospace">{r.created_by.slice(0, 8)}</Text>
                                            </Tooltip>
                                        ) : (
                                            <Text size="xs" c="dimmed">—</Text>
                                        )}
                                    </Table.Td>
                                    <Table.Td><Text size="sm" c="dimmed">{r.reason || '—'}</Text></Table.Td>
                                </Table.Tr>
                            );
                        })}
                    </Table.Tbody>
                </Table>
            </Table.ScrollContainer>
            {hasMore && (
                <Group justify="center" mt="sm">
                    <Button variant="default" size="sm" loading={pageQuery.isFetching} onClick={loadMore}>
                        {t('admin.coldcall.loadMore', 'Daha fazla')}
                    </Button>
                </Group>
            )}
        </Stack>
    );
}

export default function AdminColdCallTab() {
    const { t } = useTranslation();
    const queryClient = useQueryClient();

    const [grantTarget, setGrantTarget] = useState<ColdCallUsageRow | null>(null);
    const [grantMinutesVal, setGrantMinutesVal] = useState<number | ''>('');
    const [grantReason, setGrantReason] = useState('');
    const [grantIdempotencyKey, setGrantIdempotencyKey] = useState<string>('');

    const [ledgerTenant, setLedgerTenant] = useState<{ id: string; name: string } | null>(null);

    const { data, isLoading } = useQuery({
        queryKey: ['admin', 'coldcall', 'usage'],
        queryFn: () => coldcallAdminApi.usage(),
    });

    const usageRows = data?.usage ?? [];
    const twilioConfigured = data?.twilio_configured ?? false;

    function openGrantModal(row: ColdCallUsageRow) {
        setGrantTarget(row);
        setGrantMinutesVal('');
        setGrantReason('');
        // idempotency_key bir kez, modal açılırken üretilir — çift-tık/retry aynı anahtarı gönderir.
        setGrantIdempotencyKey(crypto.randomUUID());
    }

    function closeGrantModal() {
        setGrantTarget(null);
    }

    const grantMutation = useMutation({
        mutationFn: (input: { tenant_id: string; minutes: number; reason: string; idempotency_key: string }) =>
            coldcallAdminApi.grantCredit(input),
        onSuccess: (res) => {
            showSuccess(t('admin.coldcall.grantSuccess', {
                defaultValue: 'Kredi yüklendi. Yeni bakiye: {{balance}} dk',
                balance: fmtMinutes(res.minutes_balance),
            }));
            queryClient.invalidateQueries({ queryKey: ['admin', 'coldcall', 'usage'] });
            closeGrantModal();
        },
        onError: (err) => showErrorFromApi(err),
    });

    function handleGrantSubmit() {
        if (!grantTarget || grantMinutesVal === '' || grantMinutesVal === 0 || !grantReason.trim()) return;
        grantMutation.mutate({
            tenant_id: grantTarget.tenant_id,
            minutes: grantMinutesVal,
            reason: grantReason.trim(),
            idempotency_key: grantIdempotencyKey,
        });
    }

    const provisionMutation = useMutation({
        mutationFn: (tenantId: string) => coldcallAdminApi.provision(tenantId),
        onSuccess: () => {
            showSuccess(t('admin.coldcall.provisionSuccess', 'Tenant Twilio\'ya taşındı.'));
            queryClient.invalidateQueries({ queryKey: ['admin', 'coldcall', 'usage'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    function handleProvision(row: ColdCallUsageRow) {
        const msg = t('admin.coldcall.provisionConfirm', {
            defaultValue: '{{name}} Twilio\'ya taşınsın mı? Bu işlem geri alınamaz.',
            name: row.tenant_name,
        });
        if (window.confirm(msg)) {
            provisionMutation.mutate(row.tenant_id);
        }
    }

    const grantValid = grantMinutesVal !== '' && grantMinutesVal !== 0 && grantReason.trim().length > 0;

    return (
        <Stack gap="md" mt="md">
            {!twilioConfigured && (
                <Alert icon={<IconAlertTriangle size={16} />} color="yellow" variant="light">
                    {t('admin.coldcall.twilioNotConfigured', 'Twilio yapılandırılmamış — provisioning devre dışı, tüm tenant\'lar mock sağlayıcıda.')}
                </Alert>
            )}

            <Paper shadow="sm" radius="lg" withBorder style={{ overflow: 'hidden' }}>
                {isLoading ? (
                    <Center py={80}><Loader size="lg" color="violet" /></Center>
                ) : usageRows.length === 0 ? (
                    <Center py={80}>
                        <Text c="dimmed">{t('admin.coldcall.noUsage', 'Henüz Cold Call kullanımı yok.')}</Text>
                    </Center>
                ) : (
                    <Table.ScrollContainer minWidth={1100}>
                        <Table striped highlightOnHover verticalSpacing="sm" horizontalSpacing="md"
                            styles={{
                                thead: { background: 'linear-gradient(135deg, #1a1b2e 0%, #16213e 100%)' },
                                th: { fontWeight: 600, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '12px 16px', whiteSpace: 'nowrap', color: 'white' },
                            }}
                        >
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('admin.coldcall.colTenant', 'Tenant')}</Table.Th>
                                    <Table.Th>{t('admin.coldcall.colProvider', 'Sağlayıcı')}</Table.Th>
                                    <Table.Th>{t('admin.coldcall.colBalance', 'Kalan bakiye (dk)')}</Table.Th>
                                    <Table.Th>{t('admin.coldcall.colCalls', 'Çağrı')}</Table.Th>
                                    <Table.Th>{t('admin.coldcall.colTalkMinutes', 'Konuşma dk')}</Table.Th>
                                    <Table.Th>{t('admin.coldcall.colBilledMinutes', 'Faturalanan dk')}</Table.Th>
                                    <Table.Th>{t('admin.coldcall.colCogs', 'COGS $')}</Table.Th>
                                    <Table.Th>{t('admin.coldcall.colNumbersUsd', 'Numara $/ay')}</Table.Th>
                                    <Table.Th>{t('admin.coldcall.colTotalUsd', 'Toplam $')}</Table.Th>
                                    <Table.Th style={{ width: 320 }} />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {usageRows.map((row) => {
                                    const provider = row.provider ?? 'mock';
                                    const canProvision = twilioConfigured && provider !== 'twilio';
                                    const balanceKnown = typeof row.minutes_balance === 'number';
                                    const balanceColor = !balanceKnown ? 'dimmed' : row.minutes_balance! <= 0 ? 'red' : 'inherit';
                                    return (
                                        <Table.Tr key={row.tenant_id}>
                                            <Table.Td><Text size="sm" fw={500}>{row.tenant_name}</Text></Table.Td>
                                            <Table.Td>
                                                <Badge size="sm" variant="light" color={provider === 'twilio' ? 'teal' : 'gray'}>
                                                    {provider}
                                                </Badge>
                                            </Table.Td>
                                            <Table.Td>
                                                <Text size="sm" fw={600} c={balanceColor}>
                                                    {balanceKnown ? `${fmtMinutes(row.minutes_balance!)} ${t('coldcall.credit.minutesShort', 'dk')}` : '—'}
                                                </Text>
                                            </Table.Td>
                                            <Table.Td><Text size="sm">{row.calls_completed} / {row.calls_total}</Text></Table.Td>
                                            <Table.Td><Text size="sm">{fmtMinutes(row.talk_minutes)}</Text></Table.Td>
                                            <Table.Td><Text size="sm">{fmtMinutes(row.billed_minutes)}</Text></Table.Td>
                                            <Table.Td><Text size="sm">{fmtUsd(row.call_cogs_usd)}</Text></Table.Td>
                                            <Table.Td><Text size="sm">{fmtUsd(row.numbers_monthly_usd)}</Text></Table.Td>
                                            <Table.Td><Text size="sm" fw={700}>{fmtUsd(row.current_month_cost_usd)}</Text></Table.Td>
                                            <Table.Td>
                                                <Group gap={6} wrap="nowrap">
                                                    <Button
                                                        size="xs" variant="light" color="violet"
                                                        leftSection={<IconCreditCard size={14} />}
                                                        onClick={() => openGrantModal(row)}
                                                    >
                                                        {t('admin.coldcall.grantCredit', 'Kredi Yükle')}
                                                    </Button>
                                                    <Button
                                                        size="xs" variant="light" color="gray"
                                                        leftSection={<IconHistory size={14} />}
                                                        onClick={() => setLedgerTenant({ id: row.tenant_id, name: row.tenant_name })}
                                                    >
                                                        {t('admin.coldcall.history', 'Geçmiş')}
                                                    </Button>
                                                    <Tooltip
                                                        label={
                                                            !twilioConfigured
                                                                ? t('admin.coldcall.provisionDisabledNoTwilio', 'Twilio yapılandırılmamış')
                                                                : t('admin.coldcall.provisionDisabledAlready', 'Zaten Twilio üzerinde')
                                                        }
                                                        disabled={canProvision}
                                                    >
                                                        {/* span wrapper: disabled Buttons set pointer-events:none, which would
                                                            otherwise block the Tooltip's hover listener from ever firing. */}
                                                        <span>
                                                            <Button
                                                                size="xs" variant="light" color="teal"
                                                                leftSection={<IconPlugConnected size={14} />}
                                                                disabled={!canProvision}
                                                                loading={provisionMutation.isPending && provisionMutation.variables === row.tenant_id}
                                                                onClick={() => handleProvision(row)}
                                                            >
                                                                {t('admin.coldcall.provision', 'Provision')}
                                                            </Button>
                                                        </span>
                                                    </Tooltip>
                                                </Group>
                                            </Table.Td>
                                        </Table.Tr>
                                    );
                                })}
                            </Table.Tbody>
                        </Table>
                    </Table.ScrollContainer>
                )}
            </Paper>

            <Modal
                opened={!!grantTarget}
                onClose={closeGrantModal}
                title={`${t('admin.coldcall.grantCreditTitle', 'Kredi Yükle')} — ${grantTarget?.tenant_name ?? ''}`}
                size="md"
            >
                <Stack gap="md">
                    <Text size="sm" c="dimmed">
                        {t('admin.coldcall.grantCreditDesc', 'Pozitif değer yükleme, negatif değer düzeltme (aşağı) olarak kaydedilir.')}
                    </Text>
                    <NumberInput
                        label={t('admin.coldcall.minutesLabel', 'Dakika')}
                        description={t('admin.coldcall.minutesHint', '+ yükleme, − düzeltme')}
                        placeholder="0"
                        value={grantMinutesVal}
                        onChange={(v) => {
                            setGrantMinutesVal(typeof v === 'number' ? v : '');
                            // Payload değişince yeni idempotency key (codex P2): kaybolan yanıt sonrası
                            // tutarı değiştirip tekrar gönderince eski anahtarla dedup edilip düşmesin.
                            setGrantIdempotencyKey(crypto.randomUUID());
                        }}
                        allowNegative
                        allowDecimal
                        min={-100000}
                        max={100000}
                        autoFocus
                    />
                    <TextInput
                        label={t('admin.coldcall.reasonLabel', 'Açıklama')}
                        placeholder={t('admin.coldcall.reasonPlaceholder', 'örn. fatura #123')}
                        value={grantReason}
                        onChange={(e) => {
                            setGrantReason(e.currentTarget.value);
                            setGrantIdempotencyKey(crypto.randomUUID());
                        }}
                        maxLength={500}
                        required
                    />
                    <Group justify="flex-end">
                        <Button variant="default" onClick={closeGrantModal} disabled={grantMutation.isPending}>
                            {t('common.cancel', 'Vazgeç')}
                        </Button>
                        <Button
                            gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                            variant="gradient"
                            onClick={handleGrantSubmit}
                            loading={grantMutation.isPending}
                            disabled={!grantValid || grantMutation.isPending}
                        >
                            {t('admin.coldcall.submitGrant', 'Yükle')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Drawer
                opened={!!ledgerTenant}
                onClose={() => setLedgerTenant(null)}
                title={`${t('admin.coldcall.historyTitle', 'Kredi Geçmişi')} — ${ledgerTenant?.name ?? ''}`}
                position="right"
                size="xl"
            >
                {ledgerTenant && (
                    <Box>
                        <ColdCallAdminLedgerList key={ledgerTenant.id} tenantId={ledgerTenant.id} />
                    </Box>
                )}
            </Drawer>
        </Stack>
    );
}
