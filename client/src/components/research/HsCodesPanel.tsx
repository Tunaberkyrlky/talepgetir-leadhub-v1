import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Group, Loader, Paper, Select, Stack, Text, TextInput } from '@mantine/core';
import { IconBarcode } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showError, showErrorFromApi, showSuccess } from '../../lib/notifications';
import HsCodeCandidates, { EditHsCodeButton, type HsCodeCandidateRow } from './HsCodeCandidates';

interface ResearchProject { id: string; name: string }

interface HsMatchJob {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    error: string | null;
}

const JOB_RUNNING = (s?: string) => s === 'queued' || s === 'running';

export default function HsCodesPanel() {
    const { t } = useTranslation();
    const qc = useQueryClient();

    const [projectId, setProjectId] = useState<string | null>(null);
    const [jobId, setJobId] = useState<string | null>(null);
    const [jobProjectId, setJobProjectId] = useState<string | null>(null);
    const [addCode, setAddCode] = useState('');
    const [addDescription, setAddDescription] = useState('');

    const projectsQuery = useQuery<{ data: ResearchProject[] }>({
        queryKey: ['research', 'projects'],
        queryFn: async () => (await api.get('/research/projects')).data,
    });
    const projects = useMemo(() => projectsQuery.data?.data ?? [], [projectsQuery.data]);
    // Same auto-select-when-only-one-project convention as OffersPanel.tsx.
    useEffect(() => {
        if (!projectId && projects.length === 1) setProjectId(projects[0].id);
    }, [projectId, projects]);

    const hsQuery = useQuery<{ data: HsCodeCandidateRow[] }>({
        queryKey: ['research', 'hs', projectId],
        queryFn: async () => (await api.get(`/research/hs?project_id=${projectId}`)).data,
        enabled: !!projectId,
    });
    const rows = hsQuery.data?.data ?? [];
    const candidates = rows.filter((row) => row.status === 'candidate');
    const approved = rows.filter((row) => row.status === 'approved');
    const rejected = rows.filter((row) => row.status === 'rejected');

    const matchMut = useMutation({
        mutationFn: async (pid: string) => (await api.post('/research/hs/match', { project_id: pid })).data as HsMatchJob,
        onSuccess: (job, pid) => {
            setJobId(job.id);
            setJobProjectId(pid);
            showSuccess(t('research.hs.matchStarted', 'HS matching started.'));
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const addMut = useMutation({
        mutationFn: async () =>
            (await api.post('/research/hs', {
                project_id: projectId,
                code: addCode.trim(),
                description: addDescription.trim() || null,
            })).data,
        onSuccess: () => {
            showSuccess(t('research.hs.addToast', 'Code added.'));
            setAddCode('');
            setAddDescription('');
            qc.invalidateQueries({ queryKey: ['research', 'hs', projectId] });
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const jobQuery = useQuery<HsMatchJob>({
        queryKey: ['research', 'job', jobId],
        queryFn: async () => (await api.get(`/research/jobs/${jobId}`)).data,
        enabled: !!jobId,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 2000 : false),
    });
    const jobStatus = jobQuery.data?.status;
    useEffect(() => {
        if (jobStatus === 'succeeded') {
            qc.invalidateQueries({ queryKey: ['research', 'hs', jobProjectId] });
            setJobId(null);
            setJobProjectId(null);
        }
        if (jobStatus === 'failed' || jobStatus === 'canceled') {
            showError(t('research.hs.matchFailed', 'HS matching failed — try again.'));
            setJobId(null);
            setJobProjectId(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jobStatus]);

    const matching = matchMut.isPending || JOB_RUNNING(jobStatus);
    const decided = approved.length > 0 || rejected.length > 0;

    return (
        <Stack gap="md">
            <Paper withBorder radius="md" p="md">
                <Group align="flex-end" gap="sm" wrap="wrap">
                    <Select
                        label={t('research.hs.project', 'Project')}
                        placeholder={t('research.hs.pickProject', 'Pick a project')}
                        data={projects.map((p) => ({ value: p.id, label: p.name }))}
                        value={projectId}
                        onChange={setProjectId}
                        w={220} searchable
                    />
                    <Button
                        leftSection={matching ? <Loader size={14} color="white" /> : <IconBarcode size={16} />}
                        onClick={() => projectId && matchMut.mutate(projectId)}
                        disabled={!projectId || matching}
                    >
                        {matching
                            ? t('research.hs.matching', 'Matching HS codes…')
                            : t('research.hs.runMatch', 'Run HS matching')}
                    </Button>
                </Group>
            </Paper>

            {projectId && (
                <Paper withBorder radius="md" p="md">
                    <Stack gap="sm">
                        <Text fw={600} size="sm">{t('research.hs.addHeading', 'Add a code manually')}</Text>
                        <Group align="flex-end" gap="sm" wrap="wrap">
                            <TextInput
                                label={t('research.hs.code', 'HS code')}
                                placeholder={t('research.hs.codePlaceholder', 'e.g. 847130')}
                                value={addCode}
                                onChange={(e) => setAddCode(e.currentTarget.value)}
                                w={160}
                            />
                            <TextInput
                                label={t('research.hs.description', 'Description')}
                                placeholder={t('research.hs.descriptionPlaceholder', 'What the code covers')}
                                value={addDescription}
                                onChange={(e) => setAddDescription(e.currentTarget.value)}
                                style={{ flex: 1, minWidth: 200 }}
                            />
                            <Button
                                onClick={() => addMut.mutate()}
                                loading={addMut.isPending}
                                disabled={addCode.trim().length === 0}
                            >
                                {t('research.hs.add', 'Add')}
                            </Button>
                        </Group>
                    </Stack>
                </Paper>
            )}

            {!projectId && (
                <Text c="dimmed" size="sm" ta="center" py="lg">
                    {t('research.hs.noProject', 'Pick a project to see its HS codes.')}
                </Text>
            )}
            {projectId && hsQuery.isLoading && <Loader size="sm" />}
            {projectId && !hsQuery.isLoading && rows.length === 0 && (
                <Text c="dimmed" size="sm" ta="center" py="lg">
                    {t('research.hs.empty', 'Nothing left to review.')}
                </Text>
            )}
            {projectId && !hsQuery.isLoading && rows.length > 0 && (
                <HsCodeCandidates candidates={candidates} onChanged={() => hsQuery.refetch()} />
            )}

            {decided && (
                <Stack gap="xs">
                    <Text fw={600} size="sm">{t('research.hs.decidedHeading', 'Already reviewed')}</Text>
                    {[...approved, ...rejected].map((row) => (
                        <Paper key={row.id} withBorder radius="sm" p="xs">
                            <Group gap="sm" wrap="nowrap" justify="space-between">
                                <Group gap="sm" wrap="nowrap">
                                    <Badge color={row.status === 'approved' ? 'teal' : 'red'} variant="light">
                                        {row.status === 'approved'
                                            ? t('research.hs.approved', 'Approved')
                                            : t('research.hs.rejected', 'Rejected')}
                                    </Badge>
                                    <Badge variant="outline" ff="monospace">{row.code}</Badge>
                                    <Text size="sm">{row.description}</Text>
                                </Group>
                                <EditHsCodeButton row={row} onChanged={() => hsQuery.refetch()} />
                            </Group>
                        </Paper>
                    ))}
                </Stack>
            )}
        </Stack>
    );
}
