import { useState } from 'react';
import {
    Alert, Badge, Button, Group, Loader, Modal, MultiSelect, Paper, Stack, Table, Text, TextInput,
} from '@mantine/core';
import { IconInfoCircle, IconPlus } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';
import LinkedInCampaignDetail from './LinkedInCampaignDetail';
import { CAMPAIGN_STATUS_COLOR, accountLabel, type AccountOption, type LinkedInCampaign } from './linkedinShared';

/** Faz 5 — campaign list + create; selecting a row opens the builder/detail view. */
export default function LinkedInCampaignsPanel() {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [createOpen, setCreateOpen] = useState(false);

    const campaignsQuery = useQuery<{ data: LinkedInCampaign[] }>({
        queryKey: ['linkedin', 'campaigns'],
        queryFn: async () => (await api.get('/linkedin/campaigns')).data,
    });
    const campaigns = campaignsQuery.data?.data ?? [];

    const accountsQuery = useQuery<{ data: AccountOption[] }>({
        queryKey: ['linkedin', 'accounts'],
        queryFn: async () => (await api.get('/linkedin/accounts')).data,
    });
    const accounts = accountsQuery.data?.data ?? [];

    if (selectedId) {
        return (
            <LinkedInCampaignDetail
                campaignId={selectedId}
                accounts={accounts}
                onBack={() => { setSelectedId(null); qc.invalidateQueries({ queryKey: ['linkedin', 'campaigns'] }); }}
            />
        );
    }

    return (
        <Stack gap="md">
            <Paper withBorder radius="md" p="md">
                <Group justify="space-between">
                    <div>
                        <Text fw={600}>{t('research.linkedin.camp.heading', 'Campaigns')}</Text>
                        <Text size="xs" c="dimmed">
                            {t('research.linkedin.camp.sub', 'Invite + message sequences. New campaigns start in dry-run: nothing is sent until you explicitly turn it off.')}
                        </Text>
                    </div>
                    <Button leftSection={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
                        {t('research.linkedin.camp.new', 'New campaign')}
                    </Button>
                </Group>
            </Paper>

            <Paper withBorder radius="md" p="md">
                {campaignsQuery.isLoading ? (
                    <Group justify="center" py="xl"><Loader /></Group>
                ) : campaignsQuery.isError ? (
                    <Alert color="red" icon={<IconInfoCircle size={16} />}>
                        {t('research.linkedin.camp.loadFailed', 'Could not load campaigns')}
                    </Alert>
                ) : campaigns.length === 0 ? (
                    <Text c="dimmed" ta="center" py="xl">{t('research.linkedin.camp.empty', 'No campaigns yet.')}</Text>
                ) : (
                    <Table striped highlightOnHover verticalSpacing="sm">
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>{t('research.linkedin.camp.name', 'Name')}</Table.Th>
                                <Table.Th ta="center">{t('research.linkedin.camp.status', 'Status')}</Table.Th>
                                <Table.Th ta="center">{t('research.linkedin.camp.mode', 'Mode')}</Table.Th>
                                <Table.Th ta="center">{t('research.linkedin.camp.senders', 'Senders')}</Table.Th>
                                <Table.Th>{t('research.linkedin.camp.created', 'Created')}</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {campaigns.map((c) => (
                                <Table.Tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedId(c.id)}>
                                    <Table.Td><Text size="sm" fw={600}>{c.name}</Text></Table.Td>
                                    <Table.Td ta="center">
                                        <Badge color={CAMPAIGN_STATUS_COLOR[c.status] ?? 'gray'}>
                                            {t(`research.linkedin.camp.statusValue.${c.status}`, c.status)}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td ta="center">
                                        <Badge variant="light" color={c.dry_run ? 'blue' : 'red'}>
                                            {c.dry_run
                                                ? t('research.linkedin.camp.dryRun', 'Dry-run')
                                                : t('research.linkedin.camp.live', 'LIVE')}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td ta="center"><Text size="sm">{c.sender_account_ids?.length ?? 0}</Text></Table.Td>
                                    <Table.Td><Text size="sm" c="dimmed">{new Date(c.created_at).toLocaleDateString()}</Text></Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                )}
            </Paper>

            <CreateCampaignModal
                opened={createOpen}
                accounts={accounts}
                onClose={() => setCreateOpen(false)}
                onCreated={(id) => { setCreateOpen(false); setSelectedId(id); }}
            />
        </Stack>
    );
}

function CreateCampaignModal({ opened, accounts, onClose, onCreated }: {
    opened: boolean;
    accounts: AccountOption[];
    onClose: () => void;
    onCreated: (id: string) => void;
}) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const [name, setName] = useState('');
    const [senderIds, setSenderIds] = useState<string[]>([]);

    const createMut = useMutation({
        mutationFn: async () =>
            (await api.post('/linkedin/campaigns', { name: name.trim(), sender_account_ids: senderIds })).data as { data: { id: string } },
        onSuccess: (res) => {
            showSuccess(t('research.linkedin.camp.createdMsg', 'Campaign created (dry-run).'));
            qc.invalidateQueries({ queryKey: ['linkedin', 'campaigns'] });
            setName(''); setSenderIds([]);
            onCreated(res.data.id);
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    return (
        <Modal opened={opened} onClose={onClose} title={t('research.linkedin.camp.newTitle', 'New campaign')}>
            <Stack gap="sm">
                <TextInput
                    label={t('research.linkedin.camp.name', 'Name')}
                    value={name}
                    onChange={(e) => setName(e.currentTarget.value)}
                    placeholder={t('research.linkedin.camp.namePlaceholder', 'e.g. DE machining buyers — Q3')}
                />
                <MultiSelect
                    label={t('research.linkedin.camp.senders', 'Senders')}
                    description={t('research.linkedin.camp.sendersDesc', 'Sends rotate across these accounts.')}
                    data={accounts.map((a) => ({ value: a.id, label: accountLabel(a) }))}
                    value={senderIds}
                    onChange={setSenderIds}
                />
                <Group justify="flex-end">
                    <Button onClick={() => createMut.mutate()} loading={createMut.isPending} disabled={name.trim().length === 0}>
                        {t('research.linkedin.camp.create', 'Create')}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
}
