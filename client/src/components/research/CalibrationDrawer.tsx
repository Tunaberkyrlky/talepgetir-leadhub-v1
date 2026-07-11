/**
 * CalibrationDrawer — WP1 calibration loop (C1–C2) for one ICP.
 * Sample a small capped harvest for a geography → rate each sampled company good/bad →
 * ask the strategy model for an ICP revision → review the diff and apply it (the 062
 * trigger bumps ruleset_version + reverts approved→draft) → re-approve on the card →
 * finally mark the logic "calibrated". Credits surface as lead counts — never dollars.
 * All query/mutation logic now lives in ../../lib/useCalibration.ts (WP8b), shared with the
 * wizard's steps 11-14 — this file owns ONLY the Drawer chrome + table JSX below, unchanged
 * from before the extraction.
 */
import {
    ActionIcon, Alert, Badge, Button, Divider, Drawer, Group, List, Loader, Paper,
    SegmentedControl, Stack, Table, Text, TextInput, Tooltip,
} from '@mantine/core';
import {
    IconChecks, IconInfoCircle, IconPlayerPlay, IconSparkles, IconThumbDown, IconThumbUp, IconWorld,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { diffArrays, RULESET_KEYS, RULESET_LABEL, useCalibration, type CompanyRow } from '../../lib/useCalibration';
import { useAuth } from '../../contexts/AuthContext';
import type { ResearchIcp } from './IcpCard';

const CALIBRATION_COLOR: Record<ResearchIcp['calibration_state'], string> = {
    none: 'gray', sampling: 'blue', feedback: 'yellow', revised: 'grape', calibrated: 'green',
};

const VERDICT_COLOR: Record<CompanyRow['status'], string> = {
    match: 'green', partial: 'yellow', eliminated: 'red', review: 'gray',
};

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
    // Tenant-scoped reset key (P1-D, WP8b review) — same reasoning as ResearchFlowPage.tsx's
    // own call site: without it, a tenant switch while this Drawer happens to be mounted would
    // leave the previous tenant's typed-in geography behind for the auto-sample-adjacent state.
    const { activeTenantId } = useAuth();
    const calib = useCalibration(icp, opened, activeTenantId);
    const {
        geography, setGeography, source, setSource, ratings, companies, companiesQuery, savedCount,
        jobQuery, jobStatus, sampleMut, feedbackMut, reviseMut, applyMut, markMut,
        live, calibrationState: state, revision, sampleRunning, reviseRunning, anyRunning, canSample, ratedCount,
        setRating, setNote,
    } = calib;

    if (!icp || !live) return null;

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
                        {calib.job?.kind === 'sample' && jobStatus === 'failed' && (
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
                        {calib.job?.kind === 'revise' && jobStatus === 'failed' && (
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
