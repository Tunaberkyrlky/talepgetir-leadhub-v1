/**
 * GeographiesPanel — WP2 sub-ICP geography cells.
 * Pick a project → an approved ICP → add a country: a geo:analyze job drafts the ICP
 * instantiated for that country (local-language terms, localized signals, key channels,
 * certifications, buyer titles, market-structure notes, an E estimate). The customer edits
 * the spec and approves it — the same human-gate as the ICP itself. Approved cells then feed
 * the harvest launcher (geo_id) so discovery uses the localized spec. No billing coupling:
 * a geo spec change affects discovery quality only.
 */
import { useEffect, useMemo, useState } from 'react';
import {
    Alert, Badge, Button, Divider, Drawer, Group, Loader, NumberInput, Paper, Rating, Select,
    Stack, Table, TagsInput, Text, TextInput, Textarea, Tooltip,
} from '@mantine/core';
import { IconInfoCircle, IconRefresh, IconSparkles, IconWorldPin } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showError, showErrorFromApi, showSuccess, showWarning } from '../../lib/notifications';
import type { ResearchIcp } from './IcpCard';

interface ResearchProject {
    id: string;
    name: string;
}

interface GeoChannel { type: string; name: string; url?: string }
interface GeoDirectory { name: string; url?: string }

/** Mirror of the server's geoAnalysisSchema (the editable final, stored in spec JSONB). */
interface GeoSpec {
    local_terms: string[];
    localized_signals: string[];
    localized_negative_signals: string[];
    directories: GeoDirectory[];
    channels: GeoChannel[];
    certifications: string[];
    buyer_titles: string[];
    market_notes: string;
    estimate: number | null;
    confidence: number | null;
    estimate_basis: string;
}

interface GeoCell {
    id: string;
    icp_id: string | null;
    country: string;
    region: string | null;
    status: 'draft' | 'approved' | 'rejected';
    estimate: number | null;
    confidence: number | null;
    rationale: string | null;
    human_score: number | null;
    note: string | null;
    spec: GeoSpec | null;
    generated_by_job_id?: string | null;
    updated_at: string;
}

interface GeoJob {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    progress: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    error: string | null;
}

const STATUS_COLOR: Record<GeoCell['status'], string> = {
    draft: 'gray',
    approved: 'green',
    rejected: 'red',
};

const JOB_RUNNING = (s?: string) => s === 'queued' || s === 'running';

function httpInfo(err: unknown) {
    const resp = (err as { response?: { status?: number; data?: { job_id?: string } } }).response;
    return { status: resp?.status, jobId: resp?.data?.job_id };
}

