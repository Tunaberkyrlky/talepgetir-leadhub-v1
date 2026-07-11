/**
 * OfferCard — the "one offer/angle" editor: pain/value-prop/proof-points/objections + human
 * score + approve/reject. Extracted from OffersPanel.tsx (WP9, GeoCellDetail-extraction
 * precedent from WP8a) so the EXACT same card can be reused by the wizard's step 16 (one card
 * per screen, no grid chrome) without touching OffersPanel's existing SimpleGrid-based
 * behavior at /research/full. OffersPanel now imports this file instead of defining its own.
 */
import { useState } from 'react';
import { Badge, Button, Card, Group, Rating, Stack, TagsInput, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess, showWarning } from '../../lib/notifications';

export interface OfferRow {
    id: string;
    icp_id: string;
    geo_id: string | null;
    angle_code: string;
    pain_hypothesis: string;
    value_prop: string;
    proof_points: string[];
    objections: string[];
    language: string | null;
    status: 'draft' | 'approved' | 'rejected';
    human_score: number | null;
    note: string | null;
    updated_at: string;
}

export interface AngleStats { sent: number; replies: number; positive: number }

// Not exported (react-refresh wants component-only exports from a file — same convention as
// IcpCard.tsx/GeoCellDetail.tsx's own duplicated status-color maps).
const STATUS_COLOR: Record<OfferRow['status'], string> = { draft: 'gray', approved: 'green', rejected: 'red' };

export function OfferCard({ offer, stats, onChanged }: { offer: OfferRow; stats: AngleStats | null; onChanged: () => void }) {
    const { t } = useTranslation();
    const [pain, setPain] = useState(offer.pain_hypothesis);
    const [valueProp, setValueProp] = useState(offer.value_prop);
    const [proofPoints, setProofPoints] = useState<string[]>(offer.proof_points ?? []);
    const [objections, setObjections] = useState<string[]>(offer.objections ?? []);
    const [language, setLanguage] = useState(offer.language ?? '');
    const [score, setScore] = useState(offer.human_score ?? 0);

    const saveMut = useMutation({
        mutationFn: async () =>
            (await api.patch(`/research/offers/${offer.id}`, {
                pain_hypothesis: pain,
                value_prop: valueProp,
                proof_points: proofPoints,
                objections,
                language: language.trim() || null,
            })).data,
        onSuccess: () => {
            showSuccess(t('research.offers.saved', 'Angle saved — the card is back in draft.'));
            onChanged();
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const rejectMut = useMutation({
        mutationFn: async () => (await api.post(`/research/offers/${offer.id}/reject`, {})).data,
        onSuccess: () => {
            showSuccess(t('research.offers.rejectedToast', 'Angle rejected — it no longer counts toward the limit.'));
            onChanged();
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const approveMut = useMutation({
        mutationFn: async () =>
            (await api.post(`/research/offers/${offer.id}/approve`, { human_score: score, updated_at: offer.updated_at })).data,
        onSuccess: () => {
            showSuccess(t('research.offers.approvedToast', 'Angle approved — harvests now suggest it per firm.'));
            onChanged();
        },
        onError: (err: unknown) => {
            const resp = (err as { response?: { status?: number; data?: { current_updated_at?: string } } }).response;
            if (resp?.status === 409 && resp.data?.current_updated_at) {
                showWarning(t('research.offers.staleApprove', 'This angle changed since you opened it — review the latest card and approve again.'));
                onChanged();
                return;
            }
            showErrorFromApi(err);
        },
    });

    return (
        <Card withBorder radius="md" padding="md">
            <Stack gap="sm">
                <Group justify="space-between" align="center">
                    <Group gap="xs">
                        <Badge variant="filled" color="grape">{offer.angle_code}</Badge>
                        <Badge variant="light" color={STATUS_COLOR[offer.status] ?? 'gray'}>
                            {t(`research.offers.statusValue.${offer.status}`, offer.status)}
                        </Badge>
                    </Group>
                    {offer.language && <Badge variant="outline" size="xs">{offer.language}</Badge>}
                </Group>

                {stats && stats.sent > 0 && (
                    <Text size="xs" c="dimmed">
                        {t('research.outcomes.angleStats', '{{sent}} sent · {{replies}} replies · {{positive}} positive', { sent: stats.sent, replies: stats.replies, positive: stats.positive })}
                    </Text>
                )}

                <Textarea
                    label={t('research.offers.pain', 'Pain hypothesis')}
                    autosize minRows={2}
                    value={pain} onChange={(e) => setPain(e.currentTarget.value)}
                />
                <Textarea
                    label={t('research.offers.valueProp', 'Value proposition')}
                    autosize minRows={2}
                    value={valueProp} onChange={(e) => setValueProp(e.currentTarget.value)}
                />
                <TagsInput
                    label={t('research.offers.proofPoints', 'Proof points')}
                    value={proofPoints} onChange={setProofPoints}
                />
                <TagsInput
                    label={t('research.offers.objections', 'Likely objections')}
                    value={objections} onChange={setObjections}
                />
                <TextInput
                    label={t('research.offers.language', 'Language')}
                    placeholder="en"
                    value={language} onChange={(e) => setLanguage(e.currentTarget.value)}
                    w={120}
                />

                <Group justify="space-between" align="center">
                    <Text size="xs" c="dimmed">
                        {t('research.offers.saveHint', 'Saving returns the card to draft; approve it again afterwards.')}
                    </Text>
                    <Button size="xs" variant="default" onClick={() => saveMut.mutate()} loading={saveMut.isPending}>
                        {t('research.offers.save', 'Save')}
                    </Button>
                </Group>

                <Group justify="space-between" align="center">
                    <div>
                        <Text size="sm" fw={600}>{t('research.offers.yourScore', 'Your score')}: {score}/10</Text>
                        <Rating count={10} value={score} onChange={setScore} />
                    </div>
                    <Group gap="xs">
                        <Button
                            size="xs" variant="subtle" color="red"
                            onClick={() => rejectMut.mutate()}
                            loading={rejectMut.isPending}
                            disabled={offer.status === 'rejected'}
                        >
                            {t('research.offers.reject', 'Reject')}
                        </Button>
                        <Tooltip label={t('research.offers.approveHint', 'Approved angles feed per-firm suggestions and the CRM export.')}>
                            <Button
                                size="xs" color="teal"
                                onClick={() => approveMut.mutate()}
                                loading={approveMut.isPending}
                                disabled={offer.status === 'approved'}
                            >
                                {t('research.offers.approve', 'Approve')}
                            </Button>
                        </Tooltip>
                    </Group>
                </Group>
            </Stack>
        </Card>
    );
}
