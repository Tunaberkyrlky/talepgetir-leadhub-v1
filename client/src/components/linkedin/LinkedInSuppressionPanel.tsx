import { useState } from 'react';
import {
    ActionIcon, Alert, Badge, Button, Code, Group, Loader, Paper, Select, Stack, Table, Text, TextInput, Tooltip,
} from '@mantine/core';
import { IconInfoCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';

interface SuppressionRow {
    id: string;
    dedupe_key: string;
    reason: 'connected' | 'opted_out' | 'do_not_contact' | 'replied' | 'bounced' | 'manual';
    created_at: string;
}

const REASON_COLOR: Record<string, string> = {
    opted_out: 'red', replied: 'green', connected: 'teal', bounced: 'orange', do_not_contact: 'gray', manual: 'gray',
};
// Compliance: only operator-added rows are removable; a person's stop signal is permanent.
const REMOVABLE = new Set(['manual', 'do_not_contact']);

/** Normalize operator input to the workspace dedupe key (mirrors server enroll.dedupeKey). */
function toDedupeKey(input: string): string {
    const v = input.trim();
    const urlMatch = v.match(/linkedin\.com\/in\/([^/?#]+)/i);
    if (urlMatch) return `pub:${decodeURIComponent(urlMatch[1]).toLowerCase()}`;
    if (v.toLowerCase().startsWith('urn:li:')) return `urn:${v.toLowerCase()}`;
    if (v.includes(':')) return v; // already a raw key (pub:/urn:/nc:)
    return `pub:${v.toLowerCase()}`;
}

/** Faz 5 — workspace do-not-contact list (§5/§6 opt-out): list + add + remove-manual-only. */
export default function LinkedInSuppressionPanel() {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const [input, setInput] = useState('');
    const [reason, setReason] = useState<string>('do_not_contact');

    const q = useQuery<{ data: SuppressionRow[] }>({
        queryKey: ['linkedin', 'suppression'],
        queryFn: async () => (await api.get('/linkedin/suppression')).data,
    });
    const rows = q.data?.data ?? [];

    const addMut = useMutation({
        mutationFn: async () => (await api.post('/linkedin/suppression', {
            dedupe_key: toDedupeKey(input), reason,
        })).data as { data: { suppressed: boolean; stopped: number } },
        onSuccess: (res) => {
            // Surface how many running sequences were actually stopped: 0 means the key matched no
            // lead (e.g. a name-only lead can't be targeted by this field) — not a silent success.
            const stopped = res?.data?.stopped ?? 0;
            showSuccess(stopped > 0
                ? t('research.linkedin.sup.addedStopped', 'Added to do-not-contact — {{stopped}} active sequence(s) stopped.', { stopped })
                : t('research.linkedin.sup.addedNoMatch', 'Added to do-not-contact (no active sequence matched this identity).'));
            setInput('');
            qc.invalidateQueries({ queryKey: ['linkedin', 'suppression'] });
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const delMut = useMutation({
        mutationFn: async (id: string) => (await api.delete(`/linkedin/suppression/${id}`)).data,
        onSuccess: () => qc.invalidateQueries({ queryKey: ['linkedin', 'suppression'] }),
        onError: (err: unknown) => showErrorFromApi(err),
    });

    return (
        <Stack gap="md">
            <Paper withBorder radius="md" p="md">
                <Text fw={600}>{t('research.linkedin.sup.heading', 'Do-not-contact list')}</Text>
                <Text size="xs" c="dimmed" mb="sm">
                    {t('research.linkedin.sup.sub', 'People here are never enrolled and any running sequence for them is stopped — workspace-wide, for every teammate.')}
                </Text>
                <Group align="flex-end" gap="xs">
                    <TextInput
                        style={{ flex: 1 }}
                        label={t('research.linkedin.sup.person', 'Person')}
                        placeholder={t('research.linkedin.sup.placeholder', 'Profile URL, public id or URN')}
                        value={input}
                        onChange={(e) => setInput(e.currentTarget.value)}
                    />
                    <Select
                        w={190}
                        label={t('research.linkedin.sup.reason', 'Reason')}
                        data={[
                            { value: 'do_not_contact', label: t('research.linkedin.sup.reasonValue.do_not_contact', 'Do not contact') },
                            { value: 'opted_out', label: t('research.linkedin.sup.reasonValue.opted_out', 'Opted out') },
                            { value: 'manual', label: t('research.linkedin.sup.reasonValue.manual', 'Manual') },
                        ]}
                        value={reason}
                        onChange={(v) => setReason(v ?? 'do_not_contact')}
                        allowDeselect={false}
                    />
                    <Button leftSection={<IconPlus size={16} />} onClick={() => addMut.mutate()}
                        loading={addMut.isPending} disabled={input.trim().length === 0}>
                        {t('research.linkedin.sup.add', 'Add')}
                    </Button>
                </Group>
            </Paper>

            <Paper withBorder radius="md" p="md">
                {q.isLoading ? (
                    <Group justify="center" py="xl"><Loader /></Group>
                ) : q.isError ? (
                    <Alert color="red" icon={<IconInfoCircle size={16} />}>
                        {t('research.linkedin.sup.loadFailed', 'Could not load the list')}
                    </Alert>
                ) : rows.length === 0 ? (
                    <Text c="dimmed" ta="center" py="xl">{t('research.linkedin.sup.empty', 'The list is empty.')}</Text>
                ) : (
                    <Table striped highlightOnHover verticalSpacing="xs">
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>{t('research.linkedin.sup.identity', 'Identity')}</Table.Th>
                                <Table.Th ta="center">{t('research.linkedin.sup.reason', 'Reason')}</Table.Th>
                                <Table.Th>{t('research.linkedin.sup.added2', 'Added')}</Table.Th>
                                <Table.Th ta="right">{t('research.linkedin.actions', 'Actions')}</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {rows.map((r) => (
                                <Table.Tr key={r.id}>
                                    <Table.Td><Code>{r.dedupe_key}</Code></Table.Td>
                                    <Table.Td ta="center">
                                        <Badge size="sm" variant="light" color={REASON_COLOR[r.reason] ?? 'gray'}>
                                            {t(`research.linkedin.sup.reasonValue.${r.reason}`, r.reason)}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td><Text size="sm" c="dimmed">{new Date(r.created_at).toLocaleDateString()}</Text></Table.Td>
                                    <Table.Td ta="right">
                                        {REMOVABLE.has(r.reason) ? (
                                            <ActionIcon variant="subtle" color="red" onClick={() => delMut.mutate(r.id)} loading={delMut.isPending}>
                                                <IconTrash size={16} />
                                            </ActionIcon>
                                        ) : (
                                            <Tooltip label={t('research.linkedin.sup.permanent', 'Permanent — a person\'s stop signal cannot be removed')}>
                                                <Text size="xs" c="dimmed">{t('research.linkedin.sup.locked', 'locked')}</Text>
                                            </Tooltip>
                                        )}
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
