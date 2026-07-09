/**
 * OffersPanel — WP4 offer/angle cards.
 * Pick a project → an approved ICP → "Generate angles": offer:generate (strategy model) drafts
 * 3-5 outreach angles (pain hypothesis, value prop, proof points, objections). The customer
 * edits each card and /10-approves it — the ICP/geography human-gate. APPROVED angles then feed
 * harvest validation (per-firm angle_suggestion + hooks, same LLM pass) and travel to the CRM
 * export as Research Angle/Hooks custom fields. Message COPY stays in TG-Core campaigns.
 */
import { useEffect, useMemo, useState } from 'react';
import {
    Badge, Button, Card, Group, Loader, Paper, Rating, Select, SimpleGrid, Stack, TagsInput,
    Text, Textarea, TextInput, Tooltip,
} from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showError, showErrorFromApi, showSuccess, showWarning } from '../../lib/notifications';
import type { ResearchIcp } from './IcpCard';

interface ResearchProject { id: string; name: string }

interface OfferRow {
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

interface OfferJob {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    error: string | null;
}

const STATUS_COLOR: Record<OfferRow['status'], string> = { draft: 'gray', approved: 'green', rejected: 'red' };
const JOB_RUNNING = (s?: string) => s === 'queued' || s === 'running';

export default function OffersPanel() {
    const { t } = useTranslation();
    const qc = useQueryClient();

    const [projectId, setProjectId] = useState<string | null>(null);
    const [icpId, setIcpId] = useState<string | null>(null);
    const [jobId, setJobId] = useState<string | null>(null);

    const projectsQuery = useQuery<{ data: ResearchProject[] }>({
        queryKey: ['research', 'projects'],
        queryFn: async () => (await api.get('/research/projects')).data,
    });
    const projects = useMemo(() => projectsQuery.data?.data ?? [], [projectsQuery.data]);
    useEffect(() => {
        if (!projectId && projects.length === 1) setProjectId(projects[0].id);
    }, [projectId, projects]);

    const icpsQuery = useQuery<{ data: ResearchIcp[] }>({
        queryKey: ['research', 'icps', projectId],
        queryFn: async () => (await api.get(`/research/icps?project_id=${projectId}`)).data,
        enabled: !!projectId,
    });
    const icps = icpsQuery.data?.data ?? [];

    const offersQuery = useQuery<{ data: OfferRow[] }>({
        queryKey: ['research', 'offers', icpId],
        queryFn: async () => (await api.get(`/research/offers?icp_id=${icpId}`)).data,
        enabled: !!icpId,
    });
    const offers = offersQuery.data?.data ?? [];
    const invalidateOffers = () => qc.invalidateQueries({ queryKey: ['research', 'offers', icpId] });

    const generateMut = useMutation({
        mutationFn: async () => (await api.post('/research/offers/generate', { icp_id: icpId })).data as OfferJob,
        onSuccess: (job) => {
            setJobId(job.id);
            showSuccess(t('research.offers.generateStarted', 'Angle generation started — drafts appear below when it finishes.'));
        },
        onError: (err: unknown) => {
            const status = (err as { response?: { status?: number } }).response?.status;
            if (status === 402) {
                showError(t('research.offers.noCredits', 'You do not have research credits — top up before generating angles.'));
                return;
            }
            if (status === 409) {
                showWarning(t('research.offers.approveIcpFirst', 'Approve the ICP before generating angles.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    const jobQuery = useQuery<OfferJob>({
        queryKey: ['research', 'job', jobId],
        queryFn: async () => (await api.get(`/research/jobs/${jobId}`)).data,
        enabled: !!jobId,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 2500 : false),
    });
    const jobStatus = jobQuery.data?.status;
    useEffect(() => {
        if (jobStatus === 'succeeded') {
            showSuccess(t('research.offers.generateDone', 'Angle drafts are ready — review, edit and approve them.'));
            invalidateOffers();
            setJobId(null);
        }
        if (jobStatus === 'failed') {
            showError(t('research.offers.generateFailed', 'Angle generation failed — try again.'));
            setJobId(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jobStatus]);

    const generating = generateMut.isPending || JOB_RUNNING(jobStatus);
    const selectedIcp = icps.find((i) => i.id === icpId);

    return (
        <Stack gap="md">
            <Paper withBorder radius="md" p="md">
                <Group align="flex-end" gap="sm" wrap="wrap">
                    <Select
                        label={t('research.offers.project', 'Project')}
                        placeholder={t('research.offers.pickProject', 'Pick a project')}
                        data={projects.map((p) => ({ value: p.id, label: p.name }))}
                        value={projectId}
                        onChange={(v) => { setProjectId(v); setIcpId(null); }}
                        w={220} searchable
                    />
                    <Select
                        label={t('research.offers.icp', 'ICP')}
                        placeholder={t('research.offers.pickIcp', 'Pick an ICP')}
                        data={icps.map((i) => ({
                            value: i.id,
                            label: `${i.name}${i.status === 'approved' ? ' ✓' : ` (${i.status})`}`,
                        }))}
                        value={icpId}
                        onChange={setIcpId}
                        w={320} searchable
                        disabled={!projectId}
                    />
                    <Tooltip
                        label={t('research.offers.generateHint', 'Drafts 3-5 outreach angles from your profile, the ICP and real match evidence.')}
                    >
                        <Button
                            leftSection={generating ? <Loader size={14} color="white" /> : <IconSparkles size={16} />}
                            onClick={() => generateMut.mutate()}
                            disabled={!icpId || generating || selectedIcp?.status !== 'approved'}
                        >
                            {t('research.offers.generate', 'Generate angles')}
                        </Button>
                    </Tooltip>
                </Group>
                {selectedIcp && selectedIcp.status !== 'approved' && (
                    <Text size="xs" c="dimmed" mt={6}>
                        {t('research.offers.approveIcpFirst', 'Approve the ICP before generating angles.')}
                    </Text>
                )}
            </Paper>

            {icpId && offersQuery.isLoading && <Loader size="sm" />}
            {icpId && !offersQuery.isLoading && offers.length === 0 && (
                <Text c="dimmed" size="sm" ta="center" py="lg">
                    {t('research.offers.empty', 'No angles yet — generate drafts to start the offer map.')}
                </Text>
            )}

            <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
                {offers.map((o) => (
                    // Keyed on id + updated_at (geographies convention): any landed change remounts
                    // the card so the fields and the approve CAS token stay the same row generation.
                    <OfferCard key={`${o.id}:${o.updated_at}`} offer={o} onChanged={invalidateOffers} />
                ))}
            </SimpleGrid>
        </Stack>
    );
}

function OfferCard({ offer, onChanged }: { offer: OfferRow; onChanged: () => void }) {
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
