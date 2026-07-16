import { useEffect, useRef, useState } from 'react';
import {
    ActionIcon, Alert, Badge, Button, Divider, Group, Loader, LoadingOverlay, Modal, MultiSelect,
    NumberInput, Paper, SegmentedControl, Select, Stack, Switch, Table, Text, Textarea, TextInput,
    Tooltip,
} from '@mantine/core';
import {
    IconArrowDown, IconArrowLeft, IconArrowUp, IconArchive, IconCirclePlus, IconInfoCircle,
    IconPlayerPause, IconPlayerPlay, IconPlus, IconSparkles, IconTrash, IconUserPlus,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';
import { CAMPAIGN_STATUS_COLOR, accountLabel, parseLeadLine, type AccountOption, type LinkedInCampaign } from './linkedinShared';

type StepType = 'invite' | 'message' | 'wait';
type AiMode = 'off' | 'sections' | 'full';
interface AiSection { key: string; prompt: string }
/** Local draft shape: always fully populated so switching modes preserves the other fields. */
interface AiConfigDraft { mode: AiMode; prompt: string; sections: AiSection[] }
interface StepDraft { type: StepType; wait_days: number; template: string; ai: AiConfigDraft }

/** Wire shape from GET / to PUT — `{}` means off. */
interface AiConfigWire { mode?: AiMode; prompt?: string; sections?: AiSection[] }

interface CampaignDetailResponse {
    campaign: LinkedInCampaign;
    steps: Array<{ type: StepType; wait_days: number; template: string | null; ai_config?: AiConfigWire }>;
    enrollment_counts: Record<string, number>;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,29}$/;
// Server zod limits (campaigns.ts / aiGenerate.ts) — keep in sync so a paste is caught inline.
const FULL_PROMPT_MAX = 4000;
const SECTION_PROMPT_MAX = 2000;
/** Coerce a key TextInput value into the server-accepted charset (lowercase, letter-first, <=30). */
function sanitizeKey(v: string): string {
    return v.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, '').slice(0, 30);
}
/** {} / missing / unknown mode → off; keeps prompt+sections so toggling back restores them. */
function normalizeAi(raw?: AiConfigWire): AiConfigDraft {
    return {
        mode: raw?.mode === 'sections' || raw?.mode === 'full' ? raw.mode : 'off',
        prompt: raw?.prompt ?? '',
        sections: (raw?.sections ?? []).map((s) => ({ key: s.key ?? '', prompt: s.prompt ?? '' })),
    };
}
/** Draft → PUT/preview payload: off omits everything; sections drops empty rows; full sends the prompt. */
function serializeAi(ai: AiConfigDraft): AiConfigWire {
    if (ai.mode === 'sections') return { mode: 'sections', sections: ai.sections.filter((s) => s.key && s.prompt.trim()) };
    if (ai.mode === 'full') return { mode: 'full', prompt: ai.prompt };
    return { mode: 'off' };
}

