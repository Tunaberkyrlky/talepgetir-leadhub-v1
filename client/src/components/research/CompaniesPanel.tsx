/**
 * CompaniesPanel — customer-facing harvested-leads view (Y1).
 * Pick a project → an approved ICP → run a capped harvest for a geography, watch it live, and
 * browse the verdict-aware companies list (per-ICP truth, not the rollup). Credits (the lead
 * quota) surface strictly as COUNTS — dollar costs are internal-only and never reach this panel.
 */
import { useEffect, useMemo, useState } from 'react';
import {
    Alert, Badge, Button, Group, Loader, Pagination, Paper, SegmentedControl, Select,
    Stack, Table, Text, TextInput, Tooltip,
} from '@mantine/core';
import { IconInfoCircle, IconPlayerPlay, IconWorld, IconArrowRight } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';
import type { ResearchIcp } from './IcpCard';

interface ResearchProject {
    id: string;
    name: string;
}

interface CompanyRow {
    id: string;
    name: string;
    domain: string | null;
    website: string | null;
    country: string | null;
    city: string | null;
    status: 'match' | 'partial' | 'eliminated' | 'review';
    score: number | null;
    evidence: string | null;
    elimination_reason: string | null;
    /** WP4 personalization from the same validation pass (match/partial firms). */
    hooks?: string[] | null;
    angle_suggestion?: string | null;
    verdict_created_at?: string;
    /** Set once the company was handed off to the CRM (research → companies export). */
    crm_company_id?: string | null;
}

interface HarvestJob {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    progress: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    error: string | null;
}

const STATUS_COLOR: Record<CompanyRow['status'], string> = {
    match: 'green',
    partial: 'yellow',
    eliminated: 'red',
    review: 'gray',
};

const JOB_RUNNING = (s?: string) => s === 'queued' || s === 'running';

function scoreColor(score: number | null): string {
    if (score == null) return 'gray';
    if (score >= 80) return 'green';
    if (score >= 60) return 'lime';
    if (score >= 40) return 'yellow';
    return 'gray';
}

const PAGE_SIZE = 25;

