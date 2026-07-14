/**
 * ResearchPage — the Research module's customer surface.
 *   • ICP Master (B5): company profile → AI ICP drafts → score/refine/approve.
 *   • Leads (Y1): run capped harvests for an approved ICP and browse the verdict-aware
 *     companies list (CompaniesPanel). Credits appear as lead counts — never dollars.
 */
import { useState, useEffect } from 'react';
import {
    Container, Title, Text, Paper, Stack, Group, TextInput, Textarea, TagsInput,
    NumberInput, Button, Loader, Alert, SimpleGrid, Badge, Tabs, Divider,
} from '@mantine/core';
import { IconSparkles, IconInfoCircle, IconBuildingSkyscraper, IconTargetArrow, IconFileSpreadsheet, IconWorldPin, IconUserSearch, IconBarcode } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi } from '../../lib/notifications';
import IcpCard, { type ResearchIcp } from '../../components/research/IcpCard';
import { AiReviseButton } from '../../components/research/AiReviseButton';
import CompaniesPanel from '../../components/research/CompaniesPanel';
import GeographiesPanel from '../../components/research/GeographiesPanel';
import OffersPanel from '../../components/research/OffersPanel';
import HsCodesPanel from '../../components/research/HsCodesPanel';
import TradeImportsPanel from '../../components/research/TradeImportsPanel';
import EnrichmentPanel from '../../components/research/EnrichmentPanel';
import { useAuth } from '../../contexts/AuthContext';
import {
    latestResearchProjectQueryKey,
    type ResearchProjectSummary,
    type ResearchProjectsListResponse,
} from '../../lib/researchProjects';

interface ResearchJob {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    progress: Record<string, unknown>;
    result: Record<string, unknown> | null;
    error: string | null;
}

const JOB_RUNNING = (s?: string) => s === 'queued' || s === 'running';

const RESEARCH_TABS = ['icp', 'hs', 'geographies', 'offers', 'companies', 'enrichment', 'trade'];

