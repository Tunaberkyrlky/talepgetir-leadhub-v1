/**
 * EnrichmentPanel — decision-maker contact enrichment (Hunter) for MATCH companies.
 *
 * Flow: project → ICP → pick MATCH companies (domain required) → order title buckets
 * (the selection ORDER is the priority) + optional custom keywords + per-company cap →
 * run. Cost is transparent up-front: 1 credit per company that yields contacts, and
 * already-enriched companies re-run FREE (shown with their contact counts). Domain
 * match is STRICT — a mismatch persists nothing and bills nothing (reported in the
 * result toast). Credits surface as COUNTS only (no dollars — product rule).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Alert, Badge, Button, Checkbox, Drawer, Group, Loader, MultiSelect, NumberInput,
    Pagination, Paper, Select, Stack, Table, TagsInput, Text, Tooltip,
} from '@mantine/core';
import { IconInfoCircle, IconUsers, IconUserSearch } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';
import type { ResearchIcp } from './IcpCard';

interface ResearchProject { id: string; name: string }

interface CompanyRow {
    id: string;
    name: string;
    domain: string | null;
    website: string | null;
    country: string | null;
    city: string | null;
    status: string;
}

interface BucketDef { code: string; label: { tr: string; en: string }; keyword_count: number }

interface EnrichStatusRow { company_id: string; contacts_count: number }

interface ContactRow {
    id: string; email: string | null; name: string | null; title: string | null;
    phone: string | null; linkedin: string | null; seniority: string | null;
    department: string | null; confidence: number | null; title_bucket: string | null;
    priority: number | null; domain: string | null; email_type: string | null; source: string;
}

interface EnrichJob {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    progress: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    error: string | null;
}

const JOB_RUNNING = (s?: string) => s === 'queued' || s === 'running';
const PAGE_SIZE = 25;

interface EnrichmentPanelProps {
    /** WP10: pre-scope the panel (wizard step 20 embeds this component pre-scoped to the
     *  calibrated project/ICP), same seed-once contract as CompaniesPanel's own props —
     *  omitted (every existing /research/full call site) keeps behavior byte-identical.
     *  `lockScope` (P2 fix, adversarial review round 2): hides the project/ICP picker so the
     *  customer can't silently enrich a DIFFERENT project's companies than the one the wizard's
     *  scale target/calibration apply to — the config + selection table + run button (step 20's
     *  own intended action) stay exactly as-is. */
    initialProjectId?: string;
    initialIcpId?: string;
    lockScope?: boolean;
}

