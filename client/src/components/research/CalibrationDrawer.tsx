/**
 * CalibrationDrawer — WP1 calibration loop (C1–C2) for one ICP.
 * Sample a small capped harvest for a geography → rate each sampled company good/bad →
 * ask the strategy model for an ICP revision → review the diff and apply it (the 062
 * trigger bumps ruleset_version + reverts approved→draft) → re-approve on the card →
 * finally mark the logic "calibrated". Credits surface as lead counts — never dollars.
 */
import { useEffect, useState } from 'react';
import {
    ActionIcon, Alert, Badge, Button, Divider, Drawer, Group, List, Loader, Paper,
    SegmentedControl, Stack, Table, Text, TextInput, Tooltip,
} from '@mantine/core';
import {
    IconChecks, IconInfoCircle, IconPlayerPlay, IconSparkles, IconThumbDown, IconThumbUp, IconWorld,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showError, showErrorFromApi, showSuccess, showWarning } from '../../lib/notifications';
import type { ResearchIcp } from './IcpCard';

const CALIBRATION_COLOR: Record<ResearchIcp['calibration_state'], string> = {
    none: 'gray', sampling: 'blue', feedback: 'yellow', revised: 'grape', calibrated: 'green',
};

/** The strategy model's proposed revision (icpRevisionSchema) — FULL replacement arrays. */
type IcpRevision = {
    signals: string[]; negative_signals: string[]; neutral_signals: string[];
    elimination_rules: string[]; changes_summary: string[]; rationale: string;
};

interface CalibrationIcp extends ResearchIcp {
    revision_draft: IcpRevision | null;
    revision_job_id?: string | null;
}

interface CompanyRow {
    id: string; name: string; domain: string | null; website: string | null;
    status: 'match' | 'partial' | 'eliminated' | 'review';
    score: number | null; evidence: string | null; elimination_reason: string | null;
}

interface FeedbackRow { company_id: string; rating: 'good' | 'bad'; note: string | null }

interface CalibrationJob {
    id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    progress: Record<string, unknown> | null; result: Record<string, unknown> | null; error: string | null;
}

type RatingDraft = { rating: 'good' | 'bad' | null; note: string };
type TrackedJob = { id: string; kind: 'sample' | 'revise' };

const VERDICT_COLOR: Record<CompanyRow['status'], string> = {
    match: 'green', partial: 'yellow', eliminated: 'red', review: 'gray',
};

const JOB_RUNNING = (s?: string) => s === 'queued' || s === 'running';

const RULESET_KEYS = ['signals', 'negative_signals', 'neutral_signals', 'elimination_rules'] as const;
const RULESET_LABEL: Record<(typeof RULESET_KEYS)[number], { key: string; fallback: string }> = {
    signals: { key: 'signals', fallback: 'Signals' },
    negative_signals: { key: 'negativeSignals', fallback: 'Negative signals' },
    neutral_signals: { key: 'neutralSignals', fallback: 'Neutral signals' },
    elimination_rules: { key: 'eliminationRules', fallback: 'Elimination rules' },
};

function diffArrays(current: string[], proposed: string[]) {
    const cur = new Set(current);
    const next = new Set(proposed);
    return { removed: current.filter((s) => !next.has(s)), added: proposed.filter((s) => !cur.has(s)) };
}

function httpInfo(err: unknown) {
    const resp = (err as { response?: { status?: number; data?: { job_id?: string } } }).response;
    return { status: resp?.status, jobId: resp?.data?.job_id };
}

function StepHeader({ title, hint }: { title: string; hint: string }) {
    return <div><Text fw={600} size="sm">{title}</Text><Text size="xs" c="dimmed">{hint}</Text></div>;
}