/** Per-step validation mirroring the server's save/preview reject conditions (invalid ⇒ block). */
interface StepValidation {
    fullPromptEmpty: boolean;
    fullPromptTooLong: boolean;
    sectionsNoValid: boolean;
    dupKeys: boolean;
    templateMalformed: boolean;
    templateMissingKeys: string[];
    sectionErrors: Record<number, 'key' | 'prompt' | 'promptLong'>;
    invalid: boolean;
}
/** Scan a template for {ai:…} tokens: any '{ai:' that isn't a well-formed token is malformed. */
function scanAiTokens(template: string): { malformed: boolean; keys: string[] } {
    const keys: string[] = [];
    let malformed = false;
    const scan = /\{ai:/g;
    const valid = /^\{ai:([a-z][a-z0-9_]{0,29})\}/;
    let m: RegExpExecArray | null;
    while ((m = scan.exec(template)) !== null) {
        const vm = template.slice(m.index).match(valid);
        if (vm) keys.push(vm[1]);
        else malformed = true;
    }
    return { malformed, keys };
}
/** Compute why a step's draft would be rejected, so we can block save/preview and show it inline. */
function validateStep(s: StepDraft): StepValidation {
    const v: StepValidation = {
        fullPromptEmpty: false, fullPromptTooLong: false, sectionsNoValid: false, dupKeys: false,
        templateMalformed: false, templateMissingKeys: [], sectionErrors: {}, invalid: false,
    };
    if (s.type === 'wait') return v;
    const ai = s.ai;

    if (ai.mode === 'full') {
        v.fullPromptEmpty = ai.prompt.trim().length === 0;
        // Mirrors the server zod limit (4000) so a long paste is caught before the 400.
        v.fullPromptTooLong = ai.prompt.length > FULL_PROMPT_MAX;
    } else if (ai.mode === 'sections') {
        const validKeys = new Set<string>();
        const nonEmptyKeys: string[] = [];
        ai.sections.forEach((sec, idx) => {
            const hasKey = sec.key.length > 0;
            const keyValid = hasKey && KEY_RE.test(sec.key);
            const hasPrompt = sec.prompt.trim().length > 0;
            if (hasKey) nonEmptyKeys.push(sec.key);
            if (hasKey && !keyValid) v.sectionErrors[idx] = 'key';
            else if (!hasKey && hasPrompt) v.sectionErrors[idx] = 'key';
            else if (keyValid && !hasPrompt) v.sectionErrors[idx] = 'prompt';
            else if (keyValid && sec.prompt.length > SECTION_PROMPT_MAX) v.sectionErrors[idx] = 'promptLong';
            if (keyValid && hasPrompt && sec.prompt.length <= SECTION_PROMPT_MAX) validKeys.add(sec.key);
        });
        v.sectionsNoValid = validKeys.size === 0;
        v.dupKeys = new Set(nonEmptyKeys).size !== nonEmptyKeys.length;
        const scan = scanAiTokens(s.template);
        v.templateMalformed = scan.malformed;
        v.templateMissingKeys = [...new Set(scan.keys.filter((k) => !validKeys.has(k)))];
    } else {
        // off: the template is the literal message, so any {ai:…} token is broken (no section backs it).
        const scan = scanAiTokens(s.template);
        v.templateMalformed = scan.malformed;
        v.templateMissingKeys = [...new Set(scan.keys)];
    }

    v.invalid = v.fullPromptEmpty || v.fullPromptTooLong || v.sectionsNoValid || v.dupKeys
        || v.templateMalformed || v.templateMissingKeys.length > 0
        || Object.keys(v.sectionErrors).length > 0;
    return v;
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
                ai: normalizeAi(s.ai_config),
            })));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [detailQuery.data]);

    const mutateSteps = (next: StepDraft[]) => { setSteps(next); setStepsDirty(true); editSeq.current += 1; };
    const updateStep = (i: number, patch: Partial<StepDraft>) =>
        mutateSteps(steps.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    const updateAi = (i: number, patch: Partial<AiConfigDraft>) =>
        updateStep(i, { ai: { ...steps[i].ai, ...patch } });

    // Preview modal targets a snapshot of one step's current draft (endpoint renders inline, unsaved).
    const [previewStep, setPreviewStep] = useState<StepDraft | null>(null);

    const saveStepsMut = useMutation({
        mutationFn: async (seq: number) => {
            const res = (await api.put(`/linkedin/campaigns/${campaignId}/steps`, {
                steps: steps.map((s) => ({
                    type: s.type,
                    wait_days: s.wait_days,
                    template: s.type === 'wait' ? null : (s.template.trim() || null),
                    ai_config: s.type === 'wait' ? { mode: 'off' } : serializeAi(s.ai),
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

    // Block invalid drafts client-side (mirrors the server 400s) before save/preview.
    const stepValidations = steps.map(validateStep);
    const anyStepInvalid = stepValidations.some((v) => v.invalid);

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
                            {t('research.linkedin.camp.stepsHint', 'Templates support {first_name} {last_name} {company} {title} variables, {{spintax}} spintax and {ai:key} tokens where AI text is inserted. Invite notes over 300 characters are trimmed.', { spintax: '{{a|b}}' })}
                        </Text>
                    </div>
                    <Group gap="xs">
                        <Button size="xs" variant="light" leftSection={<IconPlus size={14} />}
                            onClick={() => mutateSteps([...steps, { type: steps.length === 0 ? 'invite' : 'message', wait_days: steps.length === 0 ? 0 : 1, template: '', ai: { mode: 'off', prompt: '', sections: [] } }])}>
                            {t('research.linkedin.camp.addStep', 'Add step')}
                        </Button>
                        <Button size="xs" onClick={() => saveStepsMut.mutate(editSeq.current)} loading={saveStepsMut.isPending} disabled={!stepsDirty || anyStepInvalid}>
                            {t('research.linkedin.camp.saveSteps', 'Save steps')}
                        </Button>
                    </Group>
                </Group>
                {anyStepInvalid && (
                    <Text size="xs" c="red" mb="xs">
                        {t('research.linkedin.camp.ai.saveBlocked', 'Some steps have errors. Fix the highlighted fields before saving.')}
                    </Text>
                )}
                {steps.length === 0 ? (
                    <Text c="dimmed" size="sm" ta="center" py="md">{t('research.linkedin.camp.noSteps', 'No steps yet. A typical sequence: invite → message.')}</Text>
                ) : (
                    <Stack gap="xs">
                        {steps.map((s, i) => (
                            <Paper key={i} withBorder radius="sm" p="sm">
                                <Stack gap="sm">
                                    {/* Row 1: order + type + wait, then preview + reorder/delete controls. */}
                                    <Group align="center" wrap="nowrap" gap="xs">
                                        <Text size="sm" fw={700} w={24} ta="center">{i + 1}</Text>
                                        <Select
                                            w={140}
                                            data={[
                                                { value: 'invite', label: t('research.linkedin.camp.stepInvite', 'Invite') },
                                                { value: 'message', label: t('research.linkedin.camp.stepMessage', 'Message') },
                                                { value: 'wait', label: t('research.linkedin.camp.stepWait', 'Wait') },
                                            ]}
                                            value={s.type}
                                            onChange={(v) => { if (v) updateStep(i, { type: v as StepType }); }}
                                        />
                                        <NumberInput
                                            w={130}
                                            min={0} max={90}
                                            placeholder="0"
                                            value={s.wait_days}
                                            onChange={(v) => updateStep(i, { wait_days: Number(v) || 0 })}
                                            suffix={` ${t('research.linkedin.camp.days', 'days')}`}
                                        />
                                        <div style={{ flex: 1 }} />
                                        {s.type !== 'wait' && (
                                            <Tooltip label={t('research.linkedin.camp.ai.previewBlocked', 'Fix this step’s errors to preview.')} disabled={!stepValidations[i].invalid}>
                                                <Button size="xs" variant="light" leftSection={<IconSparkles size={14} />}
                                                    disabled={stepValidations[i].invalid}
                                                    onClick={() => setPreviewStep(s)}>
                                                    {t('research.linkedin.camp.ai.preview', 'Preview')}
                                                </Button>
                                            </Tooltip>
                                        )}
                                        <Group gap={4} wrap="nowrap">
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

                                    {/* Row 2: mode picker + editor (invite/message only). */}
                                    {s.type !== 'wait' && (
                                        <StepEditor
                                            step={s}
                                            validation={stepValidations[i]}
                                            invitePlaceholder={s.type === 'invite'
                                                ? t('research.linkedin.camp.invitePlaceholder', 'Invite note (optional — noteless invites perform best)')
                                                : t('research.linkedin.camp.messagePlaceholder', 'Message text')}
                                            onTemplate={(template) => updateStep(i, { template })}
                                            onMode={(mode) => updateAi(i, { mode })}
                                            onPrompt={(prompt) => updateAi(i, { prompt })}
                                            onSections={(sections) => updateAi(i, { sections })}
                                        />
                                    )}
                                </Stack>
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
            <StepPreviewModal
                opened={previewStep !== null}
                campaignId={campaignId}
                step={previewStep}
                onClose={() => setPreviewStep(null)}
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

/** Row 2 of an invite/message step: AI mode picker + the editor for the chosen mode. */
function StepEditor({ step, validation, invitePlaceholder, onTemplate, onMode, onPrompt, onSections }: {
    step: StepDraft;
    validation: StepValidation;
    invitePlaceholder: string;
    onTemplate: (v: string) => void;
    onMode: (m: AiMode) => void;
    onPrompt: (v: string) => void;
    onSections: (s: AiSection[]) => void;
}) {
    const { t } = useTranslation();
    const ai = step.ai;

    // Template-level error (malformed {ai:…} beats a well-formed token with no matching section).
    const templateError = validation.templateMalformed
        ? t('research.linkedin.camp.ai.errTemplateMalformed', 'The template has a malformed {ai:…} token.')
        : validation.templateMissingKeys.length > 0
            ? t('research.linkedin.camp.ai.errTemplateMissing', 'The template uses {ai:key} that has no matching section.')
            : undefined;

    const templateBox = (hint?: string) => (
        <Textarea
            autosize minRows={2} maxRows={10}
            resize="vertical"
            placeholder={invitePlaceholder}
            description={hint}
            error={templateError}
            value={step.template}
            onChange={(e) => onTemplate(e.currentTarget.value)}
        />
    );

    const addSection = () => {
        if (ai.sections.length >= 5) return;
        const key = ai.sections.length === 0 ? 'icebreaker' : `section${ai.sections.length + 1}`;
        onSections([...ai.sections, { key, prompt: '' }]);
    };
    const updateSection = (idx: number, patch: Partial<AiSection>) =>
        onSections(ai.sections.map((x, j) => (j === idx ? { ...x, ...patch } : x)));
    const removeSection = (idx: number) => onSections(ai.sections.filter((_, j) => j !== idx));
    const insertToken = (key: string) => {
        if (!key) return;
        const sep = step.template && !step.template.endsWith(' ') ? ' ' : '';
        onTemplate(`${step.template}${sep}{ai:${key}}`);
    };

    return (
        <Stack gap="xs">
            <SegmentedControl
                size="xs"
                value={ai.mode}
                onChange={(v) => onMode(v as AiMode)}
                data={[
                    { value: 'off', label: t('research.linkedin.camp.ai.modeOff', 'AI off') },
                    { value: 'sections', label: t('research.linkedin.camp.ai.modeSections', 'AI sections') },
                    { value: 'full', label: t('research.linkedin.camp.ai.modeFull', 'Full AI') },
                ]}
            />

            {ai.mode === 'off' && templateBox()}

            {ai.mode === 'sections' && (
                <Stack gap="xs">
                    {templateBox(t('research.linkedin.camp.ai.sectionsTemplateHint', 'Put {ai:key} in the text to mark where each AI section is inserted.', { token: '{ai:key}' }))}
                    <Divider label={t('research.linkedin.camp.ai.sectionsTitle', 'AI sections')} labelPosition="left" />
                    {/* Same data-sharing disclosure as full mode — section generation also sends
                        the lead's fields (including custom import fields) to the AI model. */}
                    <Text size="xs" c="dimmed">
                        {t('research.linkedin.camp.ai.sectionsDataNote', 'The lead’s fields, including the custom fields from your import, are shared with the AI model when sections are generated.')}
                    </Text>
                    {ai.sections.length === 0 && (
                        <Text size="xs" c="dimmed">{t('research.linkedin.camp.ai.noSections', 'No AI sections yet. Add one to generate part of the message, such as an icebreaker.')}</Text>
                    )}
                    {ai.sections.map((sec, idx) => (
                        <Group key={idx} align="flex-start" wrap="nowrap" gap="xs">
                            <TextInput
                                w={180}
                                placeholder={t('research.linkedin.camp.ai.keyPlaceholder', 'key')}
                                value={sec.key}
                                error={validation.sectionErrors[idx] === 'key'
                                    ? t('research.linkedin.camp.ai.errSectionKey', 'Enter a valid key.')
                                    : undefined}
                                onChange={(e) => updateSection(idx, { key: sanitizeKey(e.currentTarget.value) })}
                            />
                            <Textarea
                                style={{ flex: 1 }}
                                autosize minRows={2} maxRows={8}
                                resize="vertical"
                                maxLength={SECTION_PROMPT_MAX}
                                placeholder={t('research.linkedin.camp.ai.sectionPromptPlaceholder', 'Prompt for this section, e.g. a one-line personalized icebreaker.')}
                                value={sec.prompt}
                                error={validation.sectionErrors[idx] === 'prompt'
                                    ? t('research.linkedin.camp.ai.errSectionPrompt', 'Enter a prompt for this section.')
                                    : validation.sectionErrors[idx] === 'promptLong'
                                        ? t('research.linkedin.camp.ai.errSectionPromptLong', 'The section prompt can be at most {{max}} characters.', { max: SECTION_PROMPT_MAX })
                                        : undefined}
                                onChange={(e) => updateSection(idx, { prompt: e.currentTarget.value })}
                            />
                            <Tooltip label={t('research.linkedin.camp.ai.insertToken', 'Insert token into template')}>
                                <ActionIcon variant="subtle" mt={4} disabled={!sec.key} onClick={() => insertToken(sec.key)}>
                                    <IconCirclePlus size={16} />
                                </ActionIcon>
                            </Tooltip>
                            <ActionIcon variant="subtle" color="red" mt={4} onClick={() => removeSection(idx)}>
                                <IconTrash size={16} />
                            </ActionIcon>
                        </Group>
                    ))}
                    {validation.sectionsNoValid && ai.sections.length > 0 && (
                        <Text size="xs" c="red">{t('research.linkedin.camp.ai.errNoSection', 'Add at least one section with a key and a prompt.')}</Text>
                    )}
                    {validation.dupKeys && (
                        <Text size="xs" c="red">{t('research.linkedin.camp.ai.dupKeys', 'Two sections share the same key. Give each section a unique key.')}</Text>
                    )}
                    <Button size="xs" variant="subtle" leftSection={<IconPlus size={14} />}
                        disabled={ai.sections.length >= 5} onClick={addSection} w="fit-content">
                        {t('research.linkedin.camp.ai.addSection', 'Add AI section')}
                    </Button>
                </Stack>
            )}

            {ai.mode === 'full' && (
                <Textarea
                    autosize minRows={4} maxRows={16}
                    resize="vertical"
                    maxLength={FULL_PROMPT_MAX}
                    label={t('research.linkedin.camp.ai.fullLabel', 'AI message prompt')}
                    description={t('research.linkedin.camp.ai.fullDesc', 'The lead’s fields, including the custom fields from your import, are shared with the AI model, which writes the whole message.')}
                    placeholder={t('research.linkedin.camp.ai.fullPlaceholder', 'Describe the message the AI should write.')}
                    error={validation.fullPromptEmpty
                        ? t('research.linkedin.camp.ai.errFullPrompt', 'Full AI needs a prompt.')
                        : validation.fullPromptTooLong
                            ? t('research.linkedin.camp.ai.errFullPromptLong', 'The prompt can be at most {{max}} characters.', { max: FULL_PROMPT_MAX })
                            : undefined}
                    value={ai.prompt}
                    onChange={(e) => onPrompt(e.currentTarget.value)}
                />
            )}
        </Stack>
    );
}

interface LeadOption {
    id: string; first_name: string | null; last_name: string | null;
    company: string | null; title: string | null; public_id: string | null;
}
interface PreviewResponse {
    rendered: string;
    parts: { full?: string; sections?: Record<string, string> };
    char_count: number;
    warnings: string[];
}

/** Live LLM preview of one step against a picked lead (or sample data). The call is slow. */
function StepPreviewModal({ opened, campaignId, step, onClose }: {
    opened: boolean; campaignId: string; step: StepDraft | null; onClose: () => void;
}) {
    const { t } = useTranslation();
    const [leadId, setLeadId] = useState<string | null>(null);
    const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [needle, setNeedle] = useState('');

    // Debounce the search box so we don't hit /leads on every keystroke.
    useEffect(() => {
        const id = setTimeout(() => setNeedle(search), 300);
        return () => clearTimeout(id);
    }, [search]);

    const leadsQuery = useQuery<{ data: LeadOption[] }>({
        queryKey: ['linkedin', 'leads', 'preview-search', needle],
        queryFn: async () => (await api.get('/linkedin/leads', { params: { q: needle, limit: 20 } })).data,
        enabled: opened,
    });

    const previewMut = useMutation({
        mutationFn: async () => {
            if (!step) throw new Error('no step');
            return (await api.post(`/linkedin/campaigns/${campaignId}/steps/preview`, {
                step: { type: step.type, template: step.template, ai_config: serializeAi(step.ai) },
                ...(leadId ? { lead_id: leadId } : {}),
            })).data as PreviewResponse;
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    // Reset per open/close so a reused (or reopened) modal never shows a stale render/lead.
    useEffect(() => {
        if (opened) { setLeadId(null); setSelectedLabel(null); setSearch(''); setNeedle(''); }
        previewMut.reset();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened]);

    const leadLabel = (l: LeadOption) => {
        const name = `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || l.public_id || '—';
        return l.company ? `${name} — ${l.company}` : name;
    };
    const options = (leadsQuery.data?.data ?? []).map((l) => ({ value: l.id, label: leadLabel(l) }));
    // Keep the picked option present even after the search list changes under it.
    if (leadId && selectedLabel && !options.some((o) => o.value === leadId)) options.unshift({ value: leadId, label: selectedLabel });

    const result = previewMut.data;
    const isInvite = step?.type === 'invite';
    const overLimit = Boolean(isInvite && result && result.char_count > 300);

    return (
        <Modal opened={opened} onClose={onClose} size="lg" title={t('research.linkedin.camp.ai.previewTitle', 'Preview message')}>
            <Stack gap="sm">
                <Select
                    label={t('research.linkedin.camp.ai.previewLead', 'Preview with lead')}
                    placeholder={t('research.linkedin.camp.ai.previewLeadPlaceholder', 'Search a lead by name')}
                    searchable clearable
                    data={options}
                    value={leadId}
                    searchValue={search}
                    onSearchChange={setSearch}
                    nothingFoundMessage={leadsQuery.isFetching
                        ? t('research.linkedin.camp.ai.searching', 'Searching…')
                        : t('research.linkedin.camp.ai.noLeads', 'No leads found')}
                    onChange={(v, opt) => { setLeadId(v); setSelectedLabel(opt?.label ?? null); previewMut.reset(); }}
                />
                {!leadId && (
                    <Text size="xs" c="dimmed">{t('research.linkedin.camp.ai.sampleData', 'Using sample data (Ayşe Yılmaz, Acme GmbH).')}</Text>
                )}
                <Group>
                    <Button leftSection={<IconSparkles size={16} />} loading={previewMut.isPending}
                        onClick={() => previewMut.mutate()}>
                        {result
                            ? t('research.linkedin.camp.ai.regenerate', 'Regenerate')
                            : t('research.linkedin.camp.ai.generate', 'Generate')}
                    </Button>
                </Group>

                {result && (
                    <Stack gap="xs" pos="relative">
                        <LoadingOverlay visible={previewMut.isPending} />
                        {(result.warnings ?? []).map((w) => (
                            <Alert key={w} color="orange" icon={<IconInfoCircle size={16} />} py="xs">
                                {t(`research.linkedin.camp.ai.warn.${w}`, w)}
                            </Alert>
                        ))}
                        <Paper withBorder radius="sm" p="sm">
                            <Text size="sm" style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--mantine-font-family-monospace)' }}>
                                {result.rendered}
                            </Text>
                        </Paper>
                        <Group gap="xs">
                            <Tooltip
                                label={t('research.linkedin.camp.ai.inviteLimitHint', 'LinkedIn trims invite notes at 300 characters.')}
                                disabled={!isInvite}
                            >
                                <Badge color={overLimit ? 'red' : 'gray'} variant="light">
                                    {t('research.linkedin.camp.ai.charCount', '{{n}} characters', { n: result.char_count })}
                                </Badge>
                            </Tooltip>
                        </Group>
                        {result.parts?.sections && Object.keys(result.parts.sections).length > 0 && (
                            <Stack gap={2}>
                                <Text size="xs" c="dimmed" fw={600}>{t('research.linkedin.camp.ai.sectionsContributed', 'AI sections')}</Text>
                                {Object.entries(result.parts.sections).map(([k, v]) => (
                                    <Text key={k} size="xs" c="dimmed"><b>{k}:</b> {v}</Text>
                                ))}
                            </Stack>
                        )}
                    </Stack>
                )}
            </Stack>
        </Modal>
    );
}
