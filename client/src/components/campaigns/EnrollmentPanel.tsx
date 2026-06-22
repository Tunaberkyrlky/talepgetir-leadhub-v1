import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Stack, Group, Text, Badge, Button, Table, TextInput, MultiSelect, Paper, Loader, Center, Checkbox,
    Menu, ActionIcon, Modal,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
    IconPlus, IconSearch, IconUsers, IconUserPlus, IconDots, IconPlayerPause, IconPlayerPlay, IconTrash,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';
import type { Enrollment, EnrollLeadPayload } from '../../types/campaign';

const STATUS_COLORS: Record<string, string> = {
    active: 'blue', completed: 'green', replied: 'violet', paused: 'yellow', bounced: 'red', unsubscribed: 'gray',
};

interface Props { campaignId: string; campaignStatus: string; }

interface AudienceContact {
    contact_id: string;
    company_id: string;
    email: string;
    name: string;
    company_name: string;
}

interface FilterOptions {
    stages: string[];
    industries: string[];
    countries: string[];
}

const prettyStage = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

export default function EnrollmentPanel({ campaignId, campaignStatus }: Props) {
    const { t } = useTranslation();
    const qc = useQueryClient();

    // ── Filters ──
    const [search, setSearch] = useState('');
    const [stages, setStages] = useState<string[]>([]);
    const [industries, setIndustries] = useState<string[]>([]);
    const [countries, setCountries] = useState<string[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [toRemove, setToRemove] = useState<Enrollment | null>(null);
    const [debSearch] = useDebouncedValue(search, 350);

    const canEnroll = ['active', 'draft'].includes(campaignStatus);
    const filters = { search: debSearch || undefined, stages, industries, countries };

    // ── Existing enrollments ──
    const { data: enrollments, isLoading } = useQuery<Enrollment[]>({
        queryKey: ['campaign-enrollments', campaignId],
        queryFn: async () => { const r = await api.get(`/campaigns/${campaignId}/enrollments`); return r.data.data; },
    });

    // ── Filter option values ──
    const { data: options } = useQuery<FilterOptions>({
        queryKey: ['filter-options'],
        queryFn: async () => (await api.get('/filter-options')).data,
        enabled: canEnroll,
        staleTime: 5 * 60_000,
    });

    // ── Audience preview (count + first 50) ──
    const { data: preview, isFetching: previewing } = useQuery<{ total: number; contacts: AudienceContact[] }>({
        queryKey: ['campaign-audience', campaignId, debSearch, stages, industries, countries],
        queryFn: async () => (await api.post(`/campaigns/${campaignId}/audience/preview`, filters)).data,
        enabled: canEnroll,
    });

    const matches = preview?.contacts || [];
    const total = preview?.total || 0;

    const afterEnroll = () => {
        qc.invalidateQueries({ queryKey: ['campaign-enrollments', campaignId] });
        qc.invalidateQueries({ queryKey: ['campaigns'] });
        qc.invalidateQueries({ queryKey: ['campaign-audience', campaignId] });
        setSelected(new Set());
    };

    // Seçili alt kümeyi kaydet (manuel enroll ucu, en fazla 200).
    const enrollSelectedMut = useMutation({
        mutationFn: async () => {
            const payload: EnrollLeadPayload[] = matches
                .filter((c) => selected.has(c.contact_id))
                .map((c) => ({ contact_id: c.contact_id, company_id: c.company_id, email: c.email }));
            return (await api.post(`/campaigns/${campaignId}/enroll`, { contacts: payload })).data;
        },
        onSuccess: (d) => { showSuccess(t('campaign.audience.enrolledToast', { count: d.enrolled, defaultValue: '{{count}} enrolled' })); afterEnroll(); },
        onError: (err) => showErrorFromApi(err),
    });

    // Eşleşen tümünü kaydet (sunucu tarafı filtre, 200 limiti yok).
    const enrollAllMut = useMutation({
        mutationFn: async () => (await api.post(`/campaigns/${campaignId}/enroll-filter`, filters)).data,
        onSuccess: (d: { enrolled: number; capped: boolean }) => {
            showSuccess(t('campaign.audience.enrolledToast', { count: d.enrolled, defaultValue: '{{count}} enrolled' }));
            if (d.capped) showSuccess(t('campaign.audience.cappedNote', { max: 2000, defaultValue: 'First {{max}} enrolled.' }));
            afterEnroll();
        },
        onError: (err) => showErrorFromApi(err),
    });

    // ── Tek-lead aksiyonları ──
    const invalidateRows = () => {
        qc.invalidateQueries({ queryKey: ['campaign-enrollments', campaignId] });
        qc.invalidateQueries({ queryKey: ['campaign-stats', campaignId] });
        qc.invalidateQueries({ queryKey: ['campaigns'] });
    };
    const pauseOneMut = useMutation({
        mutationFn: (eid: string) => api.post(`/campaigns/${campaignId}/enrollments/${eid}/pause`),
        onSuccess: () => { showSuccess(t('campaign.audience.rowPaused', 'Contact paused')); invalidateRows(); },
        onError: (err) => showErrorFromApi(err),
    });
    const resumeOneMut = useMutation({
        mutationFn: (eid: string) => api.post(`/campaigns/${campaignId}/enrollments/${eid}/resume`),
        onSuccess: () => { showSuccess(t('campaign.audience.rowResumed', 'Contact resumed')); invalidateRows(); },
        onError: (err) => showErrorFromApi(err),
    });
    const removeOneMut = useMutation({
        mutationFn: (eid: string) => api.delete(`/campaigns/${campaignId}/enrollments/${eid}`),
        onSuccess: () => { showSuccess(t('campaign.audience.rowRemoved', 'Contact removed')); invalidateRows(); setToRemove(null); },
        onError: (err) => showErrorFromApi(err),
    });

    const fmtNext = (iso: string | null) => {
        if (!iso) return '—';
        return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    };

    const allPageSelected = matches.length > 0 && matches.every((c) => selected.has(c.contact_id));
    const toggleAllPage = () => setSelected((p) => {
        const n = new Set(p);
        if (allPageSelected) matches.forEach((c) => n.delete(c.contact_id));
        else matches.forEach((c) => n.add(c.contact_id));
        return n;
    });

    return (
        <Stack gap="md">
            <Group gap="xs">
                <IconUsers size={18} color="var(--mantine-color-violet-6)" />
                <Text size="sm" fw={600}>{t('campaign.editor.tabAudience', 'Audience')}</Text>
                {enrollments && <Badge size="sm" variant="light" color="violet" radius="xl">{enrollments.length}</Badge>}
            </Group>

            {canEnroll && (
                <Paper p="sm" radius="md" withBorder>
                    <Group gap="sm" align="end" grow>
                        <TextInput label={t('campaign.audience.search', 'Search')} placeholder={t('campaign.audience.searchPlaceholder', 'Name or email...')}
                            leftSection={<IconSearch size={14} />} radius="md" size="sm"
                            value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
                        <MultiSelect label={t('campaign.audience.filterStage', 'Stage')} data={(options?.stages || []).map((s) => ({ value: s, label: prettyStage(s) }))}
                            value={stages} onChange={setStages} clearable searchable radius="md" size="sm" />
                        <MultiSelect label={t('campaign.audience.filterIndustry', 'Industry')} data={options?.industries || []}
                            value={industries} onChange={setIndustries} clearable searchable radius="md" size="sm" />
                        <MultiSelect label={t('campaign.audience.filterCountry', 'Country')} data={options?.countries || []}
                            value={countries} onChange={setCountries} clearable searchable radius="md" size="sm" />
                    </Group>

                    <Group justify="space-between" mt="sm">
                        <Group gap="xs">
                            {previewing ? <Loader size="xs" color="violet" />
                                : <Text size="sm" fw={500}>{t('campaign.audience.matchCount', { count: total, defaultValue: '{{count}} contacts match' })}</Text>}
                        </Group>
                        <Group gap="xs">
                            <Button size="xs" variant="light" color="violet" leftSection={<IconPlus size={14} />}
                                disabled={selected.size === 0} loading={enrollSelectedMut.isPending}
                                onClick={() => enrollSelectedMut.mutate()}>
                                {t('campaign.audience.enrollSelected', { count: selected.size, defaultValue: 'Enroll selected ({{count}})' })}
                            </Button>
                            <Button size="xs" color="violet" leftSection={<IconUserPlus size={14} />}
                                disabled={total === 0} loading={enrollAllMut.isPending}
                                onClick={() => enrollAllMut.mutate()}>
                                {t('campaign.audience.enrollAll', { count: total, defaultValue: 'Enroll all ({{count}})' })}
                            </Button>
                        </Group>
                    </Group>

                    {previewing ? <Center py="md"><Loader size="sm" color="violet" /></Center>
                        : matches.length === 0 ? <Text size="sm" c="dimmed" ta="center" py="md">{t('campaign.audience.noMatch', 'No contacts match the filters.')}</Text>
                            : (
                                <Table highlightOnHover mt="xs">
                                    <Table.Thead>
                                        <Table.Tr>
                                            <Table.Th w={40}>
                                                <Checkbox size="xs" checked={allPageSelected}
                                                    indeterminate={selected.size > 0 && !allPageSelected}
                                                    onChange={toggleAllPage} />
                                            </Table.Th>
                                            <Table.Th>{t('campaign.audience.colName', 'Name')}</Table.Th>
                                            <Table.Th>{t('campaign.audience.colEmail', 'Email')}</Table.Th>
                                            <Table.Th>{t('campaign.audience.colCompany', 'Company')}</Table.Th>
                                        </Table.Tr>
                                    </Table.Thead>
                                    <Table.Tbody>
                                        {matches.map((c) => (
                                            <Table.Tr key={c.contact_id}>
                                                <Table.Td><Checkbox size="xs" checked={selected.has(c.contact_id)}
                                                    onChange={() => setSelected((p) => { const n = new Set(p); if (n.has(c.contact_id)) n.delete(c.contact_id); else n.add(c.contact_id); return n; })} /></Table.Td>
                                                <Table.Td><Text size="sm">{c.name || '—'}</Text></Table.Td>
                                                <Table.Td><Text size="xs" c="dimmed">{c.email}</Text></Table.Td>
                                                <Table.Td><Text size="xs" c="dimmed">{c.company_name || '—'}</Text></Table.Td>
                                            </Table.Tr>
                                        ))}
                                    </Table.Tbody>
                                </Table>
                            )}
                    {total > matches.length && (
                        <Text size="xs" c="dimmed" mt={4}>{t('campaign.audience.showingNote', { shown: matches.length, total, defaultValue: 'Showing {{shown}} of {{total}}. Use "Enroll all" for the rest.' })}</Text>
                    )}
                </Paper>
            )}

            <div>
                <Text size="xs" fw={600} c="dimmed" mb="xs">{t('campaign.audience.currentTitle', 'Enrolled contacts')}</Text>
                {isLoading ? <Center py="md"><Loader size="sm" color="violet" /></Center> :
                    enrollments && enrollments.length > 0 ? (
                        <Table striped highlightOnHover>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('campaign.audience.colContact', 'Contact')}</Table.Th>
                                    <Table.Th>{t('campaign.audience.colCompany', 'Company')}</Table.Th>
                                    <Table.Th>{t('campaign.audience.colStep', 'Step')}</Table.Th>
                                    <Table.Th>{t('campaign.audience.colNext', 'Next')}</Table.Th>
                                    <Table.Th>{t('campaigns.table.status', 'Status')}</Table.Th>
                                    <Table.Th w={40} />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {enrollments.map((e) => (
                                    <Table.Tr key={e.id}>
                                        <Table.Td><Text size="sm" fw={500}>{e.contact_name}</Text><Text size="xs" c="dimmed">{e.email}</Text></Table.Td>
                                        <Table.Td><Text size="xs">{e.company_name}</Text></Table.Td>
                                        <Table.Td><Text size="xs">{e.current_step_order ? `${t('campaign.audience.colStep', 'Step')} ${e.current_step_order}` : '—'}</Text></Table.Td>
                                        <Table.Td><Text size="xs" c="dimmed">{e.status === 'active' ? fmtNext(e.next_scheduled_at) : '—'}</Text></Table.Td>
                                        <Table.Td><Badge size="xs" variant="light" color={STATUS_COLORS[e.status] || 'gray'}>{e.status}</Badge></Table.Td>
                                        <Table.Td>
                                            <Menu position="bottom-end" withinPortal shadow="md" width={170}>
                                                <Menu.Target>
                                                    <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t('common.actions', 'Actions')}>
                                                        <IconDots size={16} />
                                                    </ActionIcon>
                                                </Menu.Target>
                                                <Menu.Dropdown>
                                                    {e.status === 'active' && (
                                                        <Menu.Item leftSection={<IconPlayerPause size={14} />}
                                                            onClick={() => pauseOneMut.mutate(e.id)}>
                                                            {t('campaign.audience.rowPause', 'Pause')}
                                                        </Menu.Item>
                                                    )}
                                                    {e.status === 'paused' && (
                                                        <Menu.Item leftSection={<IconPlayerPlay size={14} />}
                                                            onClick={() => resumeOneMut.mutate(e.id)}>
                                                            {t('campaign.audience.rowResume', 'Resume')}
                                                        </Menu.Item>
                                                    )}
                                                    <Menu.Item color="red" leftSection={<IconTrash size={14} />}
                                                        onClick={() => setToRemove(e)}>
                                                        {t('campaign.audience.rowRemove', 'Remove')}
                                                    </Menu.Item>
                                                </Menu.Dropdown>
                                            </Menu>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    ) : <Text size="sm" c="dimmed" ta="center" py="md">{t('campaign.audience.noneEnrolled', 'No contacts enrolled yet.')}</Text>
                }
            </div>

            <Modal opened={!!toRemove} onClose={() => setToRemove(null)} centered radius="lg" size="sm"
                title={t('campaign.audience.removeTitle', 'Remove contact')} overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}>
                <Stack gap="md">
                    <Text size="sm">
                        {t('campaign.audience.removeConfirm', {
                            name: toRemove?.contact_name || toRemove?.email || '',
                            defaultValue: '{{name}} will be removed from this campaign and will receive no further emails.',
                        })}
                    </Text>
                    <Group justify="flex-end">
                        <Button variant="default" radius="md" onClick={() => setToRemove(null)}>{t('common.cancel', 'Cancel')}</Button>
                        <Button color="red" radius="md" loading={removeOneMut.isPending}
                            onClick={() => toRemove && removeOneMut.mutate(toRemove.id)}>
                            {t('campaign.audience.rowRemove', 'Remove')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
}
