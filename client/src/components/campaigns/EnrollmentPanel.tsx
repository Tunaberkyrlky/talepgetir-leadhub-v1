import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Stack, Group, Text, Badge, Button, Table, TextInput, Paper, Loader, Center, Checkbox,
} from '@mantine/core';
import { IconPlus, IconSearch, IconUsers } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';
import type { Enrollment, EnrollLeadPayload } from '../../types/campaign';

const STATUS_COLORS: Record<string, string> = {
    active: 'blue', completed: 'green', replied: 'violet', paused: 'yellow', bounced: 'red', unsubscribed: 'gray',
};

interface Props { campaignId: string; campaignStatus: string; }

export default function EnrollmentPanel({ campaignId, campaignStatus }: Props) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const [search, setSearch] = useState('');
    const [selected, setSelected] = useState<Set<string>>(new Set());

    const { data: enrollments, isLoading } = useQuery<Enrollment[]>({
        queryKey: ['campaign-enrollments', campaignId],
        queryFn: async () => { const r = await api.get(`/campaigns/${campaignId}/enrollments`); return r.data.data; },
    });

    const { data: results, isLoading: searching } = useQuery({
        queryKey: ['contacts-search-enroll', search],
        queryFn: async () => {
            const r = await api.get('/contacts', { params: { search, limit: 20, page: 1 } });
            // API returns companies as a join: { companies: { id, name, stage } }
            return (r.data.data as any[]).map((c) => ({
                id: c.id as string,
                first_name: c.first_name as string,
                last_name: c.last_name as string | null,
                email: c.email as string | null,
                company_id: (c.companies?.id || c.company_id || '') as string,
                company_name: (c.companies?.name || '') as string,
            }));
        },
        enabled: search.length >= 2,
    });

    const enrollMut = useMutation({
        mutationFn: async (contacts: EnrollLeadPayload[]) => {
            const r = await api.post(`/campaigns/${campaignId}/enroll`, { contacts }); return r.data;
        },
        onSuccess: (d) => {
            showSuccess(`${d.enrolled} contact(s) enrolled`);
            qc.invalidateQueries({ queryKey: ['campaign-enrollments', campaignId] });
            qc.invalidateQueries({ queryKey: ['campaigns'] });
            setSelected(new Set()); setSearch('');
        },
        onError: (err) => showErrorFromApi(err),
    });

    const handleEnroll = () => {
        if (!results) return;
        const payload: EnrollLeadPayload[] = results
            .filter((c) => selected.has(c.id) && c.email)
            .map((c) => ({ contact_id: c.id, company_id: c.company_id, email: c.email! }));
        if (payload.length) enrollMut.mutate(payload);
    };

    const canEnroll = ['active', 'draft'].includes(campaignStatus);

    return (
        <Stack gap="md">
            <Group gap="xs">
                <IconUsers size={18} color="var(--mantine-color-violet-6)" />
                <Text size="sm" fw={600}>{t('campaign.enrollments', 'Enrollments')}</Text>
                {enrollments && <Badge size="sm" variant="light" color="violet" circle>{enrollments.length}</Badge>}
            </Group>

            {canEnroll && (
                <Paper p="sm" radius="md" withBorder>
                    <TextInput placeholder={t('campaign.searchContacts', 'Search contacts (min 2 chars)...')}
                        leftSection={<IconSearch size={14} />} radius="md" size="sm"
                        value={search} onChange={(e) => setSearch(e.currentTarget.value)}
                    />
                    {searching && <Center py="xs"><Loader size="xs" color="violet" /></Center>}
                    {results && results.length > 0 && (
                        <>
                            <Table highlightOnHover mt="xs">
                                <Table.Thead>
                                    <Table.Tr><Table.Th w={40} /><Table.Th>Name</Table.Th><Table.Th>Email</Table.Th><Table.Th>Company</Table.Th></Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    {results.map((c) => (
                                        <Table.Tr key={c.id} style={{ opacity: c.email ? 1 : 0.5 }}>
                                            <Table.Td><Checkbox size="xs" checked={selected.has(c.id)}
                                                onChange={() => setSelected((p) => { const n = new Set(p); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })}
                                                disabled={!c.email} /></Table.Td>
                                            <Table.Td>{c.first_name} {c.last_name || ''}</Table.Td>
                                            <Table.Td><Text size="xs" c={c.email ? undefined : 'red'}>{c.email || 'No email'}</Text></Table.Td>
                                            <Table.Td><Text size="xs" c="dimmed">{c.company_name || '—'}</Text></Table.Td>
                                        </Table.Tr>
                                    ))}
                                </Table.Tbody>
                            </Table>
                            <Group justify="flex-end" mt="xs">
                                <Button size="xs" color="violet" leftSection={<IconPlus size={14} />}
                                    onClick={handleEnroll} loading={enrollMut.isPending} disabled={selected.size === 0}
                                >Enroll {selected.size}</Button>
                            </Group>
                        </>
                    )}
                </Paper>
            )}

            {isLoading ? <Center py="md"><Loader size="sm" color="violet" /></Center> :
                enrollments && enrollments.length > 0 ? (
                    <Table striped highlightOnHover>
                        <Table.Thead>
                            <Table.Tr><Table.Th>Contact</Table.Th><Table.Th>Company</Table.Th><Table.Th>Step</Table.Th><Table.Th>Status</Table.Th></Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {enrollments.map((e) => (
                                <Table.Tr key={e.id}>
                                    <Table.Td><Text size="sm" fw={500}>{e.contact_name}</Text><Text size="xs" c="dimmed">{e.email}</Text></Table.Td>
                                    <Table.Td><Text size="xs">{e.company_name}</Text></Table.Td>
                                    <Table.Td><Text size="xs">{e.current_step_order ? `Step ${e.current_step_order}` : '—'}</Text></Table.Td>
                                    <Table.Td><Badge size="xs" variant="light" color={STATUS_COLORS[e.status] || 'gray'}>{e.status}</Badge></Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                ) : <Text size="sm" c="dimmed" ta="center" py="md">No contacts enrolled yet.</Text>
            }
        </Stack>
    );
}