function asStringArray(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asRecord(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStringField(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

export default function ResearchPage() {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const { activeTenantId } = useAuth();
    // URL-controlled active tab (?tab=…).
    const [searchParams, setSearchParams] = useSearchParams();
    const tabParam = searchParams.get('tab');
    const activeTab = tabParam && RESEARCH_TABS.includes(tabParam) ? tabParam : 'icp';
    const setActiveTab = (value: string | null) => {
        setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            if (value && value !== 'icp') next.set('tab', value); else next.delete('tab');
            return next;
        }, { replace: true });
    };

    // Profile form
    const [website, setWebsite] = useState('');
    const [whatTheyDo, setWhatTheyDo] = useState('');
    const [products, setProducts] = useState<string[]>([]);
    const [targetMarkets, setTargetMarkets] = useState<string[]>([]);
    const [exclusions, setExclusions] = useState<string[]>([]);
    const [count, setCount] = useState<number>(4);

    // Differentiators (profile.differentiators sub-object) + hints (profile.lookalike_customers) —
    // surfaced here so this page edits the SAME fields the wizard's step 5/6 write, not just the 5
    // basic ones. moq/lead_time/capacity are strings, the rest are string[].
    const [moq, setMoq] = useState('');
    const [leadTime, setLeadTime] = useState('');
    const [certifications, setCertifications] = useState<string[]>([]);
    const [capacity, setCapacity] = useState('');
    const [references, setReferences] = useState<string[]>([]);
    const [languages, setLanguages] = useState<string[]>([]);
    const [lookalikeCustomers, setLookalikeCustomers] = useState<string[]>([]);
    // scale_target is a TOP-LEVEL column (not profile) — '' means "no target".
    const [scaleTarget, setScaleTarget] = useState<number | ''>('');

    const [projectId, setProjectId] = useState<string | null>(null);
    const [jobId, setJobId] = useState<string | null>(null);

    // Full server-side profile object for the loaded/created project — preserved so a
    // PATCH here (wholesale JSONB replace, no server merge) never drops keys another
    // surface wrote into the same column (e.g. the wizard's contact_name/social_links,
    // WP6). Starts empty for a brand-new project created directly from this page —
    // there's nothing to preserve yet.
    const [loadedProfile, setLoadedProfile] = useState<Record<string, unknown>>({});

    // Deep-link continuation from the wizard's "Switch to advanced view" (WP6):
    // ?project=<id> loads that exact row instead of starting a second, blank one.
    // `hydratedFromProjectParam` ONLY ever flips true on a successful hydration — on
    // load failure it stays false forever, which (below) keeps Generate permanently
    // disabled for this session rather than silently falling through to the blank-create
    // path and risking a duplicate project (WP6 review P1).
    const projectParam = searchParams.get('project');
    const [hydratedFromProjectParam, setHydratedFromProjectParam] = useState(!projectParam);
    // True from mount until the deep-linked project's GET settles (success or error) —
    // Generate (and the profile fields themselves) are guarded while this is true so a
    // click can't fire into a still-blank form and POST a second project.
    const projectStillLoading = !!projectParam && !hydratedFromProjectParam;

    const existingProjectQuery = useQuery<{ id: string; profile: Record<string, unknown> | null; scale_target: number | null }>({
        queryKey: ['research', 'project', projectParam, activeTenantId],
        queryFn: async () => (await api.get(`/research/projects/${projectParam}`)).data,
        enabled: !!projectParam && !hydratedFromProjectParam,
    });

    // Adjusted synchronously during render (React's "you might not need an effect"
    // pattern, guarded by `hydratedFromProjectParam` so it can only ever fire once)
    // rather than in a useEffect, which would cause an extra cascading render.
    if (!hydratedFromProjectParam && projectParam && existingProjectQuery.isSuccess) {
        const loaded = existingProjectQuery.data;
        const p = loaded.profile ?? {};
        setProjectId(loaded.id);
        setLoadedProfile(p);
        setWebsite(typeof p.website === 'string' ? p.website : '');
        setWhatTheyDo(typeof p.what_they_do === 'string' ? p.what_they_do : '');
        setProducts(asStringArray(p.products));
        setTargetMarkets(asStringArray(p.target_markets));
        setExclusions(asStringArray(p.exclusions));
        // Surfaced differentiators + hints + scale_target (mirrors the wizard's step 5/6 seed).
        const d = asRecord(p.differentiators);
        setMoq(asStringField(d.moq));
        setLeadTime(asStringField(d.lead_time));
        setCertifications(asStringArray(d.certifications));
        setCapacity(asStringField(d.capacity));
        setReferences(asStringArray(d.references));
        setLanguages(asStringArray(d.languages));
        setLookalikeCustomers(asStringArray(p.lookalike_customers));
        setScaleTarget(typeof loaded.scale_target === 'number' ? loaded.scale_target : '');
        setHydratedFromProjectParam(true);
    }

    // Build the full profile JSONB from the form. Spread the full last-known server profile
    // FIRST, then override only the fields this form edits — a bare object would silently wipe
    // any other profile keys (e.g. the wizard's contact_name/social_links) on PATCH, since the
    // server replaces the JSONB column wholesale rather than merging it. differentiators is
    // replaced wholesale too (matches the wizard's step 5 save — same six sub-keys).
    const buildProfile = (): Record<string, unknown> => ({
        ...loadedProfile,
        website,
        what_they_do: whatTheyDo,
        products,
        target_markets: targetMarkets,
        exclusions,
        differentiators: {
            moq: moq.trim() || null,
            lead_time: leadTime.trim() || null,
            certifications,
            capacity: capacity.trim() || null,
            references,
            languages,
        },
        lookalike_customers: lookalikeCustomers,
    });

    // Persist the profile (create-if-new or PATCH) WITHOUT enqueueing generation — shared by
    // the standalone Save button and Generate so the two can never drift. scale_target is a
    // top-level column (0→null, matching the wizard's WP9 convention).
    const persistProfile = async (existingPid: string | null): Promise<string> => {
        const profile = buildProfile();
        const scaleTargetValue = scaleTarget === '' || scaleTarget === 0 ? null : scaleTarget;
        let pid = existingPid;
        if (!pid) {
            const project = (await api.post('/research/projects', {
                name: whatTheyDo.slice(0, 60) || 'Research project',
                profile,
            })).data;
            pid = project.id as string;
            setProjectId(pid);
            // scale_target isn't accepted at create — PATCH it in only when one was set.
            if (scaleTargetValue !== null) {
                await api.patch(`/research/projects/${pid}`, { scale_target: scaleTargetValue });
            }
            // A brand-new project genuinely IS the tenant's latest one by construction —
            // publish it into the shared "latest project" cache (also read by RootRedirect and
            // ResearchFlowPage) synchronously, not just via invalidate, so no reader can observe
            // a stale "no project yet" result in the refetch window (WP6 review P2).
            const summary: ResearchProjectSummary = {
                id: project.id,
                name: project.name,
                profile: project.profile ?? null,
                flow_state: project.flow_state ?? null,
            };
            const queryKey = latestResearchProjectQueryKey(activeTenantId);
            qc.setQueryData<ResearchProjectsListResponse>(queryKey, { data: [summary] });
            qc.invalidateQueries({ queryKey });
        } else {
            // Editing an EXISTING project here must never touch the "latest project" cache: this
            // advanced view can be editing an OLD project reached via a ?project=<id> deep link,
            // and publishing it as "latest" would corrupt what RootRedirect/ResearchFlowPage
            // resume into, even if a genuinely newer project exists (WP6 review P2 round 2).
            await api.patch(`/research/projects/${pid}`, { profile, scale_target: scaleTargetValue });
        }
        setLoadedProfile(profile);
        return pid;
    };

    // Save the profile only — no ICP generation, no job.
    const saveProfileMut = useMutation({
        mutationFn: async () => { await persistProfile(projectId); },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    // Create project (if needed) + enqueue generation.
    const generateMut = useMutation({
        mutationFn: async () => {
            const pid = await persistProfile(projectId);
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

    // Load ICPs for the project (refreshed when the job succeeds, or immediately when
    // the project was hydrated from an existing ?project= deep link — WP6).
    const icpsQuery = useQuery<{ data: ResearchIcp[] }>({
        queryKey: ['research', 'icps', projectId],
        queryFn: async () => (await api.get(`/research/icps?project_id=${projectId}`)).data,
        enabled: !!projectId && (jobDone || hydratedFromProjectParam),
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
                    <Title order={2}>{t('research.title', 'Company Knowledge')}</Title>
                    <Text c="dimmed" size="sm">
                        {t('research.subtitle', 'Everything the assistant knows about your company. Keep it current — your buyer profiles, offers and leads all build on it.')}
                    </Text>
                </div>

                {/* Panels stay MOUNTED across tab switches: CompaniesPanel may be polling a running
                    harvest job — unmounting would drop the poll and orphan the run's progress UX. */}
                <Tabs value={activeTab} onChange={setActiveTab}>
                    <Tabs.List mb="md">
                        <Tabs.Tab value="icp" leftSection={<IconTargetArrow size={16} />}>
                            {t('research.tabs.icp', 'ICP Master')}
                        </Tabs.Tab>
                        <Tabs.Tab value="hs" leftSection={<IconBarcode size={16} />}>
                            {t('research.tabs.hs', 'HS Codes')}
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
                        <Tabs.Tab value="enrichment" leftSection={<IconUserSearch size={16} />}>
                            {t('research.tabs.enrichment', 'Contacts')}
                        </Tabs.Tab>
                        <Tabs.Tab value="trade" leftSection={<IconFileSpreadsheet size={16} />}>
                            {t('research.tabs.trade', 'Customs data')}
                        </Tabs.Tab>
                    </Tabs.List>

                    <Tabs.Panel value="hs"><HsCodesPanel /></Tabs.Panel>

                    <Tabs.Panel value="geographies">
                        <GeographiesPanel />
                    </Tabs.Panel>

                    <Tabs.Panel value="offers">
                        <OffersPanel />
                    </Tabs.Panel>

                    <Tabs.Panel value="companies">
                        <CompaniesPanel />
                    </Tabs.Panel>

                    <Tabs.Panel value="enrichment">
                        <EnrichmentPanel />
                    </Tabs.Panel>

                    <Tabs.Panel value="trade">
                        <TradeImportsPanel />
                    </Tabs.Panel>

                    <Tabs.Panel value="icp">
                    <Stack gap="lg">
                {existingProjectQuery.isError && (
                    <Alert color="red" icon={<IconInfoCircle size={18} />}>
                        <Group justify="space-between" align="center" wrap="nowrap">
                            <Text size="sm">{t('research.profile.loadProjectFailed', 'Could not load the linked project. To avoid creating a duplicate, generating ICPs is disabled until this loads.')}</Text>
                            <Button size="xs" variant="light" color="red" onClick={() => existingProjectQuery.refetch()}>
                                {t('common.retry', 'Retry')}
                            </Button>
                        </Group>
                    </Alert>
                )}
                <Paper withBorder radius="md" p="lg">
                    <Stack gap="sm">
                        <TextInput
                            label={t('research.profile.website', 'Website')}
                            placeholder="https://…"
                            value={website}
                            disabled={projectStillLoading}
                            onChange={(e) => setWebsite(e.currentTarget.value)}
                        />
                        <Textarea
                            label={t('research.profile.whatTheyDo', 'What does your company do?')}
                            autosize minRows={2}
                            value={whatTheyDo}
                            disabled={projectStillLoading}
                            onChange={(e) => setWhatTheyDo(e.currentTarget.value)}
                        />
                        {/* AI rewrite for the free-text summary. Gated on a saved projectId — the
                            route reads the row by id; the applied draft flows into local state and
                            the Save/Generate flow persists it (the button never PATCHes). */}
                        {projectId && (
                            <Group justify="flex-end" mt={-8}>
                                <AiReviseButton
                                    entity="project"
                                    id={projectId}
                                    field="what_they_do"
                                    currentValue={whatTheyDo}
                                    onApply={(d) => setWhatTheyDo(d)}
                                />
                            </Group>
                        )}
                        <TagsInput
                            label={t('research.profile.products', 'Products / services')}
                            value={products}
                            disabled={projectStillLoading}
                            onChange={setProducts}
                        />
                        <TagsInput
                            label={t('research.profile.targetMarkets', 'Target markets (countries)')}
                            value={targetMarkets}
                            disabled={projectStillLoading}
                            onChange={setTargetMarkets}
                        />
                        <TagsInput
                            label={t('research.profile.exclusions', 'Exclude (who is NOT a buyer)')}
                            value={exclusions}
                            disabled={projectStillLoading}
                            onChange={setExclusions}
                        />

                        <Divider label={t('research.profile.moreDetails', 'More about your company')} labelPosition="left" />

                        <TextInput
                            label={t('research.profile.moq', 'Minimum order quantity (MOQ)')}
                            value={moq}
                            disabled={projectStillLoading}
                            onChange={(e) => setMoq(e.currentTarget.value)}
                        />
                        <TextInput
                            label={t('research.profile.leadTime', 'Lead / delivery time')}
                            value={leadTime}
                            disabled={projectStillLoading}
                            onChange={(e) => setLeadTime(e.currentTarget.value)}
                        />
                        <TextInput
                            label={t('research.profile.capacity', 'Production capacity')}
                            value={capacity}
                            disabled={projectStillLoading}
                            onChange={(e) => setCapacity(e.currentTarget.value)}
                        />
                        <TagsInput
                            label={t('research.profile.certifications', 'Certifications')}
                            value={certifications}
                            disabled={projectStillLoading}
                            onChange={setCertifications}
                        />
                        <TagsInput
                            label={t('research.profile.references', 'Reference customers')}
                            value={references}
                            disabled={projectStillLoading}
                            onChange={setReferences}
                        />
                        <TagsInput
                            label={t('research.profile.languages', 'Languages spoken')}
                            value={languages}
                            disabled={projectStillLoading}
                            onChange={setLanguages}
                        />
                        <TagsInput
                            label={t('research.profile.lookalikeCustomers', 'Your best current customers')}
                            value={lookalikeCustomers}
                            disabled={projectStillLoading}
                            onChange={setLookalikeCustomers}
                        />
                        <NumberInput
                            label={t('research.profile.scaleTarget', 'Target number of companies')}
                            description={t('research.profile.scaleTargetHint', 'Leave empty to run until fully covered.')}
                            value={scaleTarget}
                            disabled={projectStillLoading}
                            onChange={(v) => setScaleTarget(typeof v === 'number' ? v : '')}
                            min={0}
                            w={220}
                        />

                        <Group justify="space-between" align="flex-end">
                            <NumberInput
                                label={t('research.profile.count', 'How many ICPs')}
                                min={1} max={8} value={count}
                                onChange={(v) => setCount(typeof v === 'number' ? v : 4)}
                                w={160}
                            />
                            <Group gap="sm">
                                {/* Save persists the profile ONLY — no ICP generation, no credit spend. */}
                                <Button
                                    variant="default"
                                    loading={saveProfileMut.isPending}
                                    disabled={!whatTheyDo.trim() || projectStillLoading || generating}
                                    onClick={() => saveProfileMut.mutate()}
                                >
                                    {t('research.profile.save', 'Save')}
                                </Button>
                                <Button
                                    leftSection={<IconSparkles size={18} />}
                                    loading={generating}
                                    disabled={!whatTheyDo.trim() || projectStillLoading || saveProfileMut.isPending}
                                    onClick={() => generateMut.mutate()}
                                >
                                    {projectId ? t('research.regenerate', 'Regenerate ICPs') : t('research.generate', 'Generate ICPs')}
                                </Button>
                            </Group>
                        </Group>
                        {projectStillLoading && !existingProjectQuery.isError && (
                            <Group gap="xs">
                                <Loader size="xs" />
                                <Text size="xs" c="dimmed">
                                    {t('research.profile.loadingProject', 'Loading your project…')}
                                </Text>
                            </Group>
                        )}
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
