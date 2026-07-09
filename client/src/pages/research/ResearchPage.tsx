/**
 * ResearchPage — the Research module's customer surface.
 *   • ICP Master (B5): company profile → AI ICP drafts → score/refine/approve.
 *   • Leads (Y1): run capped harvests for an approved ICP and browse the verdict-aware
 *     companies list (CompaniesPanel). Credits appear as lead counts — never dollars.
 */
import { useState, useEffect } from 'react';
import {
    Container, Title, Text, Paper, Stack, Group, TextInput, Textarea, TagsInput,
    NumberInput, Button, Loader, Alert, SimpleGrid, Badge, Tabs,
} from '@mantine/core';
import { IconSparkles, IconInfoCircle, IconBuildingSkyscraper, IconTargetArrow, IconFileSpreadsheet, IconBrandLinkedin, IconWorldPin } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi } from '../../lib/notifications';
import IcpCard, { type ResearchIcp } from '../../components/research/IcpCard';
import CompaniesPanel from '../../components/research/CompaniesPanel';
import GeographiesPanel from '../../components/research/GeographiesPanel';
import OffersPanel from '../../components/research/OffersPanel';
import TradeImportsPanel from '../../components/research/TradeImportsPanel';
import LinkedInAccountsPanel from '../../components/linkedin/LinkedInAccountsPanel';

interface ResearchJob {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    progress: Record<string, unknown>;
    result: Record<string, unknown> | null;
    error: string | null;
}

const JOB_RUNNING = (s?: string) => s === 'queued' || s === 'running';