export default function EnrichmentPanel({ initialProjectId, initialIcpId, lockScope }: EnrichmentPanelProps = {}) {
    const { t, i18n } = useTranslation();
    const qc = useQueryClient();
    const lang = i18n.language?.startsWith('tr') ? 'tr' : 'en';

    const [projectId, setProjectId] = useState<string | null>(null);
    const [icpId, setIcpId] = useState<string | null>(null);
    // Seed from props EXACTLY once (a ref latch — see CompaniesPanel's identical fix for why a
    // plain "seed if null" effect was a bug: it re-seeded on every picker-driven project switch).
    const seededProjectRef = useRef(false);
    useEffect(() => {
        if (initialProjectId && !seededProjectRef.current) {
            seededProjectRef.current = true;
            setProjectId(initialProjectId);
        }
    }, [initialProjectId]);
    const seededIcpRef = useRef(false);
    useEffect(() => {
        if (initialIcpId && !seededIcpRef.current) {
            seededIcpRef.current = true;
            setIcpId(initialIcpId);
        }
    }, [initialIcpId]);
    const [page, setPage] = useState(1);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [buckets, setBuckets] = useState<string[]>([]);
    const [customKeywords, setCustomKeywords] = useState<string[]>([]);
    const [maxContacts, setMaxContacts] = useState<number>(3);
    const [runJobId, setRunJobId] = useState<string | null>(null);
    const [contactsFor, setContactsFor] = useState<CompanyRow | null>(null);

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

    const creditsQuery = useQuery<{ balance: number; available: number; reserved: number }>({
        queryKey: ['research', 'credits'],
        queryFn: async () => (await api.get('/research/harvest/credits')).data,
    });
    const credits = creditsQuery.data;

    const bucketsQuery = useQuery<{ data: BucketDef[] }>({
        queryKey: ['research', 'enrichment', 'buckets'],
        queryFn: async () => (await api.get('/research/enrichment/buckets')).data,
    });
    const bucketDefs = bucketsQuery.data?.data ?? [];

    // MATCH companies only — enrichment targets qualified leads (a domain is required by the
    // engine anyway; domainless rows would only burn selection slots).
    const companiesQuery = useQuery<{ data: CompanyRow[]; pagination: { total: number } }>({
        queryKey: ['research', 'enrich-companies', icpId, page],
        queryFn: async () => {
            const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), status: 'match' });
            if (icpId) params.set('icp_id', icpId);
            return (await api.get(`/research/harvest/companies?${params}`)).data;
        },
        enabled: !!icpId,
    });
    const companies = companiesQuery.data?.data ?? [];
    const total = companiesQuery.data?.pagination.total ?? 0;

    // Which companies are already enriched (FREE re-runs) + contact counts. Covers the
    // visible page AND every selected id from other pages (codex P2: a page-only status
    // would show a stale cost preview for cross-page selections). Server caps at 100 ids.
    const pageIds = useMemo(() => companies.map((c) => c.id), [companies]);
    const statusIds = useMemo(
        () => [...new Set([...pageIds, ...selected])].slice(0, 100),
        [pageIds, selected]
    );
    const statusQuery = useQuery<{ data: EnrichStatusRow[] }>({
        queryKey: ['research', 'enrich-status', statusIds.join(',')],
        queryFn: async () => (await api.get(`/research/enrichment/status?company_ids=${statusIds.join(',')}`)).data,
        enabled: statusIds.length > 0,
    });
    const enrichedById = useMemo(() => {
        const m = new Map<string, number>();
        for (const r of statusQuery.data?.data ?? []) m.set(r.company_id, r.contacts_count);
        return m;
    }, [statusQuery.data]);

    const selectedIds = useMemo(() => [...selected], [selected]);
    const selectedFresh = selectedIds.filter((id) => !enrichedById.has(id));
    const selectedEnriched = selectedIds.length - selectedFresh.length;

    const runMut = useMutation({
        mutationFn: async () => {
            const job = (await api.post('/research/enrichment/run', {
                company_ids: selectedIds,
                title_buckets: buckets,
                ...(customKeywords.length > 0 ? { custom_keywords: customKeywords } : {}),
                max_contacts: maxContacts,
            })).data as EnrichJob;
            setRunJobId(job.id);
            return job;
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const runJobQuery = useQuery<EnrichJob>({
        queryKey: ['research', 'job', runJobId],
        queryFn: async () => (await api.get(`/research/jobs/${runJobId}`)).data,
        enabled: !!runJobId,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 2000 : false),
    });
    const runStatus = runJobQuery.data?.status;
    useEffect(() => {
        if (runStatus === 'succeeded') {
            const r = (runJobQuery.data?.result ?? {}) as Record<string, number | boolean>;
            showSuccess(
                t('research.enrich.done', 'Enrichment finished: {{billed}} companies enriched, {{contacts}} contacts found ({{mismatch}} domain mismatches, {{skipped}} were already enriched)', {
                    billed: r.companies_billed ?? 0,
                    contacts: r.contacts_persisted ?? 0,
                    mismatch: r.domain_mismatches ?? 0,
                    skipped: r.skipped_already_enriched ?? 0,
                })
            );
            qc.invalidateQueries({ queryKey: ['research', 'enrich-status'] });
            qc.invalidateQueries({ queryKey: ['research', 'credits'] });
            setRunJobId(null);
            setSelected(new Set());
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runStatus]);

    const running = runMut.isPending || JOB_RUNNING(runStatus);
    const canRun = selectedIds.length > 0 && !running && (selectedFresh.length === 0 || (credits?.available ?? 0) >= 1);

    const contactsQuery = useQuery<{ data: ContactRow[] }>({
        queryKey: ['research', 'contacts', contactsFor?.id],
        queryFn: async () => (await api.get(`/research/enrichment/contacts?company_id=${contactsFor!.id}`)).data,
        enabled: !!contactsFor,
    });
    const contacts = contactsQuery.data?.data ?? [];

    const bucketLabel = (code: string | null): string => {
        if (!code) return t('research.enrich.unranked', 'Other');
        if (code === 'custom') return t('research.enrich.customBucket', 'Custom');
        const def = bucketDefs.find((b) => b.code === code);
        return def ? def.label[lang] : code;
    };

    const toggle = (id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    return (
        <Stack gap="md">
            {/* Scope + credits (counts only) */}
            <Paper withBorder radius="md" p="md">
                <Group justify="space-between" align="flex-end" wrap="wrap">
                    {lockScope ? (
                        <Text size="sm" fw={600}>{icps.find((i) => i.id === icpId)?.name ?? '—'}</Text>
                    ) : (
                        <Group align="flex-end" gap="sm">
                            <Select
                                label={t('research.companies.project', 'Project')}
                                placeholder={t('research.companies.pickProject', 'Pick a project')}
                                data={projects.map((p) => ({ value: p.id, label: p.name }))}
                                value={projectId}
                                onChange={(v) => { setProjectId(v); setIcpId(null); setPage(1); setSelected(new Set()); }}
                                w={220}
                                searchable
                            />
                            <Select
                                label={t('research.companies.icp', 'ICP')}
                                placeholder={t('research.companies.pickIcp', 'Pick an ICP')}
                                data={icps.map((i) => ({ value: i.id, label: i.name }))}
                                value={icpId}
                                onChange={(v) => { setIcpId(v); setPage(1); setSelected(new Set()); }}
                                w={260}
                                disabled={!projectId}
                                searchable
                            />
                        </Group>
                    )}
                    {credits && (
                        <Badge size="lg" variant="light" color={credits.available > 5 ? 'teal' : credits.available > 0 ? 'yellow' : 'red'}>
                            {t('research.credits.available', 'Available')}: {credits.available}
                        </Badge>
                    )}
                </Group>
            </Paper>

            {/* Enrichment config — bucket ORDER = priority */}
            {icpId && (
                <Paper withBorder radius="md" p="md">
                    <Stack gap="sm">
                        <Group align="flex-end" gap="sm" wrap="wrap">
                            <MultiSelect
                                label={t('research.enrich.buckets', 'Priority titles')}
                                description={t('research.enrich.bucketsHint', 'Selection order = priority. Each bundle carries ready-made keywords in 8 languages (e.g. Purchasing → Einkäufer, procurement, satın alma…).')}
                                placeholder={buckets.length === 0 ? t('research.enrich.bucketsPh', 'e.g. Founder first, then Purchasing') : undefined}
                                data={bucketDefs.map((b) => ({ value: b.code, label: b.label[lang] }))}
                                value={buckets}
                                onChange={setBuckets}
                                w={380}
                                searchable
                            />
                            <TagsInput
                                label={t('research.enrich.custom', 'Custom keywords')}
                                description={t('research.enrich.customHint', 'Your own title words — they outrank every bundle.')}
                                placeholder={t('research.enrich.customPh', 'type + Enter')}
                                value={customKeywords}
                                onChange={setCustomKeywords}
                                maxTags={20}
                                w={280}
                            />
                            <NumberInput
                                label={t('research.enrich.maxContacts', 'Max contacts / company')}
                                value={maxContacts}
                                onChange={(v) => setMaxContacts(typeof v === 'number' ? v : 3)}
                                min={1}
                                max={10}
                                w={180}
                            />
                            <Button
                                leftSection={<IconUserSearch size={16} />}
                                onClick={() => runMut.mutate()}
                                disabled={!canRun}
                                loading={running}
                            >
                                {t('research.enrich.run', 'Find contacts')}
                            </Button>
                        </Group>
                        {buckets.length > 0 && (
                            <Group gap={6}>
                                <Text size="xs" c="dimmed">{t('research.enrich.order', 'Priority order')}:</Text>
                                {buckets.map((b, i) => (
                                    <Tooltip key={b} label={i === 0 ? bucketLabel(b) : t('research.enrich.promoteHint', 'Click to move up')} withArrow>
                                        <Badge
                                            size="sm" variant="light" color="grape"
                                            style={{ cursor: i === 0 ? 'default' : 'pointer' }}
                                            onClick={() => {
                                                if (i === 0) return;
                                                setBuckets((prev) => {
                                                    const next = [...prev];
                                                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                                                    return next;
                                                });
                                            }}
                                        >
                                            {i + 1}. {bucketLabel(b)}
                                        </Badge>
                                    </Tooltip>
                                ))}
                            </Group>
                        )}
                        {/* Cost preview: fresh companies cost up to 1 credit each; enriched re-run free */}
                        <Group gap="xs">
                            <Badge variant="outline" color={selectedFresh.length > 0 ? 'blue' : 'gray'}>
                                {t('research.enrich.costPreview', '{{count}} selected — up to {{cost}} credits', {
                                    count: selectedIds.length, cost: selectedFresh.length,
                                })}
                            </Badge>
                            {selectedEnriched > 0 && (
                                <Badge variant="outline" color="teal">
                                    {t('research.enrich.freeRerun', '{{count}} already enriched (free)', { count: selectedEnriched })}
                                </Badge>
                            )}
                            {selectedFresh.length > 0 && (credits?.available ?? 0) < 1 && (
                                <Text size="sm" c="red">{t('research.harvest.noCredits', 'No lead quota available — top up to run a harvest.')}</Text>
                            )}
                        </Group>
                        {running && (
                            <Group gap="xs">
                                <Loader size="xs" />
                                <Text size="sm" c="dimmed">
                                    {t('research.enrich.running', 'Enrichment running…')}
                                    {runJobQuery.data?.progress?.stage ? ` (${String(runJobQuery.data.progress.stage)})` : ''}
                                </Text>
                            </Group>
                        )}
                        {runStatus === 'failed' && (
                            <Alert color="red" icon={<IconInfoCircle size={16} />}>
                                {t('research.enrich.failed', 'Enrichment failed')}: {runJobQuery.data?.error ?? 'unknown'}
                            </Alert>
                        )}
                    </Stack>
                </Paper>
            )}

            {/* MATCH companies with selection + enriched badges */}
            {icpId && (
                <Paper withBorder radius="md" p="md">
                    <Stack gap="sm">
                        <Group justify="space-between">
                            <Text size="sm" c="dimmed">
                                {t('research.enrich.matchesTotal', '{{count}} MATCH companies', { count: total })}
                            </Text>
                            <Checkbox
                                size="xs"
                                label={t('research.enrich.selectPage', 'Select page')}
                                checked={companies.length > 0 && companies.every((c) => selected.has(c.id))}
                                onChange={(e) => {
                                    const on = e.currentTarget.checked;
                                    setSelected((prev) => {
                                        const next = new Set(prev);
                                        for (const c of companies) { if (on) next.add(c.id); else next.delete(c.id); }
                                        return next;
                                    });
                                }}
                            />
                        </Group>
                        {companiesQuery.isLoading ? (
                            <Group justify="center" py="xl"><Loader /></Group>
                        ) : companies.length === 0 ? (
                            <Text c="dimmed" ta="center" py="xl">
                                {t('research.enrich.empty', 'No MATCH companies yet for this ICP — harvest leads first.')}
                            </Text>
                        ) : (
                            <Table.ScrollContainer minWidth={680}>
                                <Table striped highlightOnHover verticalSpacing="sm">
                                    <Table.Thead>
                                        <Table.Tr>
                                            <Table.Th w={36} />
                                            <Table.Th>{t('research.companies.company', 'Company')}</Table.Th>
                                            <Table.Th>{t('research.enrich.domain', 'Domain')}</Table.Th>
                                            <Table.Th>{t('research.companies.location', 'Location')}</Table.Th>
                                            <Table.Th ta="center">{t('research.enrich.contacts', 'Contacts')}</Table.Th>
                                        </Table.Tr>
                                    </Table.Thead>
                                    <Table.Tbody>
                                        {companies.map((c) => {
                                            const enrichedCount = enrichedById.get(c.id);
                                            return (
                                                <Table.Tr key={c.id}>
                                                    <Table.Td>
                                                        <Checkbox
                                                            size="xs"
                                                            checked={selected.has(c.id)}
                                                            onChange={() => toggle(c.id)}
                                                            disabled={!c.domain}
                                                        />
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <Text fw={600} size="sm">{c.name}</Text>
                                                    </Table.Td>
                                                    <Table.Td>
                                                        {c.domain ? (
                                                            <Text size="xs" c="blue">{c.domain}</Text>
                                                        ) : (
                                                            <Tooltip label={t('research.enrich.noDomainHint', 'No website domain — enrichment needs a strict domain match')}>
                                                                <Badge size="xs" color="gray" variant="light">
                                                                    {t('research.enrich.noDomain', 'no domain')}
                                                                </Badge>
                                                            </Tooltip>
                                                        )}
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <Text size="sm" c="dimmed">{[c.city, c.country].filter(Boolean).join(', ') || '—'}</Text>
                                                    </Table.Td>
                                                    <Table.Td ta="center">
                                                        {enrichedCount != null ? (
                                                            <Button
                                                                size="compact-xs" variant="light" color="teal"
                                                                leftSection={<IconUsers size={14} />}
                                                                onClick={() => setContactsFor(c)}
                                                            >
                                                                {enrichedCount}
                                                            </Button>
                                                        ) : (
                                                            <Text size="xs" c="dimmed">—</Text>
                                                        )}
                                                    </Table.Td>
                                                </Table.Tr>
                                            );
                                        })}
                                    </Table.Tbody>
                                </Table>
                            </Table.ScrollContainer>
                        )}
                        {total > PAGE_SIZE && (
                            <Group justify="center">
                                <Pagination total={Math.ceil(total / PAGE_SIZE)} value={page} onChange={setPage} size="sm" />
                            </Group>
                        )}
                    </Stack>
                </Paper>
            )}

            {!icpId && (
                <Text c="dimmed" size="sm" ta="center" py="lg">
                    {t('research.enrich.pickHint', 'Pick a project and an ICP, then select MATCH companies to find their decision makers.')}
                </Text>
            )}

            {/* Contacts drawer — the domain-match evidence lives here */}
            <Drawer
                opened={!!contactsFor}
                onClose={() => setContactsFor(null)}
                title={contactsFor ? `${contactsFor.name} — ${t('research.enrich.contactsTitle', 'Contacts')}` : ''}
                position="right"
                size="lg"
            >
                {contactsQuery.isLoading ? (
                    <Group justify="center" py="xl"><Loader /></Group>
                ) : contacts.length === 0 ? (
                    <Text c="dimmed" ta="center" py="xl">{t('research.enrich.noContacts', 'No contacts stored for this company.')}</Text>
                ) : (
                    <Stack gap="sm">
                        {contactsFor?.domain && (
                            <Group gap={6}>
                                <Text size="xs" c="dimmed">{t('research.enrich.domainMatch', 'Domain match')}:</Text>
                                <Badge size="sm" variant="light" color="teal">{contactsFor.domain}</Badge>
                            </Group>
                        )}
                        <Table verticalSpacing="xs">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('research.enrich.person', 'Person')}</Table.Th>
                                    <Table.Th>{t('research.enrich.title', 'Title')}</Table.Th>
                                    <Table.Th ta="center">{t('research.enrich.bucket', 'Priority')}</Table.Th>
                                    <Table.Th ta="center">{t('research.enrich.confidence', 'Confidence')}</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {contacts.map((p) => (
                                    <Table.Tr key={p.id}>
                                        <Table.Td>
                                            <Text size="sm" fw={600}>{p.name || '—'}</Text>
                                            {p.email && <Text size="xs" c="blue">{p.email}</Text>}
                                        </Table.Td>
                                        <Table.Td><Text size="sm">{p.title || '—'}</Text></Table.Td>
                                        <Table.Td ta="center">
                                            <Badge size="xs" variant={p.title_bucket ? 'light' : 'outline'} color={p.title_bucket ? 'grape' : 'gray'}>
                                                {bucketLabel(p.title_bucket)}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td ta="center">
                                            <Badge size="xs" variant="light" color={(p.confidence ?? 0) >= 80 ? 'green' : (p.confidence ?? 0) >= 50 ? 'yellow' : 'gray'}>
                                                {p.confidence ?? '—'}
                                            </Badge>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                        <Text size="xs" c="dimmed">
                            {t('research.enrich.crmNote', 'When you send matches to the CRM, these contacts travel with the company automatically.')}
                        </Text>
                    </Stack>
                )}
            </Drawer>
        </Stack>
    );
}
