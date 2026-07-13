/**
 * IcpCard — review/edit/score one ICP draft (B5).
 * Structured fields are the editable final; the customer scores /10 and approves.
 * The original AI draft is preserved server-side (ai_draft) for eval.
 *
 * Visual hierarchy (Tg-Research-v2/06_WIZARD_TASARIM.md, Karar 5 — Stage 2): the human-readable
 * synthesis (name, segment description, plain-language qualifying signals) is the dominant
 * surface; the raw signals/negative_signals/elimination_rules/lookalike_companies chip editors
 * live behind a closed-by-default "Details" disclosure, matching OfferCard.tsx's pattern exactly.
 *
 * State-init contract (do not change): `draft` seeds from the `icp` prop via useState with NO
 * prop-sync effect — this card relies on the caller remounting it via a changing `key` whenever
 * the underlying ICP meaningfully changes (ResearchFlowPage.tsx keys it by `icp.id` at step 8 and
 * by `id:ruleset_version:status` at step 14). Adding a useEffect to re-sync `draft` from `icp`
 * would silently overwrite in-progress edits on every parent re-render instead.
 */
import { useState } from 'react';
import {
    Badge, Button, Card, Collapse, Group, Slider, Stack, TagsInput, Text, Textarea, TextInput, Tooltip, UnstyledButton,
} from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { IconChevronDown } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';
import CalibrationDrawer from './CalibrationDrawer';
import { AiReviseButton } from './AiReviseButton';

export interface ResearchIcp {
    id: string;
    project_id: string;
    name: string;
    code: string | null;
    segment: string | null;
    signals: string[];
    negative_signals: string[];
    neutral_signals: string[];
    elimination_rules: string[];
    lookalike_companies: string[];
    human_score: number | null;
    note: string | null;
    status: 'draft' | 'approved' | 'rejected';
    ruleset_version: number;
    calibration_state: 'none' | 'sampling' | 'feedback' | 'revised' | 'calibrated';
    calibrated_at: string | null;
}

const STATUS_COLOR: Record<ResearchIcp['status'], string> = {
    draft: 'gray',
    approved: 'teal',
    rejected: 'red',
};

// Same map lives in CalibrationDrawer (not exported — react-refresh wants component-only exports).
const CALIBRATION_COLOR: Record<ResearchIcp['calibration_state'], string> = {
    none: 'gray', sampling: 'blue', feedback: 'yellow', revised: 'grape', calibrated: 'green',
};

const MAX_SIGNAL_CHIPS = 4;

