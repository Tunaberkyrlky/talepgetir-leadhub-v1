/**
 * OffersPanel — WP4 offer/angle cards.
 * Pick a project → an approved ICP → "Generate angles": offer:generate (strategy model) drafts
 * 3-5 outreach angles (pain hypothesis, value prop, proof points, objections). The customer
 * edits each card and /10-approves it — the ICP/geography human-gate. APPROVED angles then feed
 * harvest validation (per-firm angle_suggestion + hooks, same LLM pass) and travel to the CRM
 * export as Research Angle/Hooks custom fields. Message COPY stays in TG-Core campaigns.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Group, Loader, Paper, Select, SimpleGrid, Stack, Text, Tooltip } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showError, showErrorFromApi, showSuccess, showWarning } from '../../lib/notifications';
import type { ResearchIcp } from './IcpCard';
import { OfferCard, type OfferRow } from './OfferCard';

interface ResearchProject { id: string; name: string }

interface OfferJob {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    error: string | null;
}

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

    // WP5: per-angle campaign outcomes (counts only) for the stat line on each card.
    const outcomesQuery = useQuery<{ by_angle: Array<{ angle_code: string; sent: number; replies: number; positive: number }> }>({
        queryKey: ['research', 'icp-outcomes', icpId],
        queryFn: async () => (await api.get(`/research/icps/${icpId}/outcomes`)).data,
        enabled: !!icpId,
        staleTime: 5 * 60 * 1000,
    });
    const statsByAngle = new Map((outcomesQuery.data?.by_angle ?? []).map((a) => [a.angle_code.toLowerCase(), a]));

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
                    <OfferCard key={`${o.id}:${o.updated_at}`} offer={o} stats={statsByAngle.get(o.angle_code.toLowerCase()) ?? null} onChanged={invalidateOffers} />
                ))}
            </SimpleGrid>
        </Stack>
    );
}
