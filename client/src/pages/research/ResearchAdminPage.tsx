/**
 * ResearchAdminPage — INTERNAL margin/COGS panel (superadmin + ops_agent only).
 * The one surface where research dollar figures are shown: per-tenant COGS vs billed leads
 * ($/lead), harvest run history with full cost breakdowns, and the credit top-up form.
 * Client roles never reach this page (nav hidden + route guard + 403 on the API).
 */
import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
    Badge, Button, Container, Divider, Group, Loader, NumberInput, Paper, Select, SimpleGrid,
    Stack, Switch, Table, Tabs, Text, TextInput, Title, Tooltip,
} from '@mantine/core';
import { IconCoins, IconGauge, IconListDetails } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';

interface TenantCostRow {
    tenant_id: string;
    tenant_name: string | null;
    harvest_runs: number;
    failed_runs: number;
    harvest_cost_usd: string | number;
    failed_cost_usd: string | number;
    search_cost_usd: string | number;
    icp_runs: number;
    icp_cost_usd: string | number;
    enrich_runs: number;
    hunter_requests: number;
    hunter_cost_usd: string | number;
    billed_leads: number;
    credits_balance: number;
    credits_reserved: number;
    cost_per_lead_usd: string | number | null;
}

interface AdminRunRow {
    id: string;
    tenant_id: string;
    tenant_name: string | null;
    status: string;
    created_at: string;
    payload: { geography?: string } | null;
    result: {
        matches?: number;
        newly_billed?: number;
        unique_candidates?: number;
        stopped_by?: string | null;
        cost_usd?: { totalUsd?: number; searchUsd?: number; llmUsd?: number; fetchUsd?: number };
        cost_recheck?: { totalUsd?: number };
    } | null;
    error: string | null;
}

const INTERNAL_ROLES = ['superadmin', 'ops_agent'];

function usd(n: string | number | null | undefined, digits = 4): string {
    if (n === null || n === undefined || n === '') return '—';
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return `$${v.toFixed(digits)}`;
}

const STATUS_COLOR: Record<string, string> = {
    succeeded: 'green', failed: 'red', running: 'blue', queued: 'gray', canceled: 'gray',
};

interface TenantSettingsRow {
    tenant_id: string;
    research_tier: 'trial' | 'starter' | 'growth' | 'scale' | 'custom';
    monthly_lead_quota: number;
    reserve_estimate: number | null;
    auto_grant: boolean;
    last_grant_period: string | null;
}

const TIER_OPTIONS = [
    { value: 'trial', label: 'Trial' },
    { value: 'starter', label: 'Starter' },
    { value: 'growth', label: 'Growth' },
    { value: 'scale', label: 'Scale' },
    { value: 'custom', label: 'Custom' },
];

/** Controlled tier form; remounted (via key) when the selected tenant / loaded row changes, so
 *  useState initializers pick up the server values without state-sync effects. */
function TierSettingsForm({
    initial, saving, onSave, t,
}: {
    initial: TenantSettingsRow | null;
    saving: boolean;
    onSave: (form: { tier: TenantSettingsRow['research_tier']; quota: number; autoGrant: boolean }) => void;
    t: (key: string, def: string, opts?: Record<string, unknown>) => string;
}) {
    const [tier, setTier] = useState<TenantSettingsRow['research_tier']>(initial?.research_tier ?? 'trial');
    const [quota, setQuota] = useState<number>(initial?.monthly_lead_quota ?? 0);
    const [autoGrant, setAutoGrant] = useState<boolean>(initial?.auto_grant ?? true);
    return (
        <Stack gap="sm">
            <Group grow>
                <Select
                    label={t('research.admin.tier', 'Tier')}
                    data={TIER_OPTIONS}
                    value={tier}
                    onChange={(v) => setTier((v as TenantSettingsRow['research_tier']) ?? 'trial')}
                />
                <NumberInput
                    label={t('research.admin.monthlyQuota', 'Monthly lead quota')}
                    min={0} max={1_000_000}
                    value={quota}
                    onChange={(v) => setQuota(typeof v === 'number' ? v : 0)}
                />
            </Group>
            <Switch
                label={t('research.admin.autoGrant', 'Grant automatically each month')}
                checked={autoGrant}
                onChange={(e) => setAutoGrant(e.currentTarget.checked)}
            />
            {initial?.last_grant_period && (
                <Text size="xs" c="dimmed">
                    {t('research.admin.lastPeriod', 'Last granted period: {{period}}', { period: initial.last_grant_period })}
                </Text>
            )}
            <Button onClick={() => onSave({ tier, quota, autoGrant })} loading={saving} variant="light">
                {t('research.admin.saveSettings', 'Save tier settings')}
            </Button>
        </Stack>
    );
}

