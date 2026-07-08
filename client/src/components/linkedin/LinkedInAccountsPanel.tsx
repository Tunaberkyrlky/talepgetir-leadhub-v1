import { useState } from 'react';
import {
    Alert, Badge, Button, Code, Group, Loader, Modal, Paper, Stack, Table, Text, TextInput,
} from '@mantine/core';
import { IconBrandLinkedin, IconInfoCircle, IconPlus, IconTestPipe } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';

type LinkedInStatus = 'ACTIVE' | 'NEEDS_REAUTH' | 'CHALLENGED' | 'RESTRICTED' | 'PAUSED';
interface LinkedInAccount {
    id: string;
    name: string | null;
    public_id: string | null;
    status: LinkedInStatus;
    warmup_day: number;
    last_validated_at: string | null;
    created_at: string;
}

const STATUS_COLOR: Record<LinkedInStatus, string> = {
    ACTIVE: 'green', NEEDS_REAUTH: 'orange', CHALLENGED: 'yellow', RESTRICTED: 'red', PAUSED: 'gray',
};

// Poll ONLY for an account captured very recently that hasn't validated yet — bounds
// the poll so a stubbed/never-validated account can't trigger endless 3s refetches
// (critique P2-a; Faz 1's real validate sets last_validated_at and ends the poll).
const RESOLVING_WINDOW_MS = 5 * 60 * 1000;
function isResolving(a: LinkedInAccount): boolean {
    return a.status === 'ACTIVE'
        && !a.last_validated_at
        && Date.now() - new Date(a.created_at).getTime() < RESOLVING_WINDOW_MS;
}