export default function CompaniesPanel() {
    const { t } = useTranslation();
    const qc = useQueryClient();

    const [projectId, setProjectId] = useState<string | null>(null);
    const [icpId, setIcpId] = useState<string | null>(null);
    const [status, setStatus] = useState<string>('all');
    const [page, setPage] = useState(1);
    const [geography, setGeography] = useState('');
    // Approved geography cell (WP2 sub-ICP) — when set, the run posts geo_id and the free-text
    // geography is ignored (the engine defaults to the cell's country + localized spec).
    const [geoId, setGeoId] = useState<string | null>(null);
    const [runJobId, setRunJobId] = useState<string | null>(null);
    // Discovery source: 'web' (search engines, default) or 'maps' (Google Maps / 2GIS business
    // scrape — CIS geographies route to 2GIS). Both run the same capped, billed harvest.
    const [source, setSource] = useState<'web' | 'maps'>('web');

    const projectsQuery = useQuery<{ data: ResearchProject[] }>({
        queryKey: ['research', 'projects'],
        queryFn: async () => (await api.get('/research/projects')).data,
    });
    const projects = useMemo(() => projectsQuery.data?.data ?? [], [projectsQuery.data]);

    // Auto-select the only project (common case) so the panel is usable in one click.
    useEffect(() => {
        if (!projectId && projects.length === 1) setProjectId(projects[0].id);
    }, [projectId, projects]);

    const icpsQuery = useQuery<{ data: ResearchIcp[] }>({
        queryKey: ['research', 'icps', projectId],
        queryFn: async () => (await api.get(`/research/icps?project_id=${projectId}`)).data,
        enabled: !!projectId,
    });
    const icps = icpsQuery.data?.data ?? [];
    const selectedIcp = icps.find((i) => i.id === icpId) ?? null;

    // Approved geo cells for the selected ICP feed the launcher's cell Select (free text stays
    // available as a fallback — no geo cells means byte-identical legacy behavior).
    const geosQuery = useQuery<{ data: { id: string; country: string; status: string }[] }>({
        queryKey: ['research', 'geographies', icpId],
        queryFn: async () => (await api.get(`/research/geographies?icp_id=${icpId}`)).data,
        enabled: !!icpId,
    });
    const approvedGeos = useMemo(
        () => (geosQuery.data?.data ?? []).filter((g) => g.status === 'approved'),
        [geosQuery.data]
    );
    // A cell can be demoted (re-analysis/edit) while selected — fall back to free text then.
    useEffect(() => {
        if (geoId && !approvedGeos.some((g) => g.id === geoId)) setGeoId(null);
    }, [geoId, approvedGeos]);

    const creditsQuery = useQuery<{ balance: number; available: number; reserved: number }>({
        queryKey: ['research', 'credits'],
        queryFn: async () => (await api.get('/research/harvest/credits')).data,
    });
    const credits = creditsQuery.data;

    const companiesQuery = useQuery<{ data: CompanyRow[]; pagination: { total: number } }>({
        queryKey: ['research', 'companies', icpId, status, page],
        queryFn: async () => {
            const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
            if (icpId) params.set('icp_id', icpId);
            if (status !== 'all') params.set('status', status);
            return (await api.get(`/research/harvest/companies?${params}`)).data;
        },
        enabled: !!icpId,
    });
    const companies = companiesQuery.data?.data ?? [];
    const total = companiesQuery.data?.pagination.total ?? 0;

    const runMut = useMutation({
        mutationFn: async () => {
            const job = (await api.post('/research/harvest/run', {
                icp_id: icpId,
                source,
                ...(geoId ? { geo_id: geoId } : { geography: geography.trim() }),
            })).data as HarvestJob;
            setRunJobId(job.id);
            return job;
        },
        onError: (err: unknown) => {
            // 409 = a harvest for this ICP is already in flight — ADOPT it (watch its progress)
            // instead of just toasting; the server returns the existing job id.
            const resp = (err as { response?: { status?: number; data?: { job_id?: string } } }).response;
            if (resp?.status === 409 && resp.data?.job_id) {
                setRunJobId(resp.data.job_id);
                return;
            }
            showErrorFromApi(err);
        },
    });

    // Hand MATCHes off to the CRM (stage 'cold'): dedups prior exports + existing CRM domains.
    const exportMut = useMutation({
        mutationFn: async () =>
            (await api.post('/research/harvest/companies/export', { icp_id: icpId })).data as {
                total_matches: number; exported: number; linked_existing: number; already_exported: number;
            },
        onSuccess: (d) => {
            showSuccess(
                t('research.export.done', '{{exported}} companies sent to CRM ({{linked}} linked to existing, {{already}} were already there)', {
                    exported: d.exported, linked: d.linked_existing, already: d.already_exported,
                })
            );
            qc.invalidateQueries({ queryKey: ['research', 'companies'] });
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    // Poll the harvest job; on success refresh companies + credits and toast the outcome.
    const runJobQuery = useQuery<HarvestJob>({
        queryKey: ['research', 'job', runJobId],
        queryFn: async () => (await api.get(`/research/jobs/${runJobId}`)).data,
        enabled: !!runJobId,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 2000 : false),
    });
    const runStatus = runJobQuery.data?.status;
    useEffect(() => {
        if (runStatus === 'succeeded') {
            const r = runJobQuery.data?.result as { matches?: number; newly_billed?: number } | null;
            showSuccess(
                t('research.harvest.done', 'Harvest finished: {{matches}} match ({{billed}} new lead billed)', {
                    matches: r?.matches ?? 0,
                    billed: r?.newly_billed ?? 0,
                })
            );
            qc.invalidateQueries({ queryKey: ['research', 'companies'] });
            qc.invalidateQueries({ queryKey: ['research', 'credits'] });
            setRunJobId(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runStatus]);

    const running = runMut.isPending || JOB_RUNNING(runStatus);
    const canRun =
        !!selectedIcp && selectedIcp.status === 'approved' &&
        (!!geoId || geography.trim().length > 0) &&
        (credits?.available ?? 0) >= 1 && !running;

    const statusOptions = useMemo(
        () => [
            { label: t('research.companies.all', 'All'), value: 'all' },
            { label: t('research.companies.match', 'Match'), value: 'match' },
            { label: t('research.companies.partial', 'Partial'), value: 'partial' },
            { label: t('research.companies.eliminated', 'Eliminated'), value: 'eliminated' },
            { label: t('research.companies.review', 'Review'), value: 'review' },
        ],
        [t]
    );

    return (
        <Stack gap="md">
            {/* Scope: project → ICP; credits as lead COUNTS only */}
            <Paper withBorder radius="md" p="md">
                <Group justify="space-between" align="flex-end" wrap="wrap">
                    <Group align="flex-end" gap="sm">
                        <Select
                            label={t('research.companies.project', 'Project')}
                            placeholder={t('research.companies.pickProject', 'Pick a project')}
                            data={projects.map((p) => ({ value: p.id, label: p.name }))}
                            value={projectId}
                            onChange={(v) => { setProjectId(v); setIcpId(null); setPage(1); }}
                            w={220}
                            searchable
                        />
                        <Select
                            label={t('research.companies.icp', 'ICP')}
                            placeholder={t('research.companies.pickIcp', 'Pick an ICP')}
                            data={icps.map((i) => ({
                                value: i.id,
                                label: `${i.name}${i.status === 'approved' ? ' ✓' : ` (${i.status})`}`,
                            }))}
                            value={icpId}
                            onChange={(v) => { setIcpId(v); setPage(1); }}
                            w={260}
                            disabled={!projectId}
                            searchable
                        />
                    </Group>
                    {credits && (
                        <Group gap="xs">
                            <Tooltip label={t('research.credits.availableHint', 'Leads you can still harvest (balance minus in-flight reservations)')}>
                                <Badge size="lg" variant="light" color={credits.available > 5 ? 'teal' : credits.available > 0 ? 'yellow' : 'red'}>
                                    {t('research.credits.available', 'Available')}: {credits.available}
                                </Badge>
                            </Tooltip>
                            <Badge size="lg" variant="outline" color="gray">
                                {t('research.credits.balance', 'Balance')}: {credits.balance}
                            </Badge>
                            {credits.reserved > 0 && (
                                <Badge size="lg" variant="outline" color="blue">
                                    {t('research.credits.reserved', 'Reserved')}: {credits.reserved}
                                </Badge>
                            )}
                        </Group>
                    )}
                </Group>
            </Paper>

            {/* Harvest launcher — approved ICP only; the worker enforces quota authoritatively */}
            {selectedIcp && (
                <Paper withBorder radius="md" p="md">
                    <Group align="flex-end" gap="sm" wrap="wrap">
                        {approvedGeos.length > 0 && (
                            <Select
                                label={t('research.geographies.cell', 'Approved geography')}
                                data={[
                                    { value: '', label: t('research.geographies.freeText', 'Free text') },
                                    ...approvedGeos.map((g) => ({ value: g.id, label: g.country })),
                                ]}
                                value={geoId ?? ''}
                                onChange={(v) => setGeoId(v ? v : null)}
                                w={200}
                                allowDeselect={false}
                            />
                        )}
                        <TextInput
                            label={t('research.harvest.geography', 'Geography')}
                            placeholder={t('research.harvest.geographyPh', 'e.g. Germany, Netherlands, Bavaria…')}
                            leftSection={<IconWorld size={16} />}
                            value={geography}
                            onChange={(e) => setGeography(e.currentTarget.value)}
                            disabled={!!geoId}
                            w={280}
                        />
                        <Tooltip
                            multiline
                            w={260}
                            label={t('research.harvest.sourceHint', 'Web = search engines. Maps = Google Maps business scrape (CIS geographies use 2GIS). Same quota and billing.')}
                        >
                            <div>
                                <Text size="xs" c="dimmed" mb={4}>{t('research.harvest.source', 'Source')}</Text>
                                <SegmentedControl
                                    value={source}
                                    onChange={(v) => setSource(v as 'web' | 'maps')}
                                    disabled={running}
                                    data={[
                                        { value: 'web', label: t('research.harvest.sourceWeb', 'Web') },
                                        { value: 'maps', label: t('research.harvest.sourceMaps', 'Maps') },
                                    ]}
                                />
                            </div>
                        </Tooltip>
                        <Button
                            leftSection={<IconPlayerPlay size={16} />}
                            onClick={() => runMut.mutate()}
                            disabled={!canRun}
                            loading={running}
                        >
                            {t('research.harvest.run', 'Find leads')}
                        </Button>
                        {running && (
                            <Group gap="xs">
                                <Loader size="xs" />
                                <Text size="sm" c="dimmed">
                                    {t('research.harvest.running', 'Harvest running…')}
                                    {runJobQuery.data?.progress?.stage ? ` (${String(runJobQuery.data.progress.stage)})` : ''}
                                </Text>
                            </Group>
                        )}
                        {selectedIcp.status !== 'approved' && (
                            <Text size="sm" c="dimmed">
                                {t('research.harvest.needApproved', 'Approve this ICP first to harvest leads for it.')}
                            </Text>
                        )}
                        {(credits?.available ?? 0) < 1 && (
                            <Text size="sm" c="red">
                                {t('research.harvest.noCredits', 'No lead quota available — top up to run a harvest.')}
                            </Text>
                        )}
                    </Group>
                    {runStatus === 'failed' && (
                        <Alert mt="sm" color="red" icon={<IconInfoCircle size={16} />}>
                            {t('research.harvest.failed', 'Harvest failed')}: {runJobQuery.data?.error ?? 'unknown'}
                        </Alert>
                    )}
                </Paper>
            )}

            {/* Companies (verdict-aware, per selected ICP) */}
            {icpId && (
                <Paper withBorder radius="md" p="md">
                    <Stack gap="sm">
                        <Group justify="space-between" wrap="wrap">
                            <SegmentedControl size="xs" data={statusOptions} value={status} onChange={(v) => { setStatus(v); setPage(1); }} />
                            <Group gap="sm">
                                <Text size="sm" c="dimmed">
                                    {t('research.companies.total', '{{count}} companies', { count: total })}
                                </Text>
                                <Button
                                    size="xs" variant="light"
                                    rightSection={<IconArrowRight size={14} />}
                                    onClick={() => exportMut.mutate()}
                                    loading={exportMut.isPending}
                                >
                                    {t('research.export.button', 'Send matches to CRM')}
                                </Button>
                            </Group>
                        </Group>

                        {companiesQuery.isLoading ? (
                            <Group justify="center" py="xl"><Loader /></Group>
                        ) : companies.length === 0 ? (
                            <Text c="dimmed" ta="center" py="xl">
                                {t('research.companies.empty', 'No companies yet for this ICP — run a harvest above to find leads.')}
                            </Text>
                        ) : (
                            <Table.ScrollContainer minWidth={720}>
                                <Table striped highlightOnHover verticalSpacing="sm">
                                    <Table.Thead>
                                        <Table.Tr>
                                            <Table.Th>{t('research.companies.company', 'Company')}</Table.Th>
                                            <Table.Th>{t('research.companies.location', 'Location')}</Table.Th>
                                            <Table.Th ta="center">{t('research.companies.score', 'Score')}</Table.Th>
                                            <Table.Th ta="center">{t('research.companies.status', 'Status')}</Table.Th>
                                            <Table.Th>{t('research.companies.evidence', 'Evidence')}</Table.Th>
                                        </Table.Tr>
                                    </Table.Thead>
                                    <Table.Tbody>
                                        {companies.map((c) => (
                                            <Table.Tr key={c.id}>
                                                <Table.Td>
                                                    <Group gap={6} wrap="nowrap">
                                                        <Text fw={600} size="sm">{c.name}</Text>
                                                        {c.crm_company_id && (
                                                            <Tooltip label={t('research.export.inCrmHint', 'This company is in your CRM')}>
                                                                <Badge size="xs" variant="light" color="teal">CRM ✓</Badge>
                                                            </Tooltip>
                                                        )}
                                                    </Group>
                                                    {(c.website || c.domain) && (
                                                        <Text
                                                            size="xs" c="blue" component="a"
                                                            href={/^https?:\/\//.test(c.website || c.domain || '') ? (c.website || c.domain)! : `https://${c.website || c.domain}`}
                                                            target="_blank" rel="noreferrer"
                                                        >
                                                            {c.domain || c.website}
                                                        </Text>
                                                    )}
                                                </Table.Td>
                                                <Table.Td>
                                                    <Text size="sm" c="dimmed">
                                                        {[c.city, c.country].filter(Boolean).join(', ') || '—'}
                                                    </Text>
                                                </Table.Td>
                                                <Table.Td ta="center">
                                                    <Badge variant="light" color={scoreColor(c.score)}>
                                                        {c.score ?? '—'}
                                                    </Badge>
                                                </Table.Td>
                                                <Table.Td ta="center">
                                                    <Badge variant="filled" color={STATUS_COLOR[c.status] ?? 'gray'}>
                                                        {t(`research.companies.${c.status}`, c.status)}
                                                    </Badge>
                                                </Table.Td>
                                                <Table.Td maw={360}>
                                                    <Tooltip
                                                        label={c.evidence || c.elimination_reason || '—'}
                                                        multiline maw={420} withArrow
                                                        disabled={!(c.evidence || c.elimination_reason)}
                                                    >
                                                        <Text size="xs" c="dimmed" lineClamp={2}>
                                                            {c.evidence || c.elimination_reason || '—'}
                                                        </Text>
                                                    </Tooltip>
                                                    {(c.angle_suggestion || (c.hooks?.length ?? 0) > 0) && (
                                                        <Group gap={4} mt={4} wrap="wrap">
                                                            {c.angle_suggestion && (
                                                                <Badge size="xs" variant="light" color="grape">
                                                                    {c.angle_suggestion}
                                                                </Badge>
                                                            )}
                                                            {(c.hooks ?? []).map((h, i) => (
                                                                <Tooltip key={i} label={h} withArrow>
                                                                    <Badge size="xs" variant="outline" color="cyan" maw={160} style={{ textTransform: 'none' }}>
                                                                        {h}
                                                                    </Badge>
                                                                </Tooltip>
                                                            ))}
                                                        </Group>
                                                    )}
                                                </Table.Td>
                                            </Table.Tr>
                                        ))}
                                    </Table.Tbody>
                                </Table>
                            </Table.ScrollContainer>
                        )}

                        {total > PAGE_SIZE && (
                            <Group justify="center">
                                <Pagination total={Math.ceil(total / PAGE_SIZE)} value={page} onChange={setPage} size="sm" />
                            </Group>
                        )}
                    </Stack>
                </Paper>
            )}

            {!icpId && (
                <Text c="dimmed" size="sm" ta="center" py="lg">
                    {t('research.companies.pickHint', 'Pick a project and an ICP to see its harvested companies.')}
                </Text>
            )}
        </Stack>
    );
}