export default function ResearchAdminPage() {
    const { t } = useTranslation();
    const { user } = useAuth();
    const qc = useQueryClient();

    const [runTenant, setRunTenant] = useState<string | null>(null);
    const [grantTenant, setGrantTenant] = useState<string | null>(null);
    const [grantAmount, setGrantAmount] = useState<number>(50);
    const [grantReason, setGrantReason] = useState('');
    // ONE idempotency key per logical grant, BOUND to the grant parameters: a retry after an
    // ambiguous timeout (same tenant/amount/reason) reuses the key so the server dedups, while
    // EDITING any parameter starts a new logical grant (deps change → fresh key — otherwise the
    // server would silently no-op the edited grant against the old key). `grantGen` bumps on a
    // confirmed success so the NEXT identical grant is a new logical grant too.
    const [grantGen, setGrantGen] = useState(0);
    const grantKey = useMemo(
        () => crypto.randomUUID(),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps ARE the logical-grant identity
        [grantTenant, grantAmount, grantReason, grantGen]
    );

    const isInternal = INTERNAL_ROLES.includes(user?.role || '');

    const costsQuery = useQuery<{ data: TenantCostRow[] }>({
        queryKey: ['research', 'admin', 'costs'],
        queryFn: async () => (await api.get('/research/admin/costs')).data,
        enabled: isInternal,
    });
    const rows = useMemo(() => costsQuery.data?.data ?? [], [costsQuery.data]);

    const runsQuery = useQuery<{ data: AdminRunRow[] }>({
        queryKey: ['research', 'admin', 'runs', runTenant],
        queryFn: async () => {
            const params = new URLSearchParams({ limit: '50' });
            if (runTenant) params.set('tenant_id', runTenant);
            return (await api.get(`/research/admin/runs?${params}`)).data;
        },
        enabled: isInternal,
    });
    const runs = runsQuery.data?.data ?? [];

    const totals = useMemo(() => {
        const cost = rows.reduce((s, r) => s + Number(r.harvest_cost_usd || 0), 0);
        const billed = rows.reduce((s, r) => s + r.billed_leads, 0);
        const reserved = rows.reduce((s, r) => s + r.credits_reserved, 0);
        const failed = rows.reduce((s, r) => s + r.failed_runs, 0);
        const hunterReq = rows.reduce((s, r) => s + Number(r.hunter_requests || 0), 0);
        const hunterCost = rows.reduce((s, r) => s + Number(r.hunter_cost_usd || 0), 0);
        return { cost, billed, reserved, failed, hunterReq, hunterCost, perLead: billed > 0 ? cost / billed : null };
    }, [rows]);

    // ── Tier / monthly quota settings (no Stripe — operator-managed) ──────────
    const [settingsTenant, setSettingsTenant] = useState<string | null>(null);

    const settingsQuery = useQuery<{ data: TenantSettingsRow | null }>({
        queryKey: ['research', 'admin', 'settings', settingsTenant],
        queryFn: async () => (await api.get(`/research/admin/settings?tenant_id=${settingsTenant}`)).data,
        enabled: isInternal && !!settingsTenant,
    });

    const saveSettingsMut = useMutation({
        mutationFn: async (form: { tier: TenantSettingsRow['research_tier']; quota: number; autoGrant: boolean }) =>
            (await api.put('/research/admin/settings', {
                tenant_id: settingsTenant,
                research_tier: form.tier,
                monthly_lead_quota: form.quota,
                auto_grant: form.autoGrant,
            })).data,
        onSuccess: () => {
            showSuccess(t('research.admin.settingsSaved', 'Tier settings saved'));
            qc.invalidateQueries({ queryKey: ['research', 'admin', 'settings', settingsTenant] });
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const periodGrantsMut = useMutation({
        mutationFn: async () => (await api.post('/research/admin/quota/apply-period-grants')).data as { granted: number },
        onSuccess: (d) => {
            showSuccess(t('research.admin.periodApplied', 'Period grants applied to {{count}} tenants', { count: d.granted }));
            qc.invalidateQueries({ queryKey: ['research', 'admin', 'costs'] });
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const grantMut = useMutation({
        mutationFn: async () =>
            (await api.post('/research/admin/credits/grant', {
                tenant_id: grantTenant,
                amount: grantAmount,
                ...(grantReason.trim() ? { reason: grantReason.trim() } : {}),
                idempotency_key: grantKey,
            })).data as { balance: number },
        onSuccess: (d) => {
            showSuccess(t('research.admin.granted', 'Credits granted — new balance: {{balance}}', { balance: d.balance }));
            setGrantGen((g) => g + 1); // next logical grant gets a fresh key
            qc.invalidateQueries({ queryKey: ['research', 'admin', 'costs'] });
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    // Route guard: client roles never see this page (nav is hidden too; API 403s regardless).
    if (!isInternal) return <Navigate to="/research" replace />;

    const tenantOptions = rows.map((r) => ({ value: r.tenant_id, label: r.tenant_name || r.tenant_id.slice(0, 8) }));

    return (
        <Container size="xl" py="lg">
            <Stack gap="lg">
                <div>
                    <Title order={2}>{t('research.admin.title', 'Research — COGS & Margin (internal)')}</Title>
                    <Text c="dimmed" size="sm">
                        {t('research.admin.subtitle', 'Real per-tenant research costs vs billed leads. Customers never see these numbers.')}
                    </Text>
                </div>

                {/* Fleet totals */}
                <SimpleGrid cols={{ base: 2, md: 5 }} spacing="md">
                    <Paper withBorder radius="md" p="md">
                        <Text size="xs" c="dimmed" tt="uppercase">{t('research.admin.totalCogs', 'Total harvest COGS')}</Text>
                        <Text size="xl" fw={700}>{usd(totals.cost)}</Text>
                        {totals.failed > 0 && (
                            <Text size="xs" c="orange">
                                {t('research.admin.failedNote', '{{count}} failed runs not included', { count: totals.failed })}
                            </Text>
                        )}
                    </Paper>
                    <Paper withBorder radius="md" p="md">
                        <Text size="xs" c="dimmed" tt="uppercase">{t('research.admin.billedLeads', 'Billed leads')}</Text>
                        <Text size="xl" fw={700}>{totals.billed}</Text>
                    </Paper>
                    <Paper withBorder radius="md" p="md">
                        <Text size="xs" c="dimmed" tt="uppercase">{t('research.admin.blended', 'Blended $/lead')}</Text>
                        <Text size="xl" fw={700}>{totals.perLead != null ? usd(totals.perLead) : '—'}</Text>
                    </Paper>
                    <Paper withBorder radius="md" p="md">
                        <Tooltip label={t('research.admin.hunterHint', 'Hunter enrichment requests (1 credit each) — a separate product line, not part of per-lead harvest COGS. $ is 0 on the free/trial plan.')} multiline w={260}>
                            <Text size="xs" c="dimmed" tt="uppercase" style={{ cursor: 'help' }}>{t('research.admin.enrichCogs', 'Hunter enrichment')}</Text>
                        </Tooltip>
                        <Text size="xl" fw={700}>{totals.hunterReq}</Text>
                        <Text size="xs" c="dimmed">{t('research.admin.hunterReqUnit', '{{count}} requests · {{cost}}', { count: totals.hunterReq, cost: usd(totals.hunterCost) })}</Text>
                    </Paper>
                    <Paper withBorder radius="md" p="md">
                        <Text size="xs" c="dimmed" tt="uppercase">{t('research.admin.reserved', 'Open reservations')}</Text>
                        <Text size="xl" fw={700}>{totals.reserved}</Text>
                    </Paper>
                </SimpleGrid>

                <Tabs defaultValue="tenants" keepMounted={false}>
                    <Tabs.List mb="md">
                        <Tabs.Tab value="tenants" leftSection={<IconGauge size={16} />}>
                            {t('research.admin.tabTenants', 'Per tenant')}
                        </Tabs.Tab>
                        <Tabs.Tab value="runs" leftSection={<IconListDetails size={16} />}>
                            {t('research.admin.tabRuns', 'Run history')}
                        </Tabs.Tab>
                        <Tabs.Tab value="credits" leftSection={<IconCoins size={16} />}>
                            {t('research.admin.tabCredits', 'Grant credits')}
                        </Tabs.Tab>
                    </Tabs.List>

                    <Tabs.Panel value="tenants">
                        <Paper withBorder radius="md" p="md">
                            {costsQuery.isLoading ? (
                                <Group justify="center" py="xl"><Loader /></Group>
                            ) : rows.length === 0 ? (
                                <Text c="dimmed" ta="center" py="xl">{t('research.admin.noData', 'No research activity yet.')}</Text>
                            ) : (
                                <Table.ScrollContainer minWidth={1060}>
                                    <Table striped highlightOnHover verticalSpacing="sm">
                                        <Table.Thead>
                                            <Table.Tr>
                                                <Table.Th>{t('research.admin.tenant', 'Tenant')}</Table.Th>
                                                <Table.Th ta="right">{t('research.admin.runs', 'Runs')}</Table.Th>
                                                <Table.Th ta="right">{t('research.admin.failed', 'Failed')}</Table.Th>
                                                <Table.Th ta="right">
                                                    <Tooltip label={t('research.admin.failedCostHint', "Failed run attempts' partial spend (not included in the total COGS line)")}>
                                                        <span>{t('research.admin.failedCost', 'Failed $')}</span>
                                                    </Tooltip>
                                                </Table.Th>
                                                <Table.Th ta="right">{t('research.admin.cogs', 'COGS')}</Table.Th>
                                                <Table.Th ta="right">
                                                    <Tooltip label={t('research.admin.searchHint', 'Search-engine share of COGS (already inside the total — do not add)')}>
                                                        <span>{t('research.admin.search', 'Search $')}</span>
                                                    </Tooltip>
                                                </Table.Th>
                                                <Table.Th ta="right">
                                                    <Tooltip label={t('research.admin.setupHint', 'ICP generation (Opus) spend — setup cost, separate from harvest COGS')}>
                                                        <span>{t('research.admin.setup', 'Setup $')}</span>
                                                    </Tooltip>
                                                </Table.Th>
                                                <Table.Th ta="right">
                                                    <Tooltip label={t('research.admin.hunterHint', 'Hunter enrichment requests (1 credit each) — a separate product line, not part of per-lead harvest COGS. $ is 0 on the free/trial plan.')} multiline w={260}>
                                                        <span>{t('research.admin.hunterReqCol', 'Hunter req')}</span>
                                                    </Tooltip>
                                                </Table.Th>
                                                <Table.Th ta="right">{t('research.admin.hunterCostCol', 'Hunter $')}</Table.Th>
                                                <Table.Th ta="right">{t('research.admin.billed', 'Billed')}</Table.Th>
                                                <Table.Th ta="right">{t('research.admin.perLead', '$/lead')}</Table.Th>
                                                <Table.Th ta="right">{t('research.admin.balance', 'Balance')}</Table.Th>
                                                <Table.Th ta="right">{t('research.admin.reservedCol', 'Reserved')}</Table.Th>
                                            </Table.Tr>
                                        </Table.Thead>
                                        <Table.Tbody>
                                            {rows.map((r) => (
                                                <Table.Tr key={r.tenant_id}>
                                                    <Table.Td>
                                                        <Text size="sm" fw={600}>{r.tenant_name || r.tenant_id.slice(0, 8)}</Text>
                                                    </Table.Td>
                                                    <Table.Td ta="right">{r.harvest_runs}</Table.Td>
                                                    <Table.Td ta="right">
                                                        {r.failed_runs > 0
                                                            ? <Badge color="orange" variant="light">{r.failed_runs}</Badge>
                                                            : <Text size="sm" c="dimmed">0</Text>}
                                                    </Table.Td>
                                                    <Table.Td ta="right"><Text size="sm" ff="monospace" c={Number(r.failed_cost_usd) > 0 ? 'orange' : 'dimmed'}>{usd(r.failed_cost_usd)}</Text></Table.Td>
                                                    <Table.Td ta="right"><Text size="sm" ff="monospace">{usd(r.harvest_cost_usd)}</Text></Table.Td>
                                                    <Table.Td ta="right"><Text size="sm" ff="monospace" c="dimmed">{usd(r.search_cost_usd)}</Text></Table.Td>
                                                    <Table.Td ta="right"><Text size="sm" ff="monospace" c="dimmed">{usd(r.icp_cost_usd)}</Text></Table.Td>
                                                    <Table.Td ta="right"><Text size="sm" c={Number(r.hunter_requests) > 0 ? undefined : 'dimmed'}>{r.hunter_requests}</Text></Table.Td>
                                                    <Table.Td ta="right"><Text size="sm" ff="monospace" c="dimmed">{usd(r.hunter_cost_usd)}</Text></Table.Td>
                                                    <Table.Td ta="right"><Text size="sm" fw={600}>{r.billed_leads}</Text></Table.Td>
                                                    <Table.Td ta="right"><Text size="sm" ff="monospace">{usd(r.cost_per_lead_usd)}</Text></Table.Td>
                                                    <Table.Td ta="right">{r.credits_balance}</Table.Td>
                                                    <Table.Td ta="right">{r.credits_reserved}</Table.Td>
                                                </Table.Tr>
                                            ))}
                                        </Table.Tbody>
                                    </Table>
                                </Table.ScrollContainer>
                            )}
                        </Paper>
                    </Tabs.Panel>

                    <Tabs.Panel value="runs">
                        <Paper withBorder radius="md" p="md">
                            <Group mb="sm">
                                <Select
                                    placeholder={t('research.admin.allTenants', 'All tenants')}
                                    data={tenantOptions}
                                    value={runTenant}
                                    onChange={setRunTenant}
                                    clearable searchable w={240} size="xs"
                                />
                            </Group>
                            {runsQuery.isLoading ? (
                                <Group justify="center" py="xl"><Loader /></Group>
                            ) : runs.length === 0 ? (
                                <Text c="dimmed" ta="center" py="xl">{t('research.admin.noRuns', 'No harvest runs yet.')}</Text>
                            ) : (
                                <Table.ScrollContainer minWidth={980}>
                                    <Table striped highlightOnHover verticalSpacing="sm">
                                        <Table.Thead>
                                            <Table.Tr>
                                                <Table.Th>{t('research.admin.when', 'When')}</Table.Th>
                                                <Table.Th>{t('research.admin.tenant', 'Tenant')}</Table.Th>
                                                <Table.Th>{t('research.admin.geography', 'Geography')}</Table.Th>
                                                <Table.Th ta="center">{t('research.admin.status', 'Status')}</Table.Th>
                                                <Table.Th ta="right">{t('research.admin.matches', 'Match')}</Table.Th>
                                                <Table.Th ta="right">{t('research.admin.newBilled', 'New billed')}</Table.Th>
                                                <Table.Th ta="right">{t('research.admin.cost', 'Cost')}</Table.Th>
                                                <Table.Th>{t('research.admin.stoppedBy', 'Stopped by')}</Table.Th>
                                            </Table.Tr>
                                        </Table.Thead>
                                        <Table.Tbody>
                                            {runs.map((r) => (
                                                <Table.Tr key={r.id}>
                                                    <Table.Td>
                                                        <Text size="xs">{new Date(r.created_at).toLocaleString()}</Text>
                                                    </Table.Td>
                                                    <Table.Td><Text size="sm">{r.tenant_name || r.tenant_id.slice(0, 8)}</Text></Table.Td>
                                                    <Table.Td><Text size="sm">{r.payload?.geography || '—'}</Text></Table.Td>
                                                    <Table.Td ta="center">
                                                        <Badge size="sm" color={STATUS_COLOR[r.status] ?? 'gray'} variant="light">{r.status}</Badge>
                                                    </Table.Td>
                                                    <Table.Td ta="right">{r.result?.matches ?? '—'}</Table.Td>
                                                    <Table.Td ta="right"><Text size="sm" fw={600}>{r.result?.newly_billed ?? '—'}</Text></Table.Td>
                                                    <Table.Td ta="right">
                                                        <Tooltip
                                                            disabled={!r.result?.cost_usd}
                                                            label={r.result?.cost_usd
                                                                ? `search ${usd(r.result.cost_usd.searchUsd)} · llm ${usd(r.result.cost_usd.llmUsd)} · fetch ${usd(r.result.cost_usd.fetchUsd)}`
                                                                : ''}
                                                        >
                                                            <Text size="sm" ff="monospace">{usd(r.result?.cost_usd?.totalUsd)}</Text>
                                                        </Tooltip>
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <Text size="xs" c="dimmed">{r.result?.stopped_by || (r.error ? `⚠ ${r.error.slice(0, 60)}` : '—')}</Text>
                                                    </Table.Td>
                                                </Table.Tr>
                                            ))}
                                        </Table.Tbody>
                                    </Table>
                                </Table.ScrollContainer>
                            )}
                        </Paper>
                    </Tabs.Panel>

                    <Tabs.Panel value="credits">
                        <Group align="flex-start" gap="lg" wrap="wrap">
                        <Paper withBorder radius="md" p="md" maw={520} style={{ flex: 1, minWidth: 320 }}>
                            <Stack gap="sm">
                                <Text size="sm" c="dimmed">
                                    {t('research.admin.grantHint', 'Top up a tenant’s lead quota. Grants are idempotent (safe to retry).')}
                                </Text>
                                <Select
                                    label={t('research.admin.tenant', 'Tenant')}
                                    data={tenantOptions}
                                    value={grantTenant}
                                    onChange={setGrantTenant}
                                    searchable
                                />
                                <NumberInput
                                    label={t('research.admin.amount', 'Credits (leads)')}
                                    min={1} max={100000}
                                    value={grantAmount}
                                    onChange={(v) => setGrantAmount(typeof v === 'number' ? v : 50)}
                                />
                                <TextInput
                                    label={t('research.admin.reason', 'Reason (optional)')}
                                    value={grantReason}
                                    onChange={(e) => setGrantReason(e.currentTarget.value)}
                                    placeholder="trial / top-up / correction…"
                                />
                                <Button
                                    onClick={() => grantMut.mutate()}
                                    disabled={!grantTenant || grantAmount < 1}
                                    loading={grantMut.isPending}
                                    leftSection={<IconCoins size={16} />}
                                >
                                    {t('research.admin.grant', 'Grant credits')}
                                </Button>
                            </Stack>
                        </Paper>

                        {/* Tier / monthly quota (no Stripe — the operator is the billing system) */}
                        <Paper withBorder radius="md" p="md" maw={520} style={{ flex: 1, minWidth: 320 }}>
                            <Stack gap="sm">
                                <Text size="sm" c="dimmed">
                                    {t('research.admin.tierHint', 'Tier drives the monthly auto-grant and per-run reservation size. The worker applies period grants automatically; the button forces it now (idempotent).')}
                                </Text>
                                <Select
                                    label={t('research.admin.tenant', 'Tenant')}
                                    data={tenantOptions}
                                    value={settingsTenant}
                                    onChange={setSettingsTenant}
                                    searchable
                                />
                                {settingsTenant && (
                                    settingsQuery.isLoading ? (
                                        <Group justify="center" py="md"><Loader size="sm" /></Group>
                                    ) : (
                                        <TierSettingsForm
                                            key={`${settingsTenant}:${settingsQuery.data?.data?.last_grant_period ?? ''}:${settingsQuery.dataUpdatedAt}`}
                                            initial={settingsQuery.data?.data ?? null}
                                            saving={saveSettingsMut.isPending}
                                            onSave={(form) => saveSettingsMut.mutate(form)}
                                            t={t}
                                        />
                                    )
                                )}
                                <Divider my="xs" />
                                <Button
                                    variant="default"
                                    onClick={() => periodGrantsMut.mutate()}
                                    loading={periodGrantsMut.isPending}
                                >
                                    {t('research.admin.applyPeriod', 'Apply this month’s grants now')}
                                </Button>
                            </Stack>
                        </Paper>
                        </Group>
                    </Tabs.Panel>
                </Tabs>
            </Stack>
        </Container>
    );
}