export default function LinkedInAccountsPanel() {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const [dryRunAccount, setDryRunAccount] = useState<LinkedInAccount | null>(null);

    const accountsQuery = useQuery<{ data: LinkedInAccount[] }>({
        queryKey: ['linkedin', 'accounts'],
        queryFn: async () => (await api.get('/linkedin/accounts')).data,
        refetchInterval: (q) => (q.state.data?.data?.some(isResolving) ? 3000 : false),
    });
    const accounts = accountsQuery.data?.data ?? [];

    // Connect: issue a single-use link token + deep link; the extension captures cookies.
    const connectMut = useMutation({
        mutationFn: async () => (await api.post('/linkedin/accounts/link-token', {})).data as { url: string },
        onSuccess: ({ url }) => {
            if (url) window.open(url, '_blank', 'noopener');
            showSuccess(t('research.linkedin.tokenIssued', 'Pairing link opened — capture your session in the extension.'));
            qc.invalidateQueries({ queryKey: ['linkedin', 'accounts'] });
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    return (
        <Stack gap="md">
            <Paper withBorder radius="md" p="md">
                <Group justify="space-between">
                    <Text fw={600}>{t('research.linkedin.heading', 'LinkedIn Accounts')}</Text>
                    <Button leftSection={<IconPlus size={16} />} onClick={() => connectMut.mutate()} loading={connectMut.isPending}>
                        {t('research.linkedin.connect', 'Connect account')}
                    </Button>
                </Group>
            </Paper>

            <Paper withBorder radius="md" p="md">
                {accountsQuery.isLoading ? (
                    <Group justify="center" py="xl"><Loader /></Group>
                ) : accountsQuery.isError ? (
                    <Alert color="red" icon={<IconInfoCircle size={16} />}>
                        {t('research.linkedin.loadFailed', 'Could not load LinkedIn accounts')}
                    </Alert>
                ) : accounts.length === 0 ? (
                    <Text c="dimmed" ta="center" py="xl">
                        {t('research.linkedin.empty', 'No accounts connected yet.')}
                    </Text>
                ) : (
                    <Table striped highlightOnHover verticalSpacing="sm">
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>{t('research.linkedin.account', 'Account')}</Table.Th>
                                <Table.Th ta="center">{t('research.linkedin.status', 'Status')}</Table.Th>
                                <Table.Th ta="right">{t('research.linkedin.actions', 'Actions')}</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {accounts.map((a) => (
                                <Table.Tr key={a.id}>
                                    <Table.Td>
                                        <Group gap={6} wrap="nowrap">
                                            <IconBrandLinkedin size={16} />
                                            <Text size="sm" fw={600}>{a.name ?? a.public_id ?? a.id}</Text>
                                        </Group>
                                    </Table.Td>
                                    <Table.Td ta="center">
                                        <Badge variant="filled" color={STATUS_COLOR[a.status] ?? 'gray'}>
                                            {t(`research.linkedin.statusValue.${a.status}`, a.status)}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td ta="right">
                                        <Button
                                            size="xs" variant="light" leftSection={<IconTestPipe size={14} />}
                                            onClick={() => setDryRunAccount(a)}
                                        >
                                            {t('research.linkedin.testInvite', 'Test invite')}
                                        </Button>
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                )}
            </Paper>

            <DryRunInviteModal account={dryRunAccount} onClose={() => setDryRunAccount(null)} />
        </Stack>
    );
}

interface JobResult {
    dry_run?: boolean;
    account_status?: string;
    noteless?: boolean;
    note_length?: number;
    would_send?: boolean;
    quota?: { current: number; cap: number };
    target?: unknown;
}
interface PollJob {
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    result: JobResult | null;
    error: string | null;
}

/**
 * Dry-run invite preview: enqueue a linkedin:invite with dry_run:true and poll the job.
 * Sends NOTHING — it proves the account → quota → target path end-to-end and shows exactly
 * what a real invite WOULD do (target urn, noteless, remaining daily quota, would_send).
 */
function DryRunInviteModal({ account, onClose }: { account: LinkedInAccount | null; onClose: () => void }) {
    const { t } = useTranslation();
    const [profileUrn, setProfileUrn] = useState('');
    const [jobId, setJobId] = useState<string | null>(null);

    const startMut = useMutation({
        mutationFn: async () => {
            const body = profileUrn.trim().startsWith('urn:li:')
                ? { profile_urn: profileUrn.trim(), dry_run: true }
                : { public_id: profileUrn.trim(), dry_run: true };
            return (await api.post(`/linkedin/accounts/${account!.id}/invite`, body)).data as { id: string };
        },
        onSuccess: (job) => setJobId(job.id),
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const jobQuery = useQuery<PollJob>({
        queryKey: ['research', 'job', jobId],
        queryFn: async () => (await api.get(`/research/jobs/${jobId}`)).data,
        enabled: !!jobId,
        refetchInterval: (q) => {
            const s = q.state.data?.status;
            return s === 'queued' || s === 'running' ? 1500 : false;
        },
    });
    const job = jobQuery.data;
    const preview = job?.status === 'succeeded' ? job.result : null;

    const close = () => { setProfileUrn(''); setJobId(null); onClose(); };

    return (
        <Modal opened={!!account} onClose={close} title={t('research.linkedin.testInviteTitle', 'Dry-run invite preview')} size="lg">
            <Stack gap="sm">
                <Alert color="blue" icon={<IconInfoCircle size={16} />}>
                    {t('research.linkedin.dryRunNote', 'This never sends. It previews exactly what a real connection request would do for this account.')}
                </Alert>
                <TextInput
                    label={t('research.linkedin.profileUrn', 'Profile URN or public id')}
                    placeholder="urn:li:fsd_profile:… or a public id"
                    value={profileUrn}
                    onChange={(e) => setProfileUrn(e.currentTarget.value)}
                />
                <Group justify="flex-end">
                    <Button
                        onClick={() => startMut.mutate()}
                        loading={startMut.isPending || job?.status === 'queued' || job?.status === 'running'}
                        disabled={profileUrn.trim().length < 3}
                        leftSection={<IconTestPipe size={16} />}
                    >
                        {t('research.linkedin.runPreview', 'Run preview')}
                    </Button>
                </Group>

                {(job?.status === 'queued' || job?.status === 'running') && (
                    <Group gap="xs"><Loader size="xs" /><Text size="sm" c="dimmed">{t('research.linkedin.previewing', 'Previewing…')}</Text></Group>
                )}
                {job?.status === 'failed' && (
                    <Alert color="red" icon={<IconInfoCircle size={16} />}>{job.error ?? 'failed'}</Alert>
                )}
                {preview && (
                    <Paper withBorder radius="md" p="md">
                        <Stack gap={6}>
                            <Group gap="xs">
                                <Text size="sm" fw={600}>{t('research.linkedin.wouldSend', 'Would send')}:</Text>
                                <Badge color={preview.would_send ? 'green' : 'orange'}>
                                    {preview.would_send ? t('research.linkedin.yes', 'Yes') : t('research.linkedin.no', 'No')}
                                </Badge>
                            </Group>
                            <Text size="sm">{t('research.linkedin.accountStatusLabel', 'Account status')}: {preview.account_status}</Text>
                            <Text size="sm">
                                {t('research.linkedin.dailyQuota', 'Daily invites')}: {preview.quota?.current ?? 0} / {preview.quota?.cap ?? 0}
                            </Text>
                            <Text size="sm">
                                {preview.noteless
                                    ? t('research.linkedin.noteless', 'Noteless (recommended)')
                                    : `${t('research.linkedin.withNote', 'With note')} (${preview.note_length} ${t('research.linkedin.chars', 'chars')})`}
                            </Text>
                            <Code block>{JSON.stringify(preview.target, null, 2)}</Code>
                        </Stack>
                    </Paper>
                )}
            </Stack>
        </Modal>
    );
}