export default function IcpCard({ icp }: { icp: ResearchIcp }) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const reduceMotion = useReducedMotion();

    // WP5: campaign outcome aggregate (counts only) — the reply-rate badge. Empty until the
    // daily feedback:aggregate has data for this ICP; cached long (stats move daily).
    const outcomesQuery = useQuery<{ total: { sent: number; replies: number; positive: number } | null }>({
        queryKey: ['research', 'icp-outcomes', icp.id],
        queryFn: async () => (await api.get(`/research/icps/${icp.id}/outcomes`)).data,
        staleTime: 5 * 60 * 1000,
    });
    const outcomeTotal = outcomesQuery.data?.total ?? null;

    const [draft, setDraft] = useState<ResearchIcp>(icp);
    const [calibrationOpen, setCalibrationOpen] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const score = draft.human_score ?? 5;

    // Invalidates BOTH the list key (step 8's own cards, ResearchPage's advanced view) AND the
    // singular icp key (WP8b review — useCalibration's own icpQuery reads ['research','icp',id],
    // and step 14 reuses this exact card to re-approve mid-calibration; without this, approving
    // here left `calib.live` permanently stale and its status-gated "Approve the logic" button
    // permanently disabled — a real dead end, not just a display glitch).
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ['research', 'icps', icp.project_id] });
        qc.invalidateQueries({ queryKey: ['research', 'icp', icp.id] });
    };

    const editBody = () => ({
        name: draft.name,
        code: draft.code ?? undefined,
        segment: draft.segment ?? undefined,
        signals: draft.signals,
        negative_signals: draft.negative_signals,
        neutral_signals: draft.neutral_signals,
        elimination_rules: draft.elimination_rules,
        lookalike_companies: draft.lookalike_companies,
        human_score: draft.human_score,
        note: draft.note,
    });

    const saveMut = useMutation({
        mutationFn: async () => (await api.patch(`/research/icps/${icp.id}`, editBody())).data,
        onSuccess: () => { showSuccess(t('research.icp.saved', 'ICP saved')); invalidate(); },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    // Approve persists the on-screen edits FIRST, then approves with a version CAS (063 #11):
    // the save returns the (possibly trigger-bumped) ruleset_version, and approve is gated on
    // that exact version — so an unsaved edit is never lost AND a concurrent edit between the
    // two requests can't be approved unseen (the server returns 409 instead).
    const approveMut = useMutation({
        mutationFn: async () => {
            const saved = (await api.patch(`/research/icps/${icp.id}`, editBody())).data as { ruleset_version: number };
            return (await api.post(`/research/icps/${icp.id}/approve`, {
                human_score: score,
                note: draft.note ?? undefined,
                ruleset_version: saved.ruleset_version,
            })).data;
        },
        onSuccess: () => { showSuccess(t('research.icp.approved', 'ICP approved')); invalidate(); },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const visibleSignals = draft.signals.slice(0, MAX_SIGNAL_CHIPS);
    const hiddenSignalCount = draft.signals.length - visibleSignals.length;

    return (
        <Card withBorder radius="md" padding="lg">
            <Stack gap="sm">
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                    <TextInput
                        style={{ flex: 1 }}
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
                        variant="unstyled"
                        size="lg"
                        fw={700}
                    />
                    <Group gap={6} wrap="nowrap">
                        {outcomeTotal && outcomeTotal.sent > 0 && (
                            <Tooltip label={t('research.outcomes.tooltip', '{{replies}} replies / {{sent}} sent ({{positive}} positive)', { replies: outcomeTotal.replies, sent: outcomeTotal.sent, positive: outcomeTotal.positive })}>
                                <Badge variant="light" color={outcomeTotal.replies > 0 ? 'teal' : 'gray'}>
                                    {t('research.outcomes.replyRate', 'Reply {{pct}}%', { pct: Math.round((outcomeTotal.replies / outcomeTotal.sent) * 100) })}
                                </Badge>
                            </Tooltip>
                        )}
                        {draft.code && <Badge variant="light" color="violet">{draft.code}</Badge>}
                        <Badge variant="light" color={CALIBRATION_COLOR[icp.calibration_state]}>
                            {t(`research.calibration.state.${icp.calibration_state}`, icp.calibration_state)}
                        </Badge>
                        <Badge color={STATUS_COLOR[draft.status]}>{draft.status}</Badge>
                    </Group>
                </Group>

                <Stack gap={4}>
                    <Group justify="space-between" align="center" wrap="nowrap">
                        <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('research.icp.segment', 'Segment')}</Text>
                        <AiReviseButton entity="icp" id={icp.id} field="segment" currentValue={draft.segment ?? ''} onApply={(v) => setDraft({ ...draft, segment: v })} />
                    </Group>
                    <Textarea
                        variant="unstyled"
                        autosize minRows={1}
                        placeholder={t('research.icp.segmentPh', 'Describe this segment in plain language…')}
                        value={draft.segment ?? ''}
                        onChange={(e) => setDraft({ ...draft, segment: e.currentTarget.value })}
                        styles={{ input: { fontSize: 'var(--mantine-font-size-md)', fontWeight: 500, lineHeight: 1.35, padding: 0 } }}
                    />
                </Stack>

                {visibleSignals.length > 0 ? (
                    <Group gap={6} wrap="wrap">
                        {visibleSignals.map((signal) => (
                            <Badge key={signal} variant="dot" color="grape" size="sm" radius="sm" tt="none" fw={500}>
                                {signal}
                            </Badge>
                        ))}
                        {hiddenSignalCount > 0 && (
                            <Badge variant="outline" color="gray" size="sm" radius="sm" tt="none" fw={500}>
                                +{hiddenSignalCount}
                            </Badge>
                        )}
                    </Group>
                ) : (
                    <Text size="sm" c="dimmed">{t('research.icp.noSignals', 'No qualifying signals yet — add them in Details.')}</Text>
                )}

                <div>
                    <Text size="sm" fw={600}>{t('research.icp.score', 'Your score')}: {score}/10</Text>
                    <Slider
                        min={0} max={10} step={1}
                        marks={[{ value: 0, label: '0' }, { value: 5, label: '5' }, { value: 10, label: '10' }]}
                        value={score}
                        onChange={(v) => setDraft({ ...draft, human_score: v })}
                        mb="md"
                    />
                </div>
                <Stack gap={4}>
                    <Group justify="space-between" align="center" wrap="nowrap">
                        <Text size="sm" fw={500}>{t('research.icp.note', 'Note')}</Text>
                        <AiReviseButton entity="icp" id={icp.id} field="note" currentValue={draft.note ?? ''} onApply={(v) => setDraft({ ...draft, note: v })} />
                    </Group>
                    <Textarea
                        autosize minRows={1}
                        value={draft.note ?? ''}
                        onChange={(e) => setDraft({ ...draft, note: e.currentTarget.value })}
                    />
                </Stack>

                <Group justify="flex-end" mt="xs">
                    <Button variant="light" onClick={() => setCalibrationOpen(true)}>
                        {t('research.calibration.open', 'Calibration')}
                    </Button>
                    <Button variant="default" loading={saveMut.isPending} onClick={() => saveMut.mutate()}>
                        {t('research.icp.save', 'Save')}
                    </Button>
                    <Button
                        color="teal"
                        loading={approveMut.isPending}
                        disabled={draft.status === 'approved'}
                        onClick={() => approveMut.mutate()}
                    >
                        {t('research.icp.approve', 'Approve')}
                    </Button>
                </Group>

                <UnstyledButton
                    onClick={() => setDetailsOpen((v) => !v)}
                    style={{ alignSelf: 'flex-start' }}
                    aria-expanded={detailsOpen}
                    aria-controls={`icp-details-${icp.id}`}
                >
                    <Group gap={4} c="dimmed" wrap="nowrap">
                        <Text size="xs" fw={600}>
                            {detailsOpen ? t('research.icp.hideDetails', 'Hide details') : t('research.icp.showDetails', 'Details')}
                        </Text>
                        <IconChevronDown
                            size={13}
                            style={{
                                transition: reduceMotion ? 'none' : 'transform 160ms ease',
                                transform: detailsOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                            }}
                        />
                    </Group>
                </UnstyledButton>

                <Collapse id={`icp-details-${icp.id}`} in={detailsOpen} transitionDuration={reduceMotion ? 0 : 200} transitionTimingFunction="ease">
                    <Stack gap="sm" pt={2}>
                        <TagsInput
                            label={t('research.icp.signals', 'Signals (fits if…)')}
                            value={draft.signals}
                            onChange={(v) => setDraft({ ...draft, signals: v })}
                        />
                        <TagsInput
                            label={t('research.icp.negativeSignals', 'Negative signals')}
                            value={draft.negative_signals}
                            onChange={(v) => setDraft({ ...draft, negative_signals: v })}
                        />
                        <TagsInput
                            label={t('research.icp.eliminationRules', 'Elimination rules')}
                            value={draft.elimination_rules}
                            onChange={(v) => setDraft({ ...draft, elimination_rules: v })}
                        />
                        <TagsInput
                            label={t('research.icp.lookalikes', 'Lookalike companies')}
                            value={draft.lookalike_companies}
                            onChange={(v) => setDraft({ ...draft, lookalike_companies: v })}
                        />
                    </Stack>
                </Collapse>

                {/* Renders in a portal; mounted per card so its job polling survives closing. */}
                <CalibrationDrawer icp={icp} opened={calibrationOpen} onClose={() => setCalibrationOpen(false)} />
            </Stack>
        </Card>
    );
}