function externalHref(url: string) {
    return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

export default function GeographiesPanel() {
    const { t } = useTranslation();
    const qc = useQueryClient();

    const [projectId, setProjectId] = useState<string | null>(null);
    const [icpId, setIcpId] = useState<string | null>(null);
    const [country, setCountry] = useState('');
    const [detailId, setDetailId] = useState<string | null>(null);
    // One tracked geo:analyze job at a time (CalibrationDrawer convention) — the buttons are
    // disabled while it runs; a concurrent server-side job is adopted via the 409/202 payload.
    const [job, setJob] = useState<{ id: string; geoId: string | null } | null>(null);

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

    const cellsQuery = useQuery<{ data: GeoCell[] }>({
        queryKey: ['research', 'geographies', icpId],
        queryFn: async () => (await api.get(`/research/geographies?icp_id=${icpId}`)).data,
        enabled: !!icpId,
    });
    const cells = cellsQuery.data?.data ?? [];
    const detailCell = cells.find((c) => c.id === detailId) ?? null;

    const invalidateCells = () => qc.invalidateQueries({ queryKey: ['research', 'geographies', icpId] });

    // Create the cell if missing + enqueue geo:analyze (the server adopts an in-flight job).
    // An already-analyzed country comes back reused with job: null — the server refuses to
    // silently overwrite it; re-analysis is the explicit (confirmed) path in the drawer.
    const addMut = useMutation({
        mutationFn: async () => {
            const resp = (await api.post('/research/geographies', {
                icp_id: icpId,
                country: country.trim(),
            })).data as { geography: GeoCell; job: GeoJob | null; reused?: boolean };
            if (resp.job) setJob({ id: resp.job.id, geoId: resp.geography.id });
            return resp;
        },
        onSuccess: (resp) => {
            setCountry('');
            invalidateCells();
            if (!resp.job) {
                showWarning(t('research.geographies.reusedExisting', 'This geography already exists with an analysis — open it and use Re-analyze if you want a fresh draft.'));
            }
        },
        onError: (err: unknown) => {
            const { status, jobId } = httpInfo(err);
            if (status === 409 && jobId) {
                setJob({ id: jobId, geoId: null });
                showWarning(t('research.geographies.alreadyRunning', 'An analysis is already running for this geography — watching it.'));
                return;
            }
            if (status === 402) {
                showError(t('research.geographies.noCredits', 'You do not have research credits — top up before analyzing geographies.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    // Re-analyze an existing cell (overwrites the draft on completion, demotes to draft).
    const reanalyzeMut = useMutation({
        mutationFn: async (geoId: string) => {
            const started = (await api.post(`/research/geographies/${geoId}/analyze`)).data as GeoJob;
            setJob({ id: started.id, geoId });
            return started;
        },
        onError: (err: unknown) => {
            const { status, jobId } = httpInfo(err);
            if (status === 409 && jobId) {
                setJob({ id: jobId, geoId: null });
                showWarning(t('research.geographies.alreadyRunning', 'An analysis is already running for this geography — watching it.'));
                return;
            }
            if (status === 402) {
                showError(t('research.geographies.noCredits', 'You do not have research credits — top up before analyzing geographies.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    // Poll the analysis job; on success refresh the cells (the drawer re-seeds via its key).
    const jobQuery = useQuery<GeoJob>({
        queryKey: ['research', 'job', job?.id],
        queryFn: async () => (await api.get(`/research/jobs/${job?.id}`)).data,
        enabled: !!job,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 2500 : false),
    });
    const jobStatus = jobQuery.data?.status;
    useEffect(() => {
        if (jobStatus === 'succeeded') {
            showSuccess(t('research.geographies.analyzeDone', 'Analysis finished — review and approve the draft.'));
            invalidateCells();
            setJob(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jobStatus]);

    const analyzing = addMut.isPending || reanalyzeMut.isPending || JOB_RUNNING(jobStatus);
    const canAdd = !!icpId && country.trim().length >= 2 && !analyzing;

    return (
        <Stack gap="md">
            {/* Scope: project → ICP (same selection pattern as CompaniesPanel) */}
            <Paper withBorder radius="md" p="md">
                <Group align="flex-end" gap="sm" wrap="wrap">
                    <Select
                        label={t('research.geographies.project', 'Project')}
                        placeholder={t('research.geographies.pickProject', 'Pick a project')}
                        data={projects.map((p) => ({ value: p.id, label: p.name }))}
                        value={projectId}
                        onChange={(v) => { setProjectId(v); setIcpId(null); setDetailId(null); }}
                        w={220}
                        searchable
                    />
                    <Select
                        label={t('research.geographies.icp', 'ICP')}
                        placeholder={t('research.geographies.pickIcp', 'Pick an ICP')}
                        data={icps.map((i) => ({
                            value: i.id,
                            label: `${i.name}${i.status === 'approved' ? ' ✓' : ` (${i.status})`}`,
                        }))}
                        value={icpId}
                        onChange={(v) => { setIcpId(v); setDetailId(null); }}
                        w={260}
                        disabled={!projectId}
                        searchable
                    />
                </Group>
            </Paper>

            {/* Add-country form — creates the cell (or reuses it) and starts geo:analyze */}
            {icpId && (
                <Paper withBorder radius="md" p="md">
                    <Group align="flex-end" gap="sm" wrap="wrap">
                        <TextInput
                            label={t('research.geographies.country', 'Country')}
                            placeholder={t('research.geographies.countryPh', 'e.g. Germany')}
                            leftSection={<IconWorldPin size={16} />}
                            value={country}
                            onChange={(e) => setCountry(e.currentTarget.value)}
                            w={240}
                        />
                        <Button
                            leftSection={<IconSparkles size={16} />}
                            onClick={() => addMut.mutate()}
                            disabled={!canAdd}
                            loading={addMut.isPending}
                        >
                            {t('research.geographies.analyze', 'Analyze')}
                        </Button>
                        {analyzing && (
                            <Group gap="xs">
                                <Loader size="xs" />
                                <Text size="sm" c="dimmed">
                                    {t('research.geographies.analyzing', 'Analysis running…')}
                                    {jobQuery.data?.progress?.stage ? ` (${String(jobQuery.data.progress.stage)})` : ''}
                                </Text>
                            </Group>
                        )}
                    </Group>
                    {(jobStatus === 'failed' || jobStatus === 'canceled') && (
                        <Alert mt="sm" color="red" icon={<IconInfoCircle size={16} />}>
                            {t('research.geographies.analyzeFailed', 'Analysis failed')}: {jobQuery.data?.error ?? 'unknown'}
                        </Alert>
                    )}
                </Paper>
            )}

            {/* Cells table — one sub-ICP cell per country; row click opens the detail drawer */}
            {icpId && (
                <Paper withBorder radius="md" p="md">
                    <Stack gap="sm">
                        <Text fw={600} size="sm">{t('research.geographies.heading', 'Geography cells')}</Text>
                        {cellsQuery.isLoading ? (
                            <Group justify="center" py="md"><Loader size="sm" /></Group>
                        ) : cells.length === 0 ? (
                            <Text c="dimmed" size="sm" ta="center" py="md">
                                {t('research.geographies.empty', 'No geography cells yet — add a country above.')}
                            </Text>
                        ) : (
                            <Table.ScrollContainer minWidth={640}>
                                <Table striped highlightOnHover verticalSpacing="sm">
                                    <Table.Thead>
                                        <Table.Tr>
                                            <Table.Th>{t('research.geographies.country', 'Country')}</Table.Th>
                                            <Table.Th ta="center">{t('research.geographies.status', 'Status')}</Table.Th>
                                            <Table.Th ta="center">{t('research.geographies.estimate', 'Estimate')}</Table.Th>
                                            <Table.Th ta="center">{t('research.geographies.terms', 'Local terms')}</Table.Th>
                                            <Table.Th>{t('research.geographies.updated', 'Updated')}</Table.Th>
                                        </Table.Tr>
                                    </Table.Thead>
                                    <Table.Tbody>
                                        {cells.map((c) => (
                                            <Table.Tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(c.id)}>
                                                <Table.Td>
                                                    <Text fw={600} size="sm">{c.country}</Text>
                                                    {c.region && <Text size="xs" c="dimmed">{c.region}</Text>}
                                                </Table.Td>
                                                <Table.Td ta="center">
                                                    <Badge variant="filled" color={STATUS_COLOR[c.status] ?? 'gray'}>
                                                        {t(`research.geographies.statusValue.${c.status}`, c.status)}
                                                    </Badge>
                                                </Table.Td>
                                                <Table.Td ta="center">
                                                    <Text size="sm">
                                                        {c.estimate ?? '—'}
                                                        {c.confidence != null && (
                                                            <Text span size="xs" c="dimmed"> ({Math.round(c.confidence * 100)}%)</Text>
                                                        )}
                                                    </Text>
                                                </Table.Td>
                                                <Table.Td ta="center">
                                                    <Text size="sm">{c.spec?.local_terms?.length ?? '—'}</Text>
                                                </Table.Td>
                                                <Table.Td>
                                                    <Text size="sm" c="dimmed">{new Date(c.updated_at).toLocaleDateString()}</Text>
                                                </Table.Td>
                                            </Table.Tr>
                                        ))}
                                    </Table.Tbody>
                                </Table>
                            </Table.ScrollContainer>
                        )}
                    </Stack>
                </Paper>
            )}

            {!icpId && (
                <Text c="dimmed" size="sm" ta="center" py="lg">
                    {t('research.geographies.pickHint', 'Pick a project and an ICP to manage its geography cells.')}
                </Text>
            )}

            {/* Keyed on cell id + generating job so a finished re-analysis re-seeds the form. */}
            <GeoDetailDrawer
                key={detailCell ? `${detailCell.id}:${detailCell.generated_by_job_id ?? ''}` : 'none'}
                cell={detailCell}
                opened={!!detailCell}
                onClose={() => setDetailId(null)}
                analyzing={analyzing}
                onReanalyze={(id) => reanalyzeMut.mutate(id)}
                onChanged={invalidateCells}
            />
        </Stack>
    );
}

/** Detail drawer — editable spec + approve section for one geography cell. */
function GeoDetailDrawer({
    cell, opened, onClose, analyzing, onReanalyze, onChanged,
}: {
    cell: GeoCell | null;
    opened: boolean;
    onClose: () => void;
    analyzing: boolean;
    onReanalyze: (geoId: string) => void;
    onChanged: () => void;
}) {
    const { t } = useTranslation();
    const spec = cell?.spec ?? null;

    // Seeded from the current spec; the parent remounts this drawer (key) when a re-analysis lands.
    const [localTerms, setLocalTerms] = useState<string[]>(spec?.local_terms ?? []);
    const [signals, setSignals] = useState<string[]>(spec?.localized_signals ?? []);
    const [negatives, setNegatives] = useState<string[]>(spec?.localized_negative_signals ?? []);
    const [buyerTitles, setBuyerTitles] = useState<string[]>(spec?.buyer_titles ?? []);
    const [certifications, setCertifications] = useState<string[]>(spec?.certifications ?? []);
    const [marketNotes, setMarketNotes] = useState(spec?.market_notes ?? '');
    const [estimate, setEstimate] = useState<number | null>(spec?.estimate ?? null);
    const [score, setScore] = useState<number>(cell?.human_score ?? 0);

    // A spec write validates the FULL schema server-side and demotes the cell to draft.
    const saveMut = useMutation({
        mutationFn: async () => {
            const body: { spec: GeoSpec } = {
                spec: {
                    local_terms: localTerms,
                    localized_signals: signals,
                    localized_negative_signals: negatives,
                    directories: spec?.directories ?? [],
                    channels: spec?.channels ?? [],
                    certifications,
                    buyer_titles: buyerTitles,
                    market_notes: marketNotes,
                    estimate,
                    confidence: spec?.confidence ?? null,
                    estimate_basis: spec?.estimate_basis ?? '',
                },
            };
            return (await api.patch(`/research/geographies/${cell!.id}`, body)).data;
        },
        onSuccess: () => {
            showSuccess(t('research.geographies.saved', 'Geography saved — the cell is back in draft.'));
            onChanged();
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const approveMut = useMutation({
        mutationFn: async () =>
            (await api.post(`/research/geographies/${cell!.id}/approve`, { human_score: score })).data,
        onSuccess: () => {
            showSuccess(t('research.geographies.approvedToast', 'Geography approved.'));
            onChanged();
        },
        onError: (err: unknown) => {
            if (httpInfo(err).status === 409) {
                showWarning(t('research.geographies.needSpec', 'Run the analysis first — the cell needs a spec before approval.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    if (!cell) return null;

    const reanalyze = () => {
        // Overwrites the current draft when it completes — confirm only if there is one to lose.
        if (spec && !window.confirm(t('research.geographies.reanalyzeConfirm', 'Re-analysis overwrites the current draft when it finishes. Continue?'))) return;
        onReanalyze(cell.id);
    };

    return (
        <Drawer
            opened={opened} onClose={onClose} position="right" size="xl"
            title={
                <Group gap="xs">
                    <Text fw={600}>{cell.country}</Text>
                    <Badge variant="light" color={STATUS_COLOR[cell.status] ?? 'gray'}>
                        {t(`research.geographies.statusValue.${cell.status}`, cell.status)}
                    </Badge>
                </Group>
            }
        >
            <Stack gap="md">
                <Group justify="flex-end">
                    <Button
                        variant="light" leftSection={<IconRefresh size={16} />}
                        onClick={reanalyze} disabled={analyzing} loading={analyzing}
                    >
                        {t('research.geographies.reanalyze', 'Re-analyze')}
                    </Button>
                </Group>

                {!spec ? (
                    <Alert color="gray" icon={<IconInfoCircle size={16} />}>
                        {t('research.geographies.noSpec', 'No analyzed spec yet — run the analysis to draft this cell.')}
                    </Alert>
                ) : (
                    <Stack gap="sm">
                        <TagsInput
                            label={t('research.geographies.localTerms', 'Local search terms')}
                            value={localTerms} onChange={setLocalTerms}
                        />
                        <TagsInput
                            label={t('research.geographies.localizedSignals', 'Localized signals')}
                            value={signals} onChange={setSignals}
                        />
                        <TagsInput
                            label={t('research.geographies.localizedNegativeSignals', 'Localized negative signals')}
                            value={negatives} onChange={setNegatives}
                        />
                        <TagsInput
                            label={t('research.geographies.buyerTitles', 'Buyer titles')}
                            value={buyerTitles} onChange={setBuyerTitles}
                        />
                        <TagsInput
                            label={t('research.geographies.certifications', 'Certifications')}
                            value={certifications} onChange={setCertifications}
                        />
                        <Textarea
                            label={t('research.geographies.marketNotes', 'Market structure notes')}
                            autosize minRows={3}
                            value={marketNotes}
                            onChange={(e) => setMarketNotes(e.currentTarget.value)}
                        />

                        {spec.channels.length > 0 && (
                            <div>
                                <Text size="sm" fw={600}>{t('research.geographies.channels', 'Key channels')}</Text>
                                <Stack gap={4} mt={4}>
                                    {spec.channels.map((ch, i) => (
                                        <Group key={i} gap="xs" wrap="nowrap">
                                            <Badge size="xs" variant="light" color="violet">
                                                {t(`research.geographies.channelType.${ch.type}`, ch.type)}
                                            </Badge>
                                            {ch.url ? (
                                                <Text size="xs" c="blue" component="a" href={externalHref(ch.url)} target="_blank" rel="noreferrer">
                                                    {ch.name}
                                                </Text>
                                            ) : (
                                                <Text size="xs">{ch.name}</Text>
                                            )}
                                        </Group>
                                    ))}
                                </Stack>
                            </div>
                        )}

                        {spec.directories.length > 0 && (
                            <div>
                                <Text size="sm" fw={600}>{t('research.geographies.directories', 'Directories')}</Text>
                                <Stack gap={4} mt={4}>
                                    {spec.directories.map((d, i) => (
                                        d.url ? (
                                            <Text key={i} size="xs" c="blue" component="a" href={externalHref(d.url)} target="_blank" rel="noreferrer">
                                                {d.name}
                                            </Text>
                                        ) : (
                                            <Text key={i} size="xs">{d.name}</Text>
                                        )
                                    ))}
                                </Stack>
                            </div>
                        )}

                        <Group align="flex-end" gap="sm">
                            <NumberInput
                                label={t('research.geographies.estimateLabel', 'Estimated target firms')}
                                min={0} max={1000000} w={200}
                                value={estimate ?? ''}
                                onChange={(v) => setEstimate(typeof v === 'number' ? v : null)}
                            />
                            <Text size="sm" c="dimmed" pb={8}>
                                {t('research.geographies.confidence', 'Confidence')}: {spec.confidence != null ? `${Math.round(spec.confidence * 100)}%` : '—'}
                            </Text>
                        </Group>
                        {spec.estimate_basis && (
                            <Text size="xs" c="dimmed">
                                {t('research.geographies.estimateBasis', 'Estimate basis')}: {spec.estimate_basis}
                            </Text>
                        )}

                        <Group justify="space-between" align="center">
                            <Text size="xs" c="dimmed">
                                {t('research.geographies.saveHint', 'Saving returns the cell to draft; approve it again afterwards.')}
                            </Text>
                            <Button variant="default" onClick={() => saveMut.mutate()} loading={saveMut.isPending}>
                                {t('research.geographies.save', 'Save')}
                            </Button>
                        </Group>

                        <Divider />

                        {/* Approve — human score /10, mirrors the ICP gate */}
                        <Group justify="space-between" align="center">
                            <div>
                                <Text size="sm" fw={600}>{t('research.geographies.yourScore', 'Your score')}: {score}/10</Text>
                                <Rating count={10} value={score} onChange={setScore} />
                            </div>
                            <Tooltip label={t('research.geographies.approveHint', 'Approved cells become selectable in the harvest launcher.')}>
                                <Button
                                    color="teal"
                                    onClick={() => approveMut.mutate()}
                                    loading={approveMut.isPending}
                                    disabled={cell.status === 'approved'}
                                >
                                    {t('research.geographies.approve', 'Approve')}
                                </Button>
                            </Tooltip>
                        </Group>
                    </Stack>
                )}
            </Stack>
        </Drawer>
    );
}
