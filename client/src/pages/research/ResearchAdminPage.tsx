/**
 * ResearchAdminPage — INTERNAL margin/COGS panel (superadmin + ops_agent only).
 * The one surface where research dollar figures are shown: per-tenant COGS vs billed leads
 * ($/lead), harvest run history with full cost breakdowns, and the credit top-up form.
 * Client roles never reach this page (nav hidden + route guard + 403 on the API).
 */
import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
    Autocomplete, Badge, Button, Container, Divider, Group, Loader, NumberInput, Paper, Select, SimpleGrid,
    Stack, Switch, Table, Tabs, Text, TextInput, Title, Tooltip,
} from '@mantine/core';
import { IconCoins, IconCpu, IconGauge, IconListDetails } from '@tabler/icons-react';
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

interface CostBreakdownStep {
    job_type: string;
    role: string | null;
    model: string | null;
    runs: number;
    total_usd: number;
}
interface CostBreakdownProvider {
    provider: string;
    label: string;
    model: string | null;
    cost_usd: number;
    calls: number;
    input_tokens: number;
    output_tokens: number;
}
interface CostBreakdown {
    steps: CostBreakdownStep[];
    providers: CostBreakdownProvider[];
    roleModels: Record<string, { model: string; source: 'override' | 'default'; provider: string }>;
    totals: { ai_usd: number; runs: number };
}

