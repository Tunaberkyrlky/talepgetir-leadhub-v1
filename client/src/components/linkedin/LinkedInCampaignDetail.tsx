import { useEffect, useRef, useState } from 'react';
import {
    ActionIcon, Alert, Badge, Button, Group, Loader, Modal, MultiSelect, NumberInput, Paper,
    Select, Stack, Switch, Table, Text, Textarea,
} from '@mantine/core';
import {
    IconArrowDown, IconArrowLeft, IconArrowUp, IconArchive, IconInfoCircle, IconPlayerPause,
    IconPlayerPlay, IconPlus, IconTrash, IconUserPlus,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';
import { CAMPAIGN_STATUS_COLOR, accountLabel, parseLeadLine, type AccountOption, type LinkedInCampaign } from './linkedinShared';

type StepType = 'invite' | 'message' | 'wait';
interface StepDraft { type: StepType; wait_days: number; template: string }

interface CampaignDetailResponse {
    campaign: LinkedInCampaign;
    steps: Array<{ type: StepType; wait_days: number; template: string | null }>;
    enrollment_counts: Record<string, number>;
}

interface EnrollmentLead {
    first_name: string | null; last_name: string | null; company: string | null;
    title: string | null; public_id: string | null; profile_urn: string | null;
}
interface EnrollmentRow {
    id: string; state: string; current_step: number; next_action_at: string;
    last_error: string | null; updated_at: string;
    linkedin_leads: EnrollmentLead;
}

const ENROLLMENT_STATES = ['pending', 'invited', 'accepted', 'messaged', 'replied', 'stopped', 'failed', 'completed'] as const;
const STATE_COLOR: Record<string, string> = {
    pending: 'gray', invited: 'blue', accepted: 'teal', messaged: 'indigo',
    replied: 'green', stopped: 'orange', failed: 'red', completed: 'green',
};

function leadName(l: EnrollmentLead): string {
    const name = `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim();
    return name || l.public_id || l.profile_urn || '—';
}

/** Faz 5 — campaign builder + monitor: steps, senders, dry-run gate, enrollments, lead intake. */
export default function LinkedInCampaignDetail({ campaignId, accounts, onBack }: {
    campaignId: string;
    accounts: AccountOption[];
    onBack: () => void;
}) {
    const { t } = useTranslation();
    const qc = useQueryClient();

    const detailQuery = useQuery<CampaignDetailResponse>({
        queryKey: ['linkedin', 'campaign', campaignId],
        queryFn: async () => (await api.get(`/linkedin/campaigns/${campaignId}`)).data,
    });
    const campaign = detailQuery.data?.campaign;
    const counts = detailQuery.data?.enrollment_counts ?? {};

    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ['linkedin', 'campaign', campaignId] });
        qc.invalidateQueries({ queryKey: ['linkedin', 'campaigns'] });
    };

    // ── Steps editor (local draft; PUT replaces the whole ordered list) ──────────
    const [steps, setSteps] = useState<StepDraft[]>([]);
    const [stepsDirty, setStepsDirty] = useState(false);
    // Monotonic edit counter: a keystroke during an in-flight save advances it, so onSuccess
    // only clears dirty (letting the server resync) when NO edit happened since the save started —
    // otherwise the just-typed edits would be silently reverted by the resync effect (review P3).
    const editSeq = useRef(0);
    useEffect(() => {
        if (detailQuery.data && !stepsDirty) {
            setSteps(detailQuery.data.steps.map((s) => ({
                type: s.type, wait_days: Number(s.wait_days) || 0, template: s.template ?? '',
            })));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [detailQuery.data]);

    const mutateSteps = (next: StepDraft[]) => { setSteps(next); setStepsDirty(true); editSeq.current += 1; };

    const saveStepsMut = useMutation({
        mutationFn: async (seq: number) => {
            const res = (await api.put(`/linkedin/campaigns/${campaignId}/steps`, {
                steps: steps.map((s) => ({
                    type: s.type,
                    wait_days: s.wait_days,
                    template: s.type === 'wait' ? null : (s.template.trim() || null),
                })),
            })).data;
            return { res, seq };
        },
        onSuccess: ({ seq }) => {
            // Only mark clean + allow resync if the user didn't type more during the request.
            if (editSeq.current === seq) setStepsDirty(false);
            showSuccess(t('research.linkedin.camp.stepsSaved', 'Steps saved.'));
            invalidate();
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    // ── Campaign-level mutations ─────────────────────────────────────────────────
    // Optimistic sender draft: the MultiSelect is edited faster than the PATCH round-trips, so a
    // second click must compute from the just-picked set, not the stale server value (review P2).
    const [senderDraft, setSenderDraft] = useState<string[] | null>(null);
    const patchMut = useMutation({
        mutationFn: async (patch: Record<string, unknown>) =>
            (await api.patch(`/linkedin/campaigns/${campaignId}`, patch)).data,
        onSuccess: () => invalidate(),
        onError: (err: unknown) => { setSenderDraft(null); showErrorFromApi(err); },
    });
    // Once the refetch settles (no patch in flight), drop the draft so server truth wins.
    useEffect(() => {
        if (!patchMut.isPending) setSenderDraft(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [detailQuery.data]);
    const actionMut = useMutation({
        mutationFn: async (action: 'activate' | 'pause' | 'archive') =>
            (await api.post(`/linkedin/campaigns/${campaignId}/${action}`)).data,
        onSuccess: () => invalidate(),
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const [confirmLive, setConfirmLive] = useState(false);
    const [addLeadsOpen, setAddLeadsOpen] = useState(false);

    if (detailQuery.isLoading) return <Group justify="center" py="xl"><Loader /></Group>;
    if (detailQuery.isError || !campaign) {
        return (
            <Stack gap="md">
                <Button variant="subtle" leftSection={<IconArrowLeft size={16} />} onClick={onBack} w="fit-content">
                    {t('research.linkedin.camp.back', 'Back to campaigns')}
                </Button>
                <Alert color="red" icon={<IconInfoCircle size={16} />}>
                    {t('research.linkedin.camp.loadFailed', 'Could not load campaigns')}
                </Alert>
            </Stack>
        );
    }

    return (
        <Stack gap="md">
            {/* ── Header: name, status, mode + lifecycle actions ─────────────────── */}
            <Paper withBorder radius="md" p="md">
                <Group justify="space-between" wrap="wrap">
                    <Group gap="sm">
                        <Button variant="subtle" px={6} onClick={onBack}><IconArrowLeft size={18} /></Button>
                        <div>
                            <Group gap="xs">
                                <Text fw={700}>{campaign.name}</Text>
                                <Badge color={CAMPAIGN_STATUS_COLOR[campaign.status] ?? 'gray'}>
                                    {t(`research.linkedin.camp.statusValue.${campaign.status}`, campaign.status)}
                                </Badge>
                                <Badge variant="light" color={campaign.dry_run ? 'blue' : 'red'}>
                                    {campaign.dry_run ? t('research.linkedin.camp.dryRun', 'Dry-run') : t('research.linkedin.camp.live', 'LIVE')}
                                </Badge>
                            </Group>
                            <Group gap={6} mt={4}>
                                {ENROLLMENT_STATES.filter((s) => counts[s]).map((s) => (
                                    <Badge key={s} size="sm" variant="light" color={STATE_COLOR[s]}>
                                        {t(`research.linkedin.camp.state.${s}`, s)}: {counts[s]}
                                    </Badge>
                                ))}
                            </Group>
                        </div>
                    </Group>
                    <Group gap="xs">
                        {campaign.status !== 'active' && campaign.status !== 'archived' && (
                            <Button size="xs" color="green" leftSection={<IconPlayerPlay size={14} />}
                                onClick={() => actionMut.mutate('activate')} loading={actionMut.isPending}>
                                {t('research.linkedin.camp.activate', 'Activate')}
                            </Button>
                        )}
                        {campaign.status === 'active' && (
                            <Button size="xs" color="yellow" leftSection={<IconPlayerPause size={14} />}
                                onClick={() => actionMut.mutate('pause')} loading={actionMut.isPending}>
                                {t('research.linkedin.camp.pause', 'Pause')}
                            </Button>
                        )}
                        {(campaign.status === 'draft' || campaign.status === 'paused') && (
                            <Button size="xs" variant="light" color="gray" leftSection={<IconArchive size={14} />}
                                onClick={() => actionMut.mutate('archive')} loading={actionMut.isPending}>
                                {t('research.linkedin.camp.archive', 'Archive')}
                            </Button>
                        )}
                    </Group>
                </Group>
            </Paper>

            {/* ── Settings: senders + dry-run gate ────────────────────────────────── */}
            <Paper withBorder radius="md" p="md">
                <Stack gap="sm">
                    <MultiSelect
                        label={t('research.linkedin.camp.senders', 'Senders')}
                        description={t('research.linkedin.camp.sendersDesc', 'Sends rotate across these accounts.')}
                        data={accounts.map((a) => ({ value: a.id, label: accountLabel(a) }))}
                        value={senderDraft ?? campaign.sender_account_ids ?? []}
                        onChange={(ids) => { setSenderDraft(ids); patchMut.mutate({ sender_account_ids: ids }); }}
                        disabled={campaign.status === 'archived'}
                    />
                    <Switch
                        label={t('research.linkedin.camp.liveSwitch', 'Live sending (dry-run off)')}
                        description={t('research.linkedin.camp.liveSwitchDesc', 'While dry-run is on the sequence advances and previews but sends nothing.')}
                        checked={!campaign.dry_run}
                        color="red"
                        disabled={campaign.status === 'archived'}
                        onChange={(e) => {
                            if (e.currentTarget.checked) setConfirmLive(true); // live needs an explicit confirm
                            else patchMut.mutate({ dry_run: true });
                        }}
                    />
                </Stack>
            </Paper>

            {/* ── Steps editor ────────────────────────────────────────────────────── */}
            <Paper withBorder radius="md" p="md">
                <Group justify="space-between" mb="sm">
                    <div>
                        <Text fw={600}>{t('research.linkedin.camp.steps', 'Sequence steps')}</Text>
                        <Text size="xs" c="dimmed">
                            {t('research.linkedin.camp.stepsHint', 'Templates support {first_name} {last_name} {company} {title} variables and {{spintax}} spintax. Invite notes over 300 characters are trimmed.', { spintax: '{{a|b}}' })}
                        </Text>
                    </div>
                    <Group gap="xs">
                        <Button size="xs" variant="light" leftSection={<IconPlus size={14} />}
                            onClick={() => mutateSteps([...steps, { type: steps.length === 0 ? 'invite' : 'message', wait_days: steps.length === 0 ? 0 : 1, template: '' }])}>
                            {t('research.linkedin.camp.addStep', 'Add step')}
                        </Button>
                        <Button size="xs" onClick={() => saveStepsMut.mutate(editSeq.current)} loading={saveStepsMut.isPending} disabled={!stepsDirty}>
                            {t('research.linkedin.camp.saveSteps', 'Save steps')}
                        </Button>
                    </Group>
                </Group>
                {steps.length === 0 ? (
                    <Text c="dimmed" size="sm" ta="center" py="md">{t('research.linkedin.camp.noSteps', 'No steps yet. A typical sequence: invite → message.')}</Text>
                ) : (
                    <Stack gap="xs">
                        {steps.map((s, i) => (
                            <Paper key={i} withBorder radius="sm" p="sm">
                                <Group align="flex-start" wrap="nowrap">
                                    <Text size="sm" fw={700} w={24} ta="center" mt={6}>{i + 1}</Text>
                                    <Select
                                        w={140}
                                        data={[
                                            { value: 'invite', label: t('research.linkedin.camp.stepInvite', 'Invite') },
                                            { value: 'message', label: t('research.linkedin.camp.stepMessage', 'Message') },
                                            { value: 'wait', label: t('research.linkedin.camp.stepWait', 'Wait') },
                                        ]}
                                        value={s.type}
                                        onChange={(v) => { if (v) mutateSteps(steps.map((x, j) => (j === i ? { ...x, type: v as StepType } : x))); }}
                                    />
                                    <NumberInput
                                        w={130}
                                        min={0} max={90}
                                        label={undefined}
                                        placeholder="0"
                                        value={s.wait_days}
                                        onChange={(v) => mutateSteps(steps.map((x, j) => (j === i ? { ...x, wait_days: Number(v) || 0 } : x)))}
                                        suffix={` ${t('research.linkedin.camp.days', 'days')}`}
                                    />
                                    {s.type !== 'wait' && (
                                        <Textarea
                                            style={{ flex: 1 }}
                                            autosize minRows={1} maxRows={6}
                                            placeholder={s.type === 'invite'
                                                ? t('research.linkedin.camp.invitePlaceholder', 'Invite note (optional — noteless invites perform best)')
                                                : t('research.linkedin.camp.messagePlaceholder', 'Message text')}
                                            value={s.template}
                                            onChange={(e) => mutateSteps(steps.map((x, j) => (j === i ? { ...x, template: e.currentTarget.value } : x)))}
                                        />
                                    )}
                                    <Group gap={4} wrap="nowrap" mt={4}>
                                        <ActionIcon variant="subtle" disabled={i === 0}
                                            onClick={() => { const n = [...steps]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; mutateSteps(n); }}>
                                            <IconArrowUp size={16} />
                                        </ActionIcon>
                                        <ActionIcon variant="subtle" disabled={i === steps.length - 1}
                                            onClick={() => { const n = [...steps]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; mutateSteps(n); }}>
                                            <IconArrowDown size={16} />
                                        </ActionIcon>
                                        <ActionIcon variant="subtle" color="red" onClick={() => mutateSteps(steps.filter((_, j) => j !== i))}>
                                            <IconTrash size={16} />
                                        </ActionIcon>
                                    </Group>
                                </Group>
                            </Paper>
                        ))}
                    </Stack>
                )}
            </Paper>

            {/* ── Enrollments ─────────────────────────────────────────────────────── */}
            <EnrollmentsTable campaignId={campaignId} active={campaign.status === 'active'}
                canEnroll={campaign.status !== 'archived'} onAddLeads={() => setAddLeadsOpen(true)} />

            <ConfirmLiveModal
                opened={confirmLive}
                campaignName={campaign.name}
                onClose={() => setConfirmLive(false)}
                onConfirm={() => { patchMut.mutate({ dry_run: false }); setConfirmLive(false); }}
            />
            <AddLeadsModal
                opened={addLeadsOpen}
                campaignId={campaignId}
                onClose={() => setAddLeadsOpen(false)}
                onDone={() => { setAddLeadsOpen(false); invalidate(); qc.invalidateQueries({ queryKey: ['linkedin', 'enrollments', campaignId] }); }}
            />
        </Stack>
    );
}

function EnrollmentsTable({ campaignId, active, canEnroll, onAddLeads }: {
    campaignId: string; active: boolean; canEnroll: boolean; onAddLeads: () => void;
}) {
    const { t } = useTranslation();
    const [state, setState] = useState<string | null>(null);
    const [offset, setOffset] = useState(0);
    const limit = 25;

    const q = useQuery<{ data: EnrollmentRow[]; total: number }>({
        queryKey: ['linkedin', 'enrollments', campaignId, state, offset],
        queryFn: async () => (await api.get(`/linkedin/campaigns/${campaignId}/enrollments`, {
            params: { limit, offset, ...(state ? { state } : {}) },
        })).data,
        refetchInterval: active ? 30_000 : false,
    });
    const rows = q.data?.data ?? [];
    const total = q.data?.total ?? 0;
    // If the filtered total shrank below the current page (tick advanced rows), snap back to a
    // valid page instead of stranding the user on an empty page with no controls (review P3).
    useEffect(() => {
        if (q.data && offset > 0 && offset >= total) setOffset(Math.max(0, Math.floor((total - 1) / limit)) * limit);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [q.data]);

    return (
        <Paper withBorder radius="md" p="md">
            <Group justify="space-between" mb="sm">
                <Text fw={600}>{t('research.linkedin.camp.enrollments', 'Enrollments')} ({total})</Text>
                <Group gap="xs">
                    <Select
                        size="xs" w={160} clearable
                        placeholder={t('research.linkedin.camp.stateFilter', 'All states')}
                        data={ENROLLMENT_STATES.map((s) => ({ value: s, label: t(`research.linkedin.camp.state.${s}`, s) }))}
                        value={state}
                        onChange={(v) => { setState(v); setOffset(0); }}
                    />
                    <Button size="xs" leftSection={<IconUserPlus size={14} />} onClick={onAddLeads} disabled={!canEnroll}>
                        {t('research.linkedin.camp.addLeads', 'Add leads')}
                    </Button>
                </Group>
            </Group>
            {q.isLoading ? (
                <Group justify="center" py="lg"><Loader size="sm" /></Group>
            ) : total === 0 ? (
                <Text c="dimmed" size="sm" ta="center" py="md">{t('research.linkedin.camp.noEnrollments', 'No enrollments yet — add leads to start.')}</Text>
            ) : rows.length === 0 ? (
                // total>0 but this page is empty (filter/tick shrank it) — keep controls, don't claim empty.
                <Stack gap="sm" py="md" align="center">
                    <Text c="dimmed" size="sm">{t('research.linkedin.camp.pageEmpty', 'No rows on this page.')}</Text>
                    <Button size="xs" variant="light" onClick={() => setOffset(0)}>{t('research.linkedin.camp.firstPage', 'First page')}</Button>
                </Stack>
            ) : (
                <>
                    <Table striped highlightOnHover verticalSpacing="xs">
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>{t('research.linkedin.camp.lead', 'Lead')}</Table.Th>
                                <Table.Th>{t('research.linkedin.camp.company', 'Company')}</Table.Th>
                                <Table.Th ta="center">{t('research.linkedin.camp.stateCol', 'State')}</Table.Th>
                                <Table.Th ta="center">{t('research.linkedin.camp.step', 'Step')}</Table.Th>
                                <Table.Th>{t('research.linkedin.camp.nextAction', 'Next action')}</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {rows.map((e) => (
                                <Table.Tr key={e.id}>
                                    <Table.Td>
                                        <Text size="sm" fw={500}>{leadName(e.linkedin_leads)}</Text>
                                        {e.last_error && <Text size="xs" c="red">{e.last_error}</Text>}
                                    </Table.Td>
                                    <Table.Td><Text size="sm" c="dimmed">{e.linkedin_leads.company ?? '—'}</Text></Table.Td>
                                    <Table.Td ta="center">
                                        <Badge size="sm" variant="light" color={STATE_COLOR[e.state] ?? 'gray'}>
                                            {t(`research.linkedin.camp.state.${e.state}`, e.state)}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td ta="center"><Text size="sm">{e.current_step}</Text></Table.Td>
                                    <Table.Td><Text size="sm" c="dimmed">{new Date(e.next_action_at).toLocaleString()}</Text></Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                    {total > limit && (
                        <Group justify="flex-end" mt="sm" gap="xs">
                            <Button size="xs" variant="light" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
                                {t('research.linkedin.camp.prev', 'Previous')}
                            </Button>
                            <Text size="xs" c="dimmed">{offset + 1}–{Math.min(offset + limit, total)} / {total}</Text>
                            <Button size="xs" variant="light" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>
                                {t('research.linkedin.camp.next', 'Next')}
                            </Button>
                        </Group>
                    )}
                </>
            )}
        </Paper>
    );
}

function ConfirmLiveModal({ opened, campaignName, onClose, onConfirm }: {
    opened: boolean; campaignName: string; onClose: () => void; onConfirm: () => void;
}) {
    const { t } = useTranslation();
    return (
        <Modal opened={opened} onClose={onClose} title={t('research.linkedin.camp.confirmLiveTitle', 'Turn on live sending?')}>
            <Stack gap="sm">
                <Alert color="red" icon={<IconInfoCircle size={16} />}>
                    {/* Render the campaign name as its own node — interpolating it into the i18next
                        string double-escapes &/"/' (escapeValue:true + React) and shows entities. */}
                    <Text size="sm" fw={600} mb={4}>{campaignName}</Text>
                    {t('research.linkedin.camp.confirmLiveBody', 'Real invites and messages will be sent from this campaign’s sender accounts. Daily/weekly caps, warmup and working hours still apply.')}
                </Alert>
                <Group justify="flex-end" gap="xs">
                    <Button variant="default" onClick={onClose}>{t('research.linkedin.camp.cancel', 'Cancel')}</Button>
                    <Button color="red" onClick={onConfirm}>{t('research.linkedin.camp.goLive', 'Go live')}</Button>
                </Group>
            </Stack>
        </Modal>
    );
}

function AddLeadsModal({ opened, campaignId, onClose, onDone }: {
    opened: boolean; campaignId: string; onClose: () => void; onDone: () => void;
}) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [summary, setSummary] = useState<string | null>(null);
    const [invalid, setInvalid] = useState(false);

    const runMut = useMutation({
        mutationFn: async (leads: Array<Record<string, string>>) => {
            const created = (await api.post('/linkedin/leads', { leads: leads.map((l) => ({ ...l, source: 'manual' })) })).data as { data: Array<{ id: string }> };
            const ids = created.data.map((r) => r.id);
            const enrolled = (await api.post(`/linkedin/campaigns/${campaignId}/enroll`, { lead_ids: ids })).data as {
                enrolled: number; total: number; results: Array<{ reason: string }>;
            };
            return enrolled;
        },
        onSuccess: (r) => {
            const reasons = r.results.filter((x) => x.reason !== 'ok');
            const reasonRollup = new Map<string, number>();
            for (const x of reasons) reasonRollup.set(x.reason, (reasonRollup.get(x.reason) ?? 0) + 1);
            const skipped = [...reasonRollup.entries()].map(([k, v]) => `${t(`research.linkedin.camp.reason.${k}`, k)}: ${v}`).join(', ');
            setSummary(t('research.linkedin.camp.enrollSummary', '{{enrolled}}/{{total}} enrolled.', { enrolled: r.enrolled, total: r.total })
                + (skipped ? ` (${skipped})` : ''));
            setText('');
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    // Parse + validate BEFORE the mutation so a paste of only separators shows a translated
    // message instead of the raw internal 'no_leads' code (review P3).
    const run = () => {
        setInvalid(false);
        const leads = text.split('\n').map(parseLeadLine).filter(Boolean) as Array<Record<string, string>>;
        if (leads.length === 0) { setInvalid(true); return; }
        runMut.mutate(leads);
    };

    const close = () => { setText(''); setSummary(null); setInvalid(false); onClose(); if (summary) onDone(); };

    return (
        <Modal opened={opened} onClose={close} title={t('research.linkedin.camp.addLeadsTitle', 'Add leads to campaign')} size="lg">
            <Stack gap="sm">
                <Textarea
                    autosize minRows={6} maxRows={14}
                    placeholder={t('research.linkedin.camp.addLeadsPlaceholder', 'One per line: profile URL, public id or URN — optionally add , First, Last, Company, Title')}
                    value={text}
                    onChange={(e) => setText(e.currentTarget.value)}
                />
                <Text size="xs" c="dimmed">
                    {t('research.linkedin.camp.addLeadsHint', 'Suppressed people and leads already in another active campaign are skipped automatically.')}
                </Text>
                {invalid && <Alert color="orange" icon={<IconInfoCircle size={16} />}>{t('research.linkedin.camp.noValidLeads', 'No valid leads found — add a profile URL, public id or URN on each line.')}</Alert>}
                {summary && <Alert color="green" icon={<IconInfoCircle size={16} />}>{summary}</Alert>}
                <Group justify="flex-end">
                    <Button onClick={run} loading={runMut.isPending} disabled={text.trim().length === 0}>
                        {t('research.linkedin.camp.enrollNow', 'Import + enroll')}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
}
