import { Alert, Badge, Button, Group, Loader, Paper, Stack, Table, Text } from '@mantine/core';
import { IconBrandLinkedin, IconInfoCircle, IconPlus } from '@tabler/icons-react';
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
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                )}
            </Paper>
        </Stack>
    );
}