interface LlmConfigRole {
    role: 'strategy' | 'search' | 'reading';
    provider: string;
    provider_label: string;
    model: string;
    source: 'override' | 'default';
    catalog: { value: string; label: string }[];
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

// Human-readable step names, keyed by job type. Falls back to the raw type.
function stepLabel(t: (k: string, d: string) => string, jobType: string): string {
    const map: Record<string, string> = {
        'icp:generate': t('research.admin.stepIcpGenerate', 'ICP generation'),
        'icp:revise': t('research.admin.stepIcpRevise', 'ICP revision'),
        'geo:analyze': t('research.admin.stepGeo', 'Geo analysis'),
        'offer:generate': t('research.admin.stepOffer', 'Offer generation'),
        'hs:match': t('research.admin.stepHs', 'HS code match'),
        'profile:crawl': t('research.admin.stepProfile', 'Profile crawl (site)'),
        'harvest:run': t('research.admin.stepHarvest', 'Harvest (discovery)'),
        'channels:discover': t('research.admin.stepChannels', 'Channel discovery'),
        'maps:harvest': t('research.admin.stepMaps', 'Maps harvest'),
        'trade:harvest': t('research.admin.stepTrade', 'Trade data harvest'),
    };
    return map[jobType] ?? jobType;
}

/** Editable model picker for one router role. Remounted (via key) when the server value
 *  changes so the draft re-initializes without a state-sync effect. Provider is fixed. */
function ModelEditor({
    row, saving, onSave, onReset, t,
}: {
    row: LlmConfigRole;
    saving: boolean;
    onSave: (model: string) => void;
    onReset: () => void;
    t: (key: string, def: string, opts?: Record<string, unknown>) => string;
}) {
    const [draft, setDraft] = useState(row.model);
    const dirty = draft.trim() !== row.model;
    return (
        <Paper withBorder radius="md" p="md">
            <Stack gap="xs">
                <Group justify="space-between">
                    <Text size="sm" fw={600} tt="capitalize">{row.role}</Text>
                    <Badge variant="light" color={row.source === 'override' ? 'blue' : 'gray'}>
                        {row.source === 'override'
                            ? t('research.admin.modelOverride', 'Custom')
                            : t('research.admin.modelDefault', 'Default (env)')}
                    </Badge>
                </Group>
                <Text size="xs" c="dimmed">{row.provider_label}</Text>
                <Autocomplete
                    data={row.catalog.map((c) => c.value)}
                    value={draft}
                    onChange={setDraft}
                    placeholder="model id"
                    size="sm"
                />
                <Group gap="xs">
                    <Button
                        size="xs"
                        variant="light"
                        disabled={!dirty || draft.trim() === ''}
                        loading={saving}
                        onClick={() => onSave(draft.trim())}
                    >
                        {t('research.admin.modelSave', 'Save')}
                    </Button>
                    <Button
                        size="xs"
                        variant="subtle"
                        color="gray"
                        disabled={row.source !== 'override' || saving}
                        onClick={onReset}
                    >
                        {t('research.admin.modelReset', 'Reset to default')}
                    </Button>
                </Group>
            </Stack>
        </Paper>
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

    // ── Step / model cost breakdown + editable per-role models ────────────────
    const breakdownQuery = useQuery<{ data: CostBreakdown }>({
        queryKey: ['research', 'admin', 'cost-breakdown'],
        queryFn: async () => (await api.get('/research/admin/cost-breakdown')).data,
        enabled: isInternal,
    });
    const breakdown = breakdownQuery.data?.data;

    const llmConfigQuery = useQuery<{ data: { roles: LlmConfigRole[] } }>({
        queryKey: ['research', 'admin', 'llm-config'],
        queryFn: async () => (await api.get('/research/admin/llm-config')).data,
        enabled: isInternal,
    });
    const llmRoles = llmConfigQuery.data?.data?.roles ?? [];

    const saveModelMut = useMutation({
        mutationFn: async (v: { role: string; model: string | null }) =>
            (await api.put('/research/admin/llm-config', v)).data,
        onSuccess: () => {
            showSuccess(t('research.admin.modelSaved', 'Model updated'));
            qc.invalidateQueries({ queryKey: ['research', 'admin', 'llm-config'] });
            qc.invalidateQueries({ queryKey: ['research', 'admin', 'cost-breakdown'] });
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
                        <Tabs.Tab value="models" leftSection={<IconCpu size={16} />}>
                            {t('research.admin.tabModels', 'Models & steps')}
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

                    <Tabs.Panel value="models">
                        <Stack gap="lg">
                            {/* Editable model per role */}
                            <Paper withBorder radius="md" p="md">
                                <Text size="sm" fw={600} mb="xs">{t('research.admin.modelsTitle', 'Which model each role runs')}</Text>
                                <Text size="xs" c="dimmed" mb="md">
                                    {t('research.admin.modelsHint', 'The provider per role is fixed in code; the model it runs is editable here. Changes apply to new runs within ~30s. Reset reverts to the environment default.')}
                                </Text>
                                {llmConfigQuery.isLoading ? (
                                    <Group justify="center" py="md"><Loader size="sm" /></Group>
                                ) : (
                                    <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
                                        {llmRoles.map((r) => (
                                            <ModelEditor
                                                key={`${r.role}:${r.model}:${r.source}`}
                                                row={r}
                                                saving={saveModelMut.isPending}
                                                onSave={(model) => saveModelMut.mutate({ role: r.role, model })}
                                                onReset={() => saveModelMut.mutate({ role: r.role, model: null })}
                                                t={t}
                                            />
                                        ))}
                                    </SimpleGrid>
                                )}
                            </Paper>

                            {/* Per-step AI spend */}
                            <Paper withBorder radius="md" p="md">
                                <Group justify="space-between" mb="xs">
                                    <Text size="sm" fw={600}>{t('research.admin.stepCostsTitle', 'Spend by step')}</Text>
                                    {breakdown && (
                                        <Text size="sm" c="dimmed">
                                            {t('research.admin.totalAiSpend', 'Total AI spend: {{cost}}', { cost: usd(breakdown.totals.ai_usd) })}
                                        </Text>
                                    )}
                                </Group>
                                <Text size="xs" c="dimmed" mb="md">
                                    {t('research.admin.stepCostsHint', 'Every metered AI step — including the wizard steps (profile crawl, geo, offer, ICP revise) that the per-tenant COGS line does not include.')}
                                </Text>
                                {breakdownQuery.isLoading ? (
                                    <Group justify="center" py="md"><Loader size="sm" /></Group>
                                ) : !breakdown || breakdown.steps.length === 0 ? (
                                    <Text c="dimmed" ta="center" py="lg">{t('research.admin.noData', 'No research activity yet.')}</Text>
                                ) : (
                                    <Table.ScrollContainer minWidth={640}>
                                        <Table striped highlightOnHover verticalSpacing="sm">
                                            <Table.Thead>
                                                <Table.Tr>
                                                    <Table.Th>{t('research.admin.step', 'Step')}</Table.Th>
                                                    <Table.Th>{t('research.admin.role', 'Role')}</Table.Th>
                                                    <Table.Th>{t('research.admin.model', 'Model')}</Table.Th>
                                                    <Table.Th ta="right">{t('research.admin.runs', 'Runs')}</Table.Th>
                                                    <Table.Th ta="right">{t('research.admin.spend', 'Spend')}</Table.Th>
                                                </Table.Tr>
                                            </Table.Thead>
                                            <Table.Tbody>
                                                {breakdown.steps.map((s) => (
                                                    <Table.Tr key={s.job_type}>
                                                        <Table.Td><Text size="sm" fw={600}>{stepLabel(t, s.job_type)}</Text></Table.Td>
                                                        <Table.Td>
                                                            {s.role
                                                                ? <Badge variant="light" color={s.role === 'mixed' ? 'grape' : 'teal'}>{s.role}</Badge>
                                                                : <Text size="sm" c="dimmed">—</Text>}
                                                        </Table.Td>
                                                        <Table.Td><Text size="sm" ff="monospace" c="dimmed">{s.model ?? '—'}</Text></Table.Td>
                                                        <Table.Td ta="right">{s.runs}</Table.Td>
                                                        <Table.Td ta="right"><Text size="sm" ff="monospace" fw={600}>{usd(s.total_usd)}</Text></Table.Td>
                                                    </Table.Tr>
                                                ))}
                                            </Table.Tbody>
                                        </Table>
                                    </Table.ScrollContainer>
                                )}
                            </Paper>

                            {/* Per-model / provider historical spend */}
                            <Paper withBorder radius="md" p="md">
                                <Text size="sm" fw={600} mb="xs">{t('research.admin.modelCostsTitle', 'Spend by model')}</Text>
                                <Text size="xs" c="dimmed" mb="md">
                                    {t('research.admin.modelCostsHint', 'Historical spend attributed per provider/model, recomputed at current rates.')}
                                </Text>
                                {breakdownQuery.isLoading ? (
                                    <Group justify="center" py="md"><Loader size="sm" /></Group>
                                ) : !breakdown || breakdown.providers.length === 0 ? (
                                    <Text c="dimmed" ta="center" py="lg">{t('research.admin.noData', 'No research activity yet.')}</Text>
                                ) : (
                                    <Table.ScrollContainer minWidth={720}>
                                        <Table striped highlightOnHover verticalSpacing="sm">
                                            <Table.Thead>
                                                <Table.Tr>
                                                    <Table.Th>{t('research.admin.provider', 'Provider')}</Table.Th>
                                                    <Table.Th>{t('research.admin.model', 'Model')}</Table.Th>
                                                    <Table.Th ta="right">{t('research.admin.calls', 'Calls')}</Table.Th>
                                                    <Table.Th ta="right">{t('research.admin.tokens', 'Tokens (in/out)')}</Table.Th>
                                                    <Table.Th ta="right">{t('research.admin.spend', 'Spend')}</Table.Th>
                                                </Table.Tr>
                                            </Table.Thead>
                                            <Table.Tbody>
                                                {breakdown.providers.map((p) => (
                                                    <Table.Tr key={`${p.provider}:${p.model ?? ''}`}>
                                                        <Table.Td><Text size="sm" fw={600}>{p.label}</Text></Table.Td>
                                                        <Table.Td><Text size="sm" ff="monospace" c="dimmed">{p.model ?? '—'}</Text></Table.Td>
                                                        <Table.Td ta="right">{p.calls}</Table.Td>
                                                        <Table.Td ta="right"><Text size="xs" c="dimmed">{p.input_tokens.toLocaleString()} / {p.output_tokens.toLocaleString()}</Text></Table.Td>
                                                        <Table.Td ta="right"><Text size="sm" ff="monospace" fw={600}>{usd(p.cost_usd)}</Text></Table.Td>
                                                    </Table.Tr>
                                                ))}
                                            </Table.Tbody>
                                        </Table>
                                    </Table.ScrollContainer>
                                )}
                            </Paper>
                        </Stack>
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
