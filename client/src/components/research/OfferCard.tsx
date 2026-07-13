/**
 * OfferCard — the "one offer/angle" editor: pain/value-prop/proof-points/objections + human
 * score + approve/reject. Extracted from OffersPanel.tsx (WP9, GeoCellDetail-extraction
 * precedent from WP8a) so the EXACT same card can be reused by the wizard's step 16 (one card
 * per screen, no grid chrome) without touching OffersPanel's existing SimpleGrid-based
 * behavior at /research/full. OffersPanel now imports this file instead of defining its own.
 *
 * Visual hierarchy (Tg-Research-v2/06_WIZARD_TASARIM.md, Karar 5): the human-readable synthesis
 * (plain-language angle name, pitch/pain summary, evidence chips) is the dominant surface; the
 * raw angle_code is a quiet secondary label and the editable fields live behind a closed-by-
 * default "Details" disclosure — the closed card alone should be enough to decide.
 */
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Collapse, Group, Rating, Stack, TagsInput, Text, Textarea, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { IconChevronDown } from '@tabler/icons-react';
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

const MAX_EVIDENCE_CHIPS = 4;

// PREMIUM-BRAND-PULL → "Premium Brand Pull" — internal angle codes are machine identifiers,
// not a pitch; the card leads with a humanized reading and keeps the raw code as a quiet label.
function humanizeAngleCode(code: string): string {
    return code
        .split(/[-_]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

export function OfferCard({
    offer,
    stats,
    onChanged,
    skipEntranceAnimation,
}: {
    offer: OfferRow;
    stats: AngleStats | null;
    onChanged: () => void;
    /** Wizard step 16 only (ResearchFlowPage): true on the render where the wizard just arrived
     *  at step 16, because WizardShell's own StepTransition already fades the whole card in that
     *  moment — this card's local entrance would double-stack on top of it. Every other mount
     *  (paging between cards within step 16, and the plain OffersPanel grid at /research/full,
     *  where this prop is simply omitted/undefined) still gets this card's own per-card entrance,
     *  since nothing else animates those mounts in. */
    skipEntranceAnimation?: boolean;
}) {
    const { t } = useTranslation();
    const reduceMotion = useReducedMotion();
    const [pain, setPain] = useState(offer.pain_hypothesis);
    const [valueProp, setValueProp] = useState(offer.value_prop);
    const [proofPoints, setProofPoints] = useState<string[]>(offer.proof_points ?? []);
    const [objections, setObjections] = useState<string[]>(offer.objections ?? []);
    const [language, setLanguage] = useState(offer.language ?? '');
    const [score, setScore] = useState(offer.human_score ?? 0);
    const [detailsOpen, setDetailsOpen] = useState(false);

    // Small, purposeful entrance — the card settles in rather than snapping into place.
    // Skipped under prefers-reduced-motion OR when the wizard shell just animated this same
    // mount in itself (see skipEntranceAnimation's doc comment) — either way the effect just
    // leaves `entered` true from the start instead of animating a second time.
    const skipOwnAnimation = (reduceMotion ?? false) || (skipEntranceAnimation ?? false);
    const [entered, setEntered] = useState(skipOwnAnimation);
    // skipEntranceAnimation intentionally excluded from deps: it reflects the mount-time context
    // (see the prop's doc comment) and must not re-trigger this effect on later re-renders.
    useEffect(() => {
        if (skipOwnAnimation) return;
        const frame = requestAnimationFrame(() => setEntered(true));
        return () => cancelAnimationFrame(frame);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reduceMotion]);

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
            // Stable id: approving several angle cards in normal sequence fires this same
            // message repeatedly within seconds — without an id each call gets its own random
            // id and they visibly stack instead of the later approval replacing the toast.
            showSuccess(t('research.offers.approvedToast', 'Angle approved — harvests now suggest it per firm.'), { id: 'research-offer-approved' });
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

    const angleName = humanizeAngleCode(offer.angle_code);
    const visibleEvidence = proofPoints.slice(0, MAX_EVIDENCE_CHIPS);
    const hiddenEvidenceCount = proofPoints.length - visibleEvidence.length;

    return (
        <Card
            withBorder radius="md" padding="md"
            style={{
                opacity: reduceMotion || entered ? 1 : 0,
                transform: reduceMotion || entered ? 'translateY(0)' : 'translateY(8px)',
                transition: reduceMotion ? 'none' : 'opacity 260ms ease-out, transform 260ms ease-out',
            }}
        >
            <Stack gap="sm">
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                    <div>
                        <Text fw={700} size="lg" lh={1.2}>{angleName}</Text>
                        <Text size="xs" c="dimmed" ff="monospace" mt={2}>{offer.angle_code}</Text>
                    </div>
                    <Group gap={6} wrap="nowrap">
                        <Badge variant="light" color={STATUS_COLOR[offer.status] ?? 'gray'}>
                            {t(`research.offers.statusValue.${offer.status}`, offer.status)}
                        </Badge>
                        {offer.language && <Badge variant="outline" size="xs">{offer.language}</Badge>}
                    </Group>
                </Group>

                <Stack gap={4}>
                    <Text size="sm" fw={600} lineClamp={2}>
                        {valueProp || t('research.offers.noValueProp', 'No pitch written yet — add one in Details.')}
                    </Text>
                    {pain && <Text size="sm" c="dimmed" lineClamp={2}>{pain}</Text>}
                </Stack>

                {visibleEvidence.length > 0 && (
                    <Group gap={6} wrap="wrap">
                        {visibleEvidence.map((point) => (
                            <Badge key={point} variant="dot" color="grape" size="sm" radius="sm" tt="none" fw={500}>
                                {point}
                            </Badge>
                        ))}
                        {hiddenEvidenceCount > 0 && (
                            <Badge variant="outline" color="gray" size="sm" radius="sm" tt="none" fw={500}>
                                +{hiddenEvidenceCount}
                            </Badge>
                        )}
                    </Group>
                )}

                {stats && stats.sent > 0 && (
                    <Text size="xs" c="dimmed">
                        {t('research.outcomes.angleStats', '{{sent}} sent · {{replies}} replies · {{positive}} positive', { sent: stats.sent, replies: stats.replies, positive: stats.positive })}
                    </Text>
                )}

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

                <UnstyledButton onClick={() => setDetailsOpen((v) => !v)} style={{ alignSelf: 'flex-start' }}>
                    <Group gap={4} c="dimmed" wrap="nowrap">
                        <Text size="xs" fw={600}>
                            {detailsOpen ? t('research.offers.hideDetails', 'Hide details') : t('research.offers.showDetails', 'Details')}
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

                <Collapse in={detailsOpen} transitionDuration={reduceMotion ? 0 : 200} transitionTimingFunction="ease">
                    <Stack gap="sm" pt={2}>
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
                    </Stack>
                </Collapse>
            </Stack>
        </Card>
    );
}