export default function ResearchPage() {
    const { t } = useTranslation();
    const qc = useQueryClient();

    // Profile form
    const [website, setWebsite] = useState('');
    const [whatTheyDo, setWhatTheyDo] = useState('');
    const [products, setProducts] = useState<string[]>([]);
    const [targetMarkets, setTargetMarkets] = useState<string[]>([]);
    const [exclusions, setExclusions] = useState<string[]>([]);
    const [count, setCount] = useState<number>(4);

    const [projectId, setProjectId] = useState<string | null>(null);
    const [jobId, setJobId] = useState<string | null>(null);

    // Create project (if needed) + enqueue generation.
    const generateMut = useMutation({
        mutationFn: async () => {
            const profile = {
                website,
                what_they_do: whatTheyDo,
                products,
                target_markets: targetMarkets,
                exclusions,
            };
            let pid = projectId;
            if (!pid) {
                const project = (await api.post('/research/projects', {
                    name: whatTheyDo.slice(0, 60) || 'Research project',
                    profile,
                })).data;
                pid = project.id as string;
                setProjectId(pid);
            } else {
                await api.patch(`/research/projects/${pid}`, { profile });
            }
            const job = (await api.post('/research/icps/generate', { project_id: pid, count })).data as ResearchJob;
            setJobId(job.id);
            return job;
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    // Poll the generation job while it runs.
    const jobQuery = useQuery<ResearchJob>({
        queryKey: ['research', 'job', jobId],
        queryFn: async () => (await api.get(`/research/jobs/${jobId}`)).data,
        enabled: !!jobId,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 1500 : false),
    });

    const jobDone = jobQuery.data?.status === 'succeeded';
    const jobFailed = jobQuery.data?.status === 'failed' || jobQuery.data?.status === 'canceled';

    // Load ICPs for the project (refreshed when the job succeeds).
    const icpsQuery = useQuery<{ data: ResearchIcp[] }>({
        queryKey: ['research', 'icps', projectId],
        queryFn: async () => (await api.get(`/research/icps?project_id=${projectId}`)).data,
        enabled: !!projectId && jobDone,
    });

    // When the job flips to succeeded, refresh the ICP list once (covers regenerate).
    const jobStatus = jobQuery.data?.status;
    useEffect(() => {
        if (jobStatus === 'succeeded' && projectId) {
            qc.invalidateQueries({ queryKey: ['research', 'icps', projectId] });
        }
    }, [jobStatus, projectId, qc]);

    const generating = generateMut.isPending || JOB_RUNNING(jobQuery.data?.status);
    const icps = icpsQuery.data?.data ?? [];

    return (
        <Container size="lg" py="lg">
            <Stack gap="lg">
                <div>
                    <Title order={2}>{t('research.title', 'Research')}</Title>
                    <Text c="dimmed" size="sm">
                        {t('research.subtitle', 'Describe your company; the assistant proposes ideal buyer profiles you score and refine.')}
                    </Text>
                </div>

                {/* Panels stay MOUNTED across tab switches: CompaniesPanel may be polling a running
                    harvest job — unmounting would drop the poll and orphan the run's progress UX. */}
                <Tabs defaultValue="icp">
                    <Tabs.List mb="md">
                        <Tabs.Tab value="icp" leftSection={<IconTargetArrow size={16} />}>
                            {t('research.tabs.icp', 'ICP Master')}
                        </Tabs.Tab>
                        <Tabs.Tab value="geographies" leftSection={<IconWorldPin size={16} />}>
                            {t('research.tabs.geographies', 'Geographies')}
                        </Tabs.Tab>
                        <Tabs.Tab value="offers" leftSection={<IconSparkles size={16} />}>
                            {t('research.tabs.offers', 'Offer angles')}
                        </Tabs.Tab>
                        <Tabs.Tab value="companies" leftSection={<IconBuildingSkyscraper size={16} />}>
                            {t('research.tabs.companies', 'Leads')}
                        </Tabs.Tab>
                        <Tabs.Tab value="trade" leftSection={<IconFileSpreadsheet size={16} />}>
                            {t('research.tabs.trade', 'Customs data')}
                        </Tabs.Tab>
                        <Tabs.Tab value="linkedin" leftSection={<IconBrandLinkedin size={16} />}>
                            {t('research.tabs.linkedin', 'LinkedIn Accounts')}
                        </Tabs.Tab>
                    </Tabs.List>

                    <Tabs.Panel value="geographies">
                        <GeographiesPanel />
                    </Tabs.Panel>

                    <Tabs.Panel value="offers">
                        <OffersPanel />
                    </Tabs.Panel>

                    <Tabs.Panel value="companies">
                        <CompaniesPanel />
                    </Tabs.Panel>

                    <Tabs.Panel value="trade">
                        <TradeImportsPanel />
                    </Tabs.Panel>

                    <Tabs.Panel value="linkedin">
                        <LinkedInAccountsPanel />
                    </Tabs.Panel>

                    <Tabs.Panel value="icp">
                    <Stack gap="lg">
                <Paper withBorder radius="md" p="lg">
                    <Stack gap="sm">
                        <TextInput
                            label={t('research.profile.website', 'Website')}
                            placeholder="https://…"
                            value={website}
                            onChange={(e) => setWebsite(e.currentTarget.value)}
                        />
                        <Textarea
                            label={t('research.profile.whatTheyDo', 'What does your company do?')}
                            autosize minRows={2}
                            value={whatTheyDo}
                            onChange={(e) => setWhatTheyDo(e.currentTarget.value)}
                        />
                        <TagsInput
                            label={t('research.profile.products', 'Products / services')}
                            value={products}
                            onChange={setProducts}
                        />
                        <TagsInput
                            label={t('research.profile.targetMarkets', 'Target markets (countries)')}
                            value={targetMarkets}
                            onChange={setTargetMarkets}
                        />
                        <TagsInput
                            label={t('research.profile.exclusions', 'Exclude (who is NOT a buyer)')}
                            value={exclusions}
                            onChange={setExclusions}
                        />
                        <Group justify="space-between" align="flex-end">
                            <NumberInput
                                label={t('research.profile.count', 'How many ICPs')}
                                min={1} max={8} value={count}
                                onChange={(v) => setCount(typeof v === 'number' ? v : 4)}
                                w={160}
                            />
                            <Button
                                leftSection={<IconSparkles size={18} />}
                                loading={generating}
                                disabled={!whatTheyDo.trim()}
                                onClick={() => generateMut.mutate()}
                            >
                                {projectId ? t('research.regenerate', 'Regenerate ICPs') : t('research.generate', 'Generate ICPs')}
                            </Button>
                        </Group>
                    </Stack>
                </Paper>

                {generating && (
                    <Group gap="xs">
                        <Loader size="sm" />
                        <Text size="sm" c="dimmed">
                            {t('research.generating', 'Generating ICPs… this can take up to a minute.')}
                            {jobQuery.data?.progress?.stage ? ` (${String(jobQuery.data.progress.stage)})` : ''}
                        </Text>
                    </Group>
                )}

                {jobFailed && (
                    <Alert color="red" icon={<IconInfoCircle size={18} />}>
                        {t('research.failed', 'Generation failed')}: {jobQuery.data?.error ?? 'unknown error'}
                    </Alert>
                )}

                {icps.length > 0 && (
                    <Stack gap="sm">
                        <Group justify="space-between">
                            <Title order={4}>{t('research.icp.heading', 'ICP drafts')}</Title>
                            <Badge variant="light">{icps.length}</Badge>
                        </Group>
                        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
                            {icps.map((icp) => <IcpCard key={icp.id} icp={icp} />)}
                        </SimpleGrid>
                    </Stack>
                )}
                    </Stack>
                    </Tabs.Panel>
                </Tabs>
            </Stack>
        </Container>
    );
}