export default function CalibrationDrawer({
    icp, opened, onClose,
}: {
    icp: ResearchIcp | null;
    opened: boolean;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const icpId = icp?.id;

    const [geography, setGeography] = useState('');
    const [source, setSource] = useState<'web' | 'maps'>('web');
    const [ratings, setRatings] = useState<Record<string, RatingDraft>>({});
    // The ruleset the local ratings were MADE against (codex verify #1): captured when rating
    // starts, sent with the save, and reset whenever the drafts are cleared — so a 409'd batch
    // can never be resubmitted against a newer ruleset it doesn't describe.
    const [ratingsVersion, setRatingsVersion] = useState<number | null>(null);
    const [job, setJob] = useState<TrackedJob | null>(null);

    const invalidateIcp = () => {
        qc.invalidateQueries({ queryKey: ['research', 'icp', icpId] });
        qc.invalidateQueries({ queryKey: ['research', 'icps', icp?.project_id] });
    };
    const invalidateFeedback = () => qc.invalidateQueries({ queryKey: ['research', 'calibration', 'feedback', icpId] });

    // Fresh ICP (calibration_state + revision_draft live here; the list row can be stale).
    const icpQuery = useQuery<CalibrationIcp>({
        queryKey: ['research', 'icp', icpId],
        queryFn: async () => (await api.get(`/research/icps/${icpId}`)).data,
        enabled: opened && !!icpId,
    });

    // Sampled companies (verdict-aware view, same endpoint as CompaniesPanel).
    const companiesQuery = useQuery<{ data: CompanyRow[] }>({
        queryKey: ['research', 'companies', icpId, 'calibration'],
        queryFn: async () => (await api.get(`/research/harvest/companies?icp_id=${icpId}&limit=50`)).data,
        enabled: opened && !!icpId,
    });
    const companies = companiesQuery.data?.data ?? [];

    // Existing feedback at the CURRENT ruleset — prefills the rating column.
    const feedbackQuery = useQuery<{ data: FeedbackRow[]; ruleset_version: number }>({
        queryKey: ['research', 'calibration', 'feedback', icpId],
        queryFn: async () => (await api.get(`/research/icps/${icpId}/feedback`)).data,
        enabled: opened && !!icpId,
    });
    const savedCount = feedbackQuery.data?.data.length ?? 0;

    // Prefill saved ratings without clobbering unsaved local edits.
    useEffect(() => {
        const rows = feedbackQuery.data?.data;
        if (!rows?.length) return;
        setRatingsVersion((v) => v ?? feedbackQuery.data?.ruleset_version ?? null);
        setRatings((prev) => {
            const next = { ...prev };
            for (const r of rows) {
                if (!next[r.company_id]) next[r.company_id] = { rating: r.rating, note: r.note ?? '' };
            }
            return next;
        });
    }, [feedbackQuery.data]);

    // Poll whichever job (sample or revise) is in flight; mirror CompaniesPanel's approach.
    const jobQuery = useQuery<CalibrationJob>({
        queryKey: ['research', 'job', job?.id],
        queryFn: async () => (await api.get(`/research/jobs/${job?.id}`)).data,
        enabled: !!job,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 2500 : false),
    });
    const jobStatus = jobQuery.data?.status;
    useEffect(() => {
        if (jobStatus !== 'succeeded') return;
        if (job?.kind === 'sample') {
            showSuccess(t('research.calibration.sampleDone', 'Sample finished — rate the companies below.'));
            qc.invalidateQueries({ queryKey: ['research', 'companies'] });
            qc.invalidateQueries({ queryKey: ['research', 'credits'] });
        } else if (job?.kind === 'revise') {
            showSuccess(t('research.calibration.reviseDone', 'Revision proposal is ready — review the changes below.'));
        }
        invalidateIcp();
        invalidateFeedback();
        setJob(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jobStatus]);

    const sampleMut = useMutation({
        mutationFn: async () => {
            const started = (await api.post(`/research/icps/${icpId}/calibrate`, {
                geography: geography.trim(),
                source,
            })).data as CalibrationJob;
            setJob({ id: started.id, kind: 'sample' });
            return started;
        },
        onError: (err: unknown) => {
            const { status, jobId } = httpInfo(err);
            if (status === 402) {
                showError(t('research.calibration.noCredits', 'No lead quota available for the sample — top up first.'));
                return;
            }
            if (status === 409) {
                // Already in flight → adopt the existing job (CompaniesPanel convention) and say so.
                if (jobId) {
                    setJob({ id: jobId, kind: 'sample' });
                    showWarning(t('research.calibration.alreadyRunning', 'A run is already in progress for this ICP — watching it.'));
                    return;
                }
                showError(t('research.calibration.notApproved', 'The ICP must be approved before sampling.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    const feedbackMut = useMutation({
        mutationFn: async () => {
            const items = Object.entries(ratings)
                .filter(([, v]) => v.rating !== null)
                .map(([company_id, v]) => ({
                    company_id,
                    rating: v.rating as 'good' | 'bad',
                    ...(v.note.trim() ? { note: v.note.trim().slice(0, 2000) } : {}),
                }));
            // Pinned to the ruleset the ratings were MADE against — not whatever is current at
            // save time. The server 409s if the ICP moved since.
            await api.post(`/research/icps/${icpId}/feedback`, {
                items,
                ruleset_version: ratingsVersion ?? (icpQuery.data ?? icp)?.ruleset_version,
            });
            return items.length;
        },
        onSuccess: (count) => {
            showSuccess(t('research.calibration.feedbackSaved', '{{count}} ratings saved', { count }));
            invalidateFeedback();
            invalidateIcp();
        },
        onError: (err: unknown) => {
            if (httpInfo(err).status === 409) {
                showWarning(t('research.calibration.feedbackStale', 'The ICP changed since you rated these companies — reloaded, review and rate again.'));
                // The drafts describe firms sampled under OLD rules — drop them so a second
                // Save can't resubmit them against the new ruleset (codex verify #1).
                setRatings({});
                setRatingsVersion(null);
                invalidateIcp();
                invalidateFeedback();
                return;
            }
            showErrorFromApi(err);
        },
    });

    const reviseMut = useMutation({
        mutationFn: async () => {
            const started = (await api.post(`/research/icps/${icpId}/revise`)).data as CalibrationJob;
            setJob({ id: started.id, kind: 'revise' });
            return started;
        },
        onError: (err: unknown) => {
            const { status, jobId } = httpInfo(err);
            if (status === 409) {
                if (jobId) setJob({ id: jobId, kind: 'revise' });
                showWarning(t('research.calibration.reviseConflict', 'A revision is already being generated for this ICP.'));
                return;
            }
            if (status === 400) {
                showError(t('research.calibration.needFeedback', 'Save at least one rating before requesting a revision.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    // Double CAS on what the customer is LOOKING at: the ruleset (a concurrent edit bumps it)
    // AND the proposal identity (a concurrent re-revise swaps the draft without a bump) — either
    // moving means 409, never a blind apply of an unreviewed diff.
    const applyMut = useMutation({
        mutationFn: async (args: { rulesetVersion: number; revisionJobId: string }) =>
            (await api.post(`/research/icps/${icpId}/apply-revision`, {
                ruleset_version: args.rulesetVersion,
                revision_job_id: args.revisionJobId,
            })).data,
        onSuccess: () => {
            showSuccess(t('research.calibration.applied', 'Revision applied — the ICP is back in draft, review and approve it again.'));
            setRatings({});
            setRatingsVersion(null);
            invalidateIcp();
            invalidateFeedback();
        },
        onError: (err: unknown) => {
            if (httpInfo(err).status === 409) {
                showWarning(t('research.calibration.applyStale', 'The ICP changed in the meantime — reloaded the latest version, review again.'));
                invalidateIcp();
                return;
            }
            showErrorFromApi(err);
        },
    });

    const markMut = useMutation({
        mutationFn: async () => (await api.post(`/research/icps/${icpId}/mark-calibrated`)).data,
        onSuccess: () => {
            showSuccess(t('research.calibration.marked', 'ICP marked as calibrated.'));
            invalidateIcp();
        },
        onError: (err: unknown) => {
            if (httpInfo(err).status === 409) {
                showError(t('research.calibration.needApprovedFinish', 'The ICP must be approved before you can mark it calibrated.'));
                return;
            }
            if (httpInfo(err).status === 400) {
                showError(t('research.calibration.needFeedbackFinish', 'Rate at least one sampled company at the current ruleset before finishing.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    if (!icp) return null;
    const live: CalibrationIcp = icpQuery.data ?? { ...icp, revision_draft: null };
    const state = live.calibration_state ?? 'none';
    const revision = live.revision_draft;
    const sampleRunning = sampleMut.isPending || (job?.kind === 'sample' && JOB_RUNNING(jobStatus));
    const reviseRunning = reviseMut.isPending || (job?.kind === 'revise' && JOB_RUNNING(jobStatus));
    const anyRunning = sampleRunning || reviseRunning;
    const canSample = live.status === 'approved' && geography.trim().length > 0 && !anyRunning;
    const ratedCount = Object.values(ratings).filter((r) => r.rating !== null).length;

    const captureRatingsVersion = () =>
        setRatingsVersion((v) => v ?? (icpQuery.data ?? icp)?.ruleset_version ?? null);
    const setRating = (id: string, rating: 'good' | 'bad') => {
        captureRatingsVersion();
        setRatings((prev) => {
            const cur = prev[id] ?? { rating: null, note: '' };
            return { ...prev, [id]: { ...cur, rating: cur.rating === rating ? null : rating } };
        });
    };
    const setNote = (id: string, note: string) => {
        captureRatingsVersion();
        setRatings((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { rating: null, note: '' }), note } }));
    };

    return (
        <Drawer
            opened={opened} onClose={onClose} position="right" size="xl"
            title={
                <Group gap="xs">
                    <Text fw={600}>{live.name}</Text>
                    <Badge variant="light" color={CALIBRATION_COLOR[state]}>{t(`research.calibration.state.${state}`, state)}</Badge>
                </Group>
            }
        >
            <Stack gap="lg">
                {/* Step 1 — small capped sample harvest (caps are server-side, never customer input) */}
                <Paper withBorder radius="md" p="md">
                    <Stack gap="sm">
                        <StepHeader title={t('research.calibration.step1', '1. Sample')} hint={t('research.calibration.step1Hint', 'Run a small capped harvest for one geography to test the ICP logic.')} />
                        <Group align="flex-end" gap="sm" wrap="wrap">
                            <TextInput
                                label={t('research.calibration.geography', 'Geography')}
                                placeholder={t('research.calibration.geographyPh', 'e.g. Germany, Netherlands, Bavaria…')}
                                leftSection={<IconWorld size={16} />}
                                value={geography} onChange={(e) => setGeography(e.currentTarget.value)} w={240}
                            />
                            <div>
                                <Text size="xs" c="dimmed" mb={4}>{t('research.calibration.source', 'Source')}</Text>
                                <SegmentedControl
                                    value={source} onChange={(v) => setSource(v as 'web' | 'maps')} disabled={anyRunning}
                                    data={[
                                        { value: 'web', label: t('research.calibration.sourceWeb', 'Web') },
                                        { value: 'maps', label: t('research.calibration.sourceMaps', 'Maps') },
                                    ]}
                                />
                            </div>
                            <Button leftSection={<IconPlayerPlay size={16} />} onClick={() => sampleMut.mutate()} disabled={!canSample} loading={sampleRunning}>
                                {t('research.calibration.runSample', 'Run sample')}
                            </Button>
                        </Group>
                        {sampleRunning && (
                            <Group gap="xs">
                                <Loader size="xs" />
                                <Text size="sm" c="dimmed">
                                    {t('research.calibration.sampling', 'Sample running…')}
                                    {jobQuery.data?.progress?.stage ? ` (${String(jobQuery.data.progress.stage)})` : ''}
                                </Text>
                            </Group>
                        )}
                        {live.status !== 'approved' && (
                            <Text size="sm" c="dimmed">{t('research.calibration.notApproved', 'The ICP must be approved before sampling.')}</Text>
                        )}
                        {job?.kind === 'sample' && jobStatus === 'failed' && (
                            <Alert color="red" icon={<IconInfoCircle size={16} />}>{t('research.calibration.sampleFailed', 'Sample failed')}: {jobQuery.data?.error ?? 'unknown'}</Alert>
                        )}
                    </Stack>
                </Paper>

                {/* Step 2 — rate the sampled companies good/bad at the current ruleset */}
                <Paper withBorder radius="md" p="md">
                    <Stack gap="sm">
                        <StepHeader title={t('research.calibration.step2', '2. Rate')} hint={t('research.calibration.step2Hint', 'Mark each sampled company as good or bad; add a short note if helpful.')} />
                        {companiesQuery.isLoading ? (
                            <Group justify="center" py="md"><Loader size="sm" /></Group>
                        ) : companies.length === 0 ? (
                            <Text c="dimmed" size="sm" ta="center" py="md">
                                {t('research.calibration.noCompanies', 'No sampled companies yet — run a sample above first.')}
                            </Text>
                        ) : (
                            <Table.ScrollContainer minWidth={760}>
                                <Table striped highlightOnHover verticalSpacing="xs">
                                    <Table.Thead>
                                        <Table.Tr>
                                            <Table.Th>{t('research.calibration.company', 'Company')}</Table.Th>
                                            <Table.Th ta="center">{t('research.calibration.verdict', 'Verdict')}</Table.Th>
                                            <Table.Th ta="center">{t('research.calibration.score', 'Score')}</Table.Th>
                                            <Table.Th>{t('research.calibration.evidence', 'Evidence')}</Table.Th>
                                            <Table.Th ta="center">{t('research.calibration.rating', 'Your rating')}</Table.Th>
                                            <Table.Th>{t('research.calibration.note', 'Note')}</Table.Th>
                                        </Table.Tr>
                                    </Table.Thead>
                                    <Table.Tbody>
                                        {companies.map((c) => {
                                            const r = ratings[c.id];
                                            return (
                                                <Table.Tr key={c.id}>
                                                    <Table.Td>
                                                        <Text fw={600} size="sm">{c.name}</Text>
                                                        {(c.website || c.domain) && (
                                                            <Text
                                                                size="xs" c="blue" component="a" target="_blank" rel="noreferrer"
                                                                href={/^https?:\/\//.test(c.website || c.domain || '') ? (c.website || c.domain)! : `https://${c.website || c.domain}`}
                                                            >
                                                                {c.domain || c.website}
                                                            </Text>
                                                        )}
                                                    </Table.Td>
                                                    <Table.Td ta="center">
                                                        <Badge variant="filled" color={VERDICT_COLOR[c.status] ?? 'gray'}>{t(`research.companies.${c.status}`, c.status)}</Badge>
                                                    </Table.Td>
                                                    <Table.Td ta="center"><Text size="sm">{c.score ?? '—'}</Text></Table.Td>
                                                    <Table.Td maw={220}>
                                                        <Tooltip label={c.evidence || c.elimination_reason || '—'} multiline maw={420} withArrow disabled={!(c.evidence || c.elimination_reason)}>
                                                            <Text size="xs" c="dimmed" lineClamp={2}>{c.evidence || c.elimination_reason || '—'}</Text>
                                                        </Tooltip>
                                                    </Table.Td>
                                                    <Table.Td ta="center">
                                                        <Group gap={4} justify="center" wrap="nowrap">
                                                            <ActionIcon variant={r?.rating === 'good' ? 'filled' : 'subtle'} color="teal" onClick={() => setRating(c.id, 'good')} aria-label={t('research.calibration.good', 'Good')}>
                                                                <IconThumbUp size={16} />
                                                            </ActionIcon>
                                                            <ActionIcon variant={r?.rating === 'bad' ? 'filled' : 'subtle'} color="red" onClick={() => setRating(c.id, 'bad')} aria-label={t('research.calibration.bad', 'Bad')}>
                                                                <IconThumbDown size={16} />
                                                            </ActionIcon>
                                                        </Group>
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <TextInput
                                                            size="xs" w={160} placeholder={t('research.calibration.notePh', 'Note (optional)')}
                                                            value={r?.note ?? ''} onChange={(e) => setNote(c.id, e.currentTarget.value)}
                                                        />
                                                    </Table.Td>
                                                </Table.Tr>
                                            );
                                        })}
                                    </Table.Tbody>
                                </Table>
                            </Table.ScrollContainer>
                        )}
                        <Group justify="space-between">
                            <Text size="xs" c="dimmed">{t('research.calibration.rated', '{{count}} rated', { count: ratedCount })}</Text>
                            <Button onClick={() => feedbackMut.mutate()} loading={feedbackMut.isPending} disabled={ratedCount === 0}>
                                {t('research.calibration.saveFeedback', 'Save')}
                            </Button>
                        </Group>
                    </Stack>
                </Paper>

                {/* Step 3 — model-proposed revision: set-diff vs the live arrays, then apply (CAS) */}
                <Paper withBorder radius="md" p="md">
                    <Stack gap="sm">
                        <StepHeader title={t('research.calibration.step3', '3. Revision')} hint={t('research.calibration.step3Hint', 'The strategy model proposes an ICP revision from your ratings.')} />
                        <Group gap="sm">
                            <Button leftSection={<IconSparkles size={16} />} onClick={() => reviseMut.mutate()} disabled={savedCount === 0 || anyRunning} loading={reviseRunning}>
                                {t('research.calibration.propose', 'Propose revision')}
                            </Button>
                            {savedCount === 0 && (
                                <Text size="sm" c="dimmed">{t('research.calibration.needFeedback', 'Save at least one rating before requesting a revision.')}</Text>
                            )}
                        </Group>
                        {reviseRunning && (
                            <Group gap="xs"><Loader size="xs" /><Text size="sm" c="dimmed">{t('research.calibration.revising', 'Revision being generated…')}</Text></Group>
                        )}
                        {job?.kind === 'revise' && jobStatus === 'failed' && (
                            <Alert color="red" icon={<IconInfoCircle size={16} />}>{t('research.calibration.reviseFailed', 'Revision failed')}: {jobQuery.data?.error ?? 'unknown'}</Alert>
                        )}
                        {revision && (
                            <Stack gap="sm">
                                <Divider />
                                {RULESET_KEYS.map((key) => {
                                    const { added, removed } = diffArrays(live[key] ?? [], revision[key] ?? []);
                                    return (
                                        <div key={key}>
                                            <Text size="sm" fw={600}>{t(`research.calibration.${RULESET_LABEL[key].key}`, RULESET_LABEL[key].fallback)}</Text>
                                            {added.length === 0 && removed.length === 0 ? (
                                                <Text size="xs" c="dimmed">{t('research.calibration.noChange', 'No change')}</Text>
                                            ) : (
                                                <Stack gap={2}>
                                                    {removed.map((s) => <Text key={`-${s}`} size="xs" c="red" td="line-through">− {s}</Text>)}
                                                    {added.map((s) => <Text key={`+${s}`} size="xs" c="green">+ {s}</Text>)}
                                                </Stack>
                                            )}
                                        </div>
                                    );
                                })}
                                <Text size="sm" fw={600}>{t('research.calibration.changes', 'What changed')}</Text>
                                <List size="sm" spacing={2}>
                                    {revision.changes_summary.map((s, i) => <List.Item key={i}>{s}</List.Item>)}
                                </List>
                                <Text size="sm" fw={600}>{t('research.calibration.rationale', 'Rationale')}</Text>
                                <Text size="sm" c="dimmed">{revision.rationale}</Text>
                                <Group justify="flex-end">
                                    <Button
                                        color="grape"
                                        disabled={!live.revision_job_id}
                                        onClick={() => live.revision_job_id && applyMut.mutate({ rulesetVersion: live.ruleset_version, revisionJobId: live.revision_job_id })}
                                        loading={applyMut.isPending}
                                    >
                                        {t('research.calibration.apply', 'Apply')}
                                    </Button>
                                </Group>
                            </Stack>
                        )}
                    </Stack>
                </Paper>

                {/* Step 4 — mark the (re-approved) logic calibrated */}
                <Paper withBorder radius="md" p="md">
                    <Stack gap="sm">
                        <StepHeader title={t('research.calibration.step4', '4. Finish')} hint={t('research.calibration.step4Hint', 'Once the re-approved ICP samples well, mark the logic calibrated.')} />
                        <Group justify="space-between" align="center">
                            {live.calibrated_at ? (
                                <Text size="sm" c="teal">
                                    {t('research.calibration.calibratedAt', 'Calibrated: {{date}}', { date: new Date(live.calibrated_at).toLocaleString() })}
                                </Text>
                            ) : (
                                <Text size="sm" c="dimmed">
                                    {live.status !== 'approved'
                                        ? t('research.calibration.needApprovedFinish', 'The ICP must be approved before you can mark it calibrated.')
                                        : ''}
                                </Text>
                            )}
                            <Button color="green" leftSection={<IconChecks size={16} />} onClick={() => markMut.mutate()} loading={markMut.isPending} disabled={live.status !== 'approved'}>
                                {t('research.calibration.markCalibrated', 'Approve the logic')}
                            </Button>
                        </Group>
                    </Stack>
                </Paper>
            </Stack>
        </Drawer>
    );
}
