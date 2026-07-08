/**
 * IcpCard — review/edit/score one ICP draft (B5).
 * Structured fields are the editable final; the customer scores /10 and approves.
 * The original AI draft is preserved server-side (ai_draft) for eval.
 */
import { useState } from 'react';
import {
    Card, Stack, Group, TextInput, Textarea, TagsInput, Slider, Button, Badge, Text, Divider,
} from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';
import CalibrationDrawer from './CalibrationDrawer';

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

export default function IcpCard({ icp }: { icp: ResearchIcp }) {
    const { t } = useTranslation();
    const qc = useQueryClient();

    const [draft, setDraft] = useState<ResearchIcp>(icp);
    const [calibrationOpen, setCalibrationOpen] = useState(false);
    const score = draft.human_score ?? 5;

    const invalidate = () => qc.invalidateQueries({ queryKey: ['research', 'icps', icp.project_id] });

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

    return (
        <Card withBorder radius="md" padding="lg">
            <Stack gap="sm">
                <Group justify="space-between" align="flex-start">
                    <TextInput
                        style={{ flex: 1 }}
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
                        variant="unstyled"
                        size="md"
                        fw={600}
                    />
                    <Group gap="xs">
                        {draft.code && <Badge variant="light" color="violet">{draft.code}</Badge>}
                        <Badge variant="light" color={CALIBRATION_COLOR[icp.calibration_state]}>
                            {t(`research.calibration.state.${icp.calibration_state}`, icp.calibration_state)}
                        </Badge>
                        <Badge color={STATUS_COLOR[draft.status]}>{draft.status}</Badge>
                    </Group>
                </Group>

                <Textarea
                    label={t('research.icp.segment', 'Segment')}
                    autosize minRows={1}
                    value={draft.segment ?? ''}
                    onChange={(e) => setDraft({ ...draft, segment: e.currentTarget.value })}
                />

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

                <Divider my="xs" />

                <Text size="sm" fw={500}>
                    {t('research.icp.score', 'Your score')}: {score}/10
                </Text>
                <Slider
                    min={0} max={10} step={1}
                    marks={[{ value: 0, label: '0' }, { value: 5, label: '5' }, { value: 10, label: '10' }]}
                    value={score}
                    onChange={(v) => setDraft({ ...draft, human_score: v })}
                    mb="md"
                />
                <Textarea
                    label={t('research.icp.note', 'Note')}
                    autosize minRows={1}
                    value={draft.note ?? ''}
                    onChange={(e) => setDraft({ ...draft, note: e.currentTarget.value })}
                />

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

                {/* Renders in a portal; mounted per card so its job polling survives closing. */}
                <CalibrationDrawer icp={icp} opened={calibrationOpen} onClose={() => setCalibrationOpen(false)} />
            </Stack>
        </Card>
    );
}
