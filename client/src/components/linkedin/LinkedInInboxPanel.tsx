import { Alert, Anchor, Badge, Group, Loader, Paper, Stack, Table, Text } from '@mantine/core';
import { IconInfoCircle, IconExternalLink } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';

interface InboxLead {
    first_name: string | null; last_name: string | null; company: string | null;
    title: string | null; public_id: string | null; profile_urn: string | null;
}
interface InboxRow {
    id: string; state: string; updated_at: string;
    linkedin_leads: InboxLead;
    linkedin_campaigns: { name: string } | null;
    linkedin_accounts: { name: string | null; public_id: string | null } | null;
}

/**
 * Faz 5 — unified inbox v2: everyone who replied, newest first. Reply CONTENT is not stored
 * server-side (deliberate PII decision) — each row deep-links to the person on LinkedIn.
 */
export default function LinkedInInboxPanel() {
    const { t } = useTranslation();
    const q = useQuery<{ data: InboxRow[] }>({
        queryKey: ['linkedin', 'inbox'],
        queryFn: async () => (await api.get('/linkedin/inbox')).data,
        refetchInterval: 60_000,
    });
    const rows = q.data?.data ?? [];

    return (
        <Stack gap="md">
            <Paper withBorder radius="md" p="md">
                <Text fw={600}>{t('research.linkedin.inbox.heading', 'Replies')}</Text>
                <Text size="xs" c="dimmed">
                    {t('research.linkedin.inbox.sub', 'A reply stops that person\'s sequence and suppresses them workspace-wide. Open the conversation on LinkedIn to answer.')}
                </Text>
            </Paper>
            <Paper withBorder radius="md" p="md">
                {q.isLoading ? (
                    <Group justify="center" py="xl"><Loader /></Group>
                ) : q.isError ? (
                    <Alert color="red" icon={<IconInfoCircle size={16} />}>
                        {t('research.linkedin.inbox.loadFailed', 'Could not load replies')}
                    </Alert>
                ) : rows.length === 0 ? (
                    <Text c="dimmed" ta="center" py="xl">{t('research.linkedin.inbox.empty', 'No replies yet.')}</Text>
                ) : (
                    <Table striped highlightOnHover verticalSpacing="sm">
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>{t('research.linkedin.inbox.person', 'Person')}</Table.Th>
                                <Table.Th>{t('research.linkedin.inbox.campaign', 'Campaign')}</Table.Th>
                                <Table.Th>{t('research.linkedin.inbox.sender', 'Sender')}</Table.Th>
                                <Table.Th>{t('research.linkedin.inbox.when', 'When')}</Table.Th>
                                <Table.Th ta="right">{t('research.linkedin.inbox.open', 'Open')}</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {rows.map((r) => {
                                const l = r.linkedin_leads;
                                const name = `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || l.public_id || '—';
                                const url = l.public_id ? `https://www.linkedin.com/in/${encodeURIComponent(l.public_id)}/` : null;
                                return (
                                    <Table.Tr key={r.id}>
                                        <Table.Td>
                                            <Text size="sm" fw={600}>{name}</Text>
                                            <Text size="xs" c="dimmed">{[l.title, l.company].filter(Boolean).join(' · ')}</Text>
                                        </Table.Td>
                                        <Table.Td><Text size="sm">{r.linkedin_campaigns?.name ?? '—'}</Text></Table.Td>
                                        <Table.Td>
                                            <Text size="sm" c="dimmed">
                                                {r.linkedin_accounts?.name ?? r.linkedin_accounts?.public_id ?? '—'}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Group gap={6}>
                                                <Badge size="sm" variant="light" color="green">{t('research.linkedin.camp.state.replied', 'replied')}</Badge>
                                                <Text size="xs" c="dimmed">{new Date(r.updated_at).toLocaleString()}</Text>
                                            </Group>
                                        </Table.Td>
                                        <Table.Td ta="right">
                                            {url ? (
                                                <Anchor href={url} target="_blank" rel="noopener noreferrer" size="sm">
                                                    <Group gap={4} justify="flex-end"><IconExternalLink size={14} />LinkedIn</Group>
                                                </Anchor>
                                            ) : <Text size="sm" c="dimmed">—</Text>}
                                        </Table.Td>
                                    </Table.Tr>
                                );
                            })}
                        </Table.Tbody>
                    </Table>
                )}
            </Paper>
        </Stack>
    );
}
