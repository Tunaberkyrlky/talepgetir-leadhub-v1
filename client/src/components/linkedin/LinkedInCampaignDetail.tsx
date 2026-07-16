import { useEffect, useRef, useState } from 'react';
import {
    ActionIcon, Alert, Badge, Button, Checkbox, Divider, FileInput, Group, Loader, LoadingOverlay,
    Modal, MultiSelect, NumberInput, Paper, Popover, ScrollArea, SegmentedControl, Select, Stack,
    Switch, Table, Tabs, Text, Textarea, TextInput, Tooltip,
} from '@mantine/core';
import {
    IconArrowDown, IconArrowLeft, IconArrowUp, IconArchive, IconCirclePlus, IconFileText,
    IconInfoCircle, IconList, IconPlayerPause, IconPlayerPlay, IconPlus, IconSparkles, IconTrash,
    IconUserPlus, IconUsers,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { getErrorMessage, showErrorFromApi, showSuccess } from '../../lib/notifications';
import {
    CAMPAIGN_STATUS_COLOR, accountLabel, csvRowToLead, mapCsvHeaders, parseCsv, parseLeadLine,
    type AccountOption, type CsvColumnMap, type LinkedInCampaign,
} from './linkedinShared';
import { STARTER_TEMPLATES, type StarterTemplate } from './linkedinTemplates';

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
/**
 * Scan a template for section references. `{ai:key}` is the explicit form; any '{ai:' that
 * isn't a well-formed token is malformed. A bare `{key}` (single brace) is also collected so
 * the sections validator can treat it as a reference when it matches a configured section —
 * mirroring the server, where a bare token whose key names a section renders like `{ai:key}`.
 */
function scanAiTokens(template: string): { malformed: boolean; keys: string[]; bareKeys: string[] } {
    const keys: string[] = [];
    const bareKeys: string[] = [];
    let malformed = false;
    const scan = /\{ai:/g;
    const valid = /^\{ai:([a-z][a-z0-9_]{0,29})\}/;
    let m: RegExpExecArray | null;
    while ((m = scan.exec(template)) !== null) {
        const vm = template.slice(m.index).match(valid);
        if (vm) keys.push(vm[1]);
        else malformed = true;
    }
    // Bare `{key}`; the ':' breaks the char class so `{ai:key}` never matches, and the
    // lookbehind keeps it from matching the inner braces of `{{spintax}}` (mirrors the server —
    // no trailing (?!\}) on purpose: it would wrongly reject a token followed by a literal '}').
    const bareScan = /(?<!\{)\{([a-z][a-z0-9_]{0,29})\}/g;
    let b: RegExpExecArray | null;
    while ((b = bareScan.exec(template)) !== null) bareKeys.push(b[1]);
    return { malformed, keys, bareKeys };
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
        // Only an explicit {ai:key} naming a MISSING section is an error. A bare {key} that
        // matches a configured section is a valid reference (renders like {ai:key}); a bare
        // {key} with no matching section is just a personalize variable, so it never flags.
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
                                            onApplyTemplate={(patch) => updateStep(i, patch)}
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

type EnrollResult = { enrolled: number; total: number; results: Array<{ reason: string }> };
type T = ReturnType<typeof useTranslation>['t'];

/** Shared enroll-summary line: "X/Y enrolled (reason: n, …)". */
function formatEnrollSummary(r: EnrollResult, t: T): string {
    const rollup = new Map<string, number>();
    for (const x of r.results) if (x.reason !== 'ok') rollup.set(x.reason, (rollup.get(x.reason) ?? 0) + 1);
    const skipped = [...rollup.entries()].map(([k, v]) => `${t(`research.linkedin.camp.reason.${k}`, k)}: ${v}`).join(', ');
    return t('research.linkedin.camp.enrollSummary', '{{enrolled}}/{{total}} enrolled.', { enrolled: r.enrolled, total: r.total })
        + (skipped ? ` (${skipped})` : '');
}
const csvCell = (row: string[], idx: number): string => (idx >= 0 ? (row[idx] ?? '') : '');

// The enroll endpoint's zod caps lead_ids at 500 per request, so both create + enroll are chunked.
const CHUNK = 500;

/** Thrown when a mid-sequence enroll chunk fails: carries the partial rollup + progress. */
class EnrollPartialError extends Error {
    partial: EnrollResult; doneChunks: number; totalChunks: number; original: unknown;
    constructor(partial: EnrollResult, doneChunks: number, totalChunks: number, original: unknown) {
        super('enroll_partial');
        this.name = 'EnrollPartialError';
        this.partial = partial; this.doneChunks = doneChunks; this.totalChunks = totalChunks; this.original = original;
    }
}

/** Create leads in ≤500-row POSTs, returning the created ids in order. */
async function createLeads(
    leads: Array<Record<string, string>>, source: string, onProgress?: (i: number, n: number) => void,
): Promise<string[]> {
    const ids: string[] = [];
    const n = Math.ceil(leads.length / CHUNK);
    for (let ci = 0; ci < n; ci++) {
        onProgress?.(ci + 1, n);
        const chunk = leads.slice(ci * CHUNK, ci * CHUNK + CHUNK).map((l) => ({ ...l, source }));
        const created = (await api.post('/linkedin/leads', { leads: chunk })).data as { data: Array<{ id: string }> };
        for (const r of created.data) ids.push(r.id);
    }
    return ids;
}

/**
 * Enroll ids in ≤500-id POSTs, aggregating the summary. A FIRST-chunk failure rethrows the
 * ORIGINAL error — nothing was enrolled, so it's a plain failure (400/401/network…) and the tabs
 * surface it via showErrorFromApi. Only a later-chunk failure is a genuine partial.
 */
async function enrollInChunks(campaignId: string, leadIds: string[]): Promise<EnrollResult> {
    const agg: EnrollResult = { enrolled: 0, total: 0, results: [] };
    const n = Math.ceil(leadIds.length / CHUNK);
    for (let ci = 0; ci < n; ci++) {
        const chunk = leadIds.slice(ci * CHUNK, ci * CHUNK + CHUNK);
        try {
            const r = (await api.post(`/linkedin/campaigns/${campaignId}/enroll`, { lead_ids: chunk })).data as EnrollResult;
            agg.enrolled += r.enrolled; agg.total += r.total; agg.results.push(...r.results);
        } catch (err) {
            if (ci === 0) throw err; // no chunk succeeded — not a partial, surface the real error
            throw new EnrollPartialError(agg, ci, n, err);
        }
    }
    return agg;
}

/** Partial-progress line: "N/M batches enrolled… <real error> <partial rollup>". */
function formatEnrollPartial(e: EnrollPartialError, t: T): string {
    const head = t('research.linkedin.camp.enrollPartial',
        '{{done}}/{{total}} batches enrolled before the request failed. Retry to add the rest.',
        { done: e.doneChunks, total: e.totalChunks });
    const cause = getErrorMessage(e.original);
    const rollup = e.partial.total > 0 ? ` ${formatEnrollSummary(e.partial, t)}` : '';
    return `${head} ${cause}${rollup}`;
}

/** Summary callback shared by the three tabs: partial-failure summaries render with error styling. */
type OnSummary = (s: string, tone?: 'success' | 'error') => void;

/** Three ways to add leads: pick saved people, upload a CSV, or paste a URL list. */
function AddLeadsModal({ opened, campaignId, onClose, onDone }: {
    opened: boolean; campaignId: string; onClose: () => void; onDone: () => void;
}) {
    const { t } = useTranslation();
    const [summary, setSummary] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);
    const [tab, setTab] = useState<string | null>('saved');
    const onSummary: OnSummary = (text, tone = 'success') => setSummary({ text, tone });

    const close = () => { const had = summary !== null; setSummary(null); onClose(); if (had) onDone(); };

    return (
        <Modal opened={opened} onClose={close} title={t('research.linkedin.camp.addLeadsTitle', 'Add leads to campaign')} size="lg">
            <Stack gap="sm">
                <Tabs value={tab} onChange={setTab} variant="outline">
                    <Tabs.List>
                        <Tabs.Tab value="saved" leftSection={<IconUsers size={14} />}>{t('research.linkedin.camp.tabSaved', 'Saved people')}</Tabs.Tab>
                        <Tabs.Tab value="csv" leftSection={<IconFileText size={14} />}>{t('research.linkedin.camp.tabCsv', 'CSV')}</Tabs.Tab>
                        <Tabs.Tab value="urls" leftSection={<IconList size={14} />}>{t('research.linkedin.camp.tabUrls', 'URL list')}</Tabs.Tab>
                    </Tabs.List>
                    <Tabs.Panel value="saved" pt="sm">
                        <SavedLeadsTab campaignId={campaignId} active={opened && tab === 'saved'} onSummary={onSummary} />
                    </Tabs.Panel>
                    <Tabs.Panel value="csv" pt="sm">
                        <CsvTab campaignId={campaignId} onSummary={onSummary} />
                    </Tabs.Panel>
                    <Tabs.Panel value="urls" pt="sm">
                        <UrlListTab campaignId={campaignId} onSummary={onSummary} />
                    </Tabs.Panel>
                </Tabs>
                <Text size="xs" c="dimmed">
                    {t('research.linkedin.camp.addLeadsHint', 'Suppressed people and leads already in another active campaign are skipped automatically.')}
                </Text>
                {summary && (
                    <Alert color={summary.tone === 'error' ? 'red' : 'green'} icon={<IconInfoCircle size={16} />}>
                        {summary.text}
                    </Alert>
                )}
            </Stack>
        </Modal>
    );
}

/** Tab a — pick from the tenant's existing leads and enroll them directly (no re-creation). */
function SavedLeadsTab({ campaignId, active, onSummary }: {
    campaignId: string; active: boolean; onSummary: OnSummary;
}) {
    const { t } = useTranslation();
    const [search, setSearch] = useState('');
    const [needle, setNeedle] = useState('');
    const [selected, setSelected] = useState<string[]>([]);
    useEffect(() => { const id = setTimeout(() => setNeedle(search), 300); return () => clearTimeout(id); }, [search]);

    const q = useQuery<{ data: LeadOption[] }>({
        queryKey: ['linkedin', 'leads', 'enroll-search', needle],
        queryFn: async () => (await api.get('/linkedin/leads', { params: { q: needle, limit: 50 } })).data,
        enabled: active,
    });
    const leads = q.data?.data ?? [];
    const pageIds = leads.map((l) => l.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
    const toggleAll = () => setSelected(allSelected
        ? selected.filter((id) => !pageIds.includes(id))
        : [...new Set([...selected, ...pageIds])]);

    const rowLabel = (l: LeadOption) => {
        const name = `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || l.public_id || '—';
        return [name, l.company, l.title].filter(Boolean).join(' — ');
    };

    const mut = useMutation({
        mutationFn: async () => enrollInChunks(campaignId, selected),
        onSuccess: (r) => { onSummary(formatEnrollSummary(r, t)); setSelected([]); },
        // On a partial failure keep the selection so a retry (idempotent — already-enrolled skip) is one click.
        onError: (err: unknown) => {
            if (err instanceof EnrollPartialError) onSummary(formatEnrollPartial(err, t), 'error');
            else showErrorFromApi(err);
        },
    });

    return (
        <Stack gap="sm">
            <TextInput
                size="sm"
                placeholder={t('research.linkedin.camp.savedSearchPlaceholder', 'Search by name, company or title')}
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
            />
            <Group justify="space-between">
                <Button size="xs" variant="subtle" disabled={pageIds.length === 0} onClick={toggleAll}>
                    {t('research.linkedin.camp.selectAll', 'Select all')}
                </Button>
                <Badge variant="light">{t('research.linkedin.camp.selectedCount', '{{n}} selected', { n: selected.length })}</Badge>
            </Group>
            {q.isLoading ? (
                <Group justify="center" py="md"><Loader size="sm" /></Group>
            ) : leads.length === 0 ? (
                <Text c="dimmed" size="sm" ta="center" py="md">{t('research.linkedin.camp.savedEmpty', 'No people found.')}</Text>
            ) : (
                <ScrollArea.Autosize mah={260}>
                    <Checkbox.Group value={selected} onChange={setSelected}>
                        <Stack gap={6}>
                            {leads.map((l) => (<Checkbox key={l.id} value={l.id} label={rowLabel(l)} />))}
                        </Stack>
                    </Checkbox.Group>
                </ScrollArea.Autosize>
            )}
            <Group justify="flex-end">
                <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={selected.length === 0}>
                    {t('research.linkedin.camp.enrollSelected', 'Enroll selected')}
                </Button>
            </Group>
        </Stack>
    );
}

/** Tab b — upload a CSV, auto-detect columns, preview, then chunk-create + enroll. */
function CsvTab({ campaignId, onSummary }: { campaignId: string; onSummary: OnSummary }) {
    const { t } = useTranslation();
    const [file, setFile] = useState<File | null>(null);
    const [leads, setLeads] = useState<Array<Record<string, string>>>([]);
    const [preview, setPreview] = useState<string[][]>([]);
    const [map, setMap] = useState<CsvColumnMap | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<{ i: number; n: number } | null>(null);
    // Rows dropped at parse time: invalid = a value was present but unusable (e.g. a company
    // website); empty = no identity candidate column had a value at all. Both are reported.
    const [skipped, setSkipped] = useState<{ invalid: number; empty: number }>({ invalid: 0, empty: 0 });

    const reset = () => { setLeads([]); setPreview([]); setMap(null); setError(null); setProgress(null); setSkipped({ invalid: 0, empty: 0 }); };

    const onFile = async (f: File | null) => {
        setFile(f); reset();
        if (!f) return;
        try {
            const rows = parseCsv(await f.text()).filter((r) => r.some((c) => c.trim() !== ''));
            if (rows.length < 2) { setError(t('research.linkedin.camp.csvNoRows', 'The CSV has no data rows.')); return; }
            const header = rows[0];
            const cols = mapCsvHeaders(header);
            if (cols.identity < 0) {
                setError(t('research.linkedin.camp.csvNeedIdentity', 'No URL or public id column found. Headers found: {{headers}}', { headers: header.join(', ') }));
                return;
            }
            const dataRows = rows.slice(1);
            const parsed: Array<Record<string, string>> = [];
            let invalid = 0, empty = 0;
            for (const r of dataRows) {
                const res = csvRowToLead(r, cols);
                if ('lead' in res) parsed.push(res.lead);
                else if (res.skip === 'invalid_identity') invalid += 1;
                else empty += 1;
            }
            if (parsed.length === 0) {
                // All rows rejected: say WHY (codex P1 — a generic "no data rows" hid the skip
                // counts, so an all-invalid file looked empty instead of mis-mapped).
                setSkipped({ invalid, empty });
                setError(invalid + empty > 0
                    ? t('research.linkedin.camp.csvAllSkipped', 'No importable rows: {{invalid}} with an invalid identity, {{empty}} without an identity value.', { invalid, empty })
                    : t('research.linkedin.camp.csvNoRows', 'The CSV has no data rows.'));
                return;
            }
            setMap(cols); setLeads(parsed); setPreview(dataRows.slice(0, 5)); setSkipped({ invalid, empty });
        } catch {
            setError(t('research.linkedin.camp.csvParseError', 'Could not read the CSV.'));
        }
    };

    const skipParts = [
        skipped.invalid > 0 ? t('research.linkedin.camp.csvSkipped', '{{n}} rows skipped (invalid identity).', { n: skipped.invalid }) : '',
        skipped.empty > 0 ? t('research.linkedin.camp.csvSkippedEmpty', '{{n}} rows skipped (no identity value).', { n: skipped.empty }) : '',
    ].filter(Boolean);
    const skipNote = skipParts.length > 0 ? ` ${skipParts.join(' ')}` : '';
    const mut = useMutation({
        mutationFn: async () => {
            const ids = await createLeads(leads, 'csv', (i, n) => setProgress({ i, n }));
            return enrollInChunks(campaignId, ids);
        },
        onSuccess: (r) => { onSummary(formatEnrollSummary(r, t) + skipNote); setFile(null); reset(); },
        onError: (err: unknown) => {
            setProgress(null);
            if (err instanceof EnrollPartialError) onSummary(formatEnrollPartial(err, t) + skipNote, 'error');
            else showErrorFromApi(err);
        },
    });

    return (
        <Stack gap="sm">
            <FileInput
                size="sm" accept=".csv,text/csv" clearable
                label={t('research.linkedin.camp.csvPick', 'Choose a CSV file')}
                placeholder={t('research.linkedin.camp.csvPickPlaceholder', 'profiles.csv')}
                value={file}
                onChange={onFile}
            />
            {error && <Alert color="orange" icon={<IconInfoCircle size={16} />}>{error}</Alert>}
            {leads.length > 0 && map && (
                <>
                    <Text size="xs" c="dimmed">
                        {t('research.linkedin.camp.csvPreview', 'Previewing the first {{n}} of {{total}} rows.', { n: preview.length, total: leads.length })}
                    </Text>
                    {skipParts.length > 0 && (
                        <Text size="xs" c="orange">{skipParts.join(' ')}</Text>
                    )}
                    <ScrollArea.Autosize mah={220}>
                        <Table striped withTableBorder verticalSpacing={4} fz="xs">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('research.linkedin.camp.csvColIdentity', 'Identity')}</Table.Th>
                                    <Table.Th>{t('research.linkedin.camp.csvColFirst', 'First name')}</Table.Th>
                                    <Table.Th>{t('research.linkedin.camp.csvColLast', 'Last name')}</Table.Th>
                                    <Table.Th>{t('research.linkedin.camp.company', 'Company')}</Table.Th>
                                    <Table.Th>{t('research.linkedin.camp.csvColTitle', 'Title')}</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {preview.map((r, ri) => (
                                    <Table.Tr key={ri}>
                                        <Table.Td>{csvCell(r, map.identity)}</Table.Td>
                                        <Table.Td>{csvCell(r, map.first_name)}</Table.Td>
                                        <Table.Td>{csvCell(r, map.last_name)}</Table.Td>
                                        <Table.Td>{csvCell(r, map.company)}</Table.Td>
                                        <Table.Td>{csvCell(r, map.title)}</Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </ScrollArea.Autosize>
                    {progress && (
                        <Text size="xs" c="dimmed">{t('research.linkedin.camp.csvProgress', 'Importing {{i}}/{{n}}', { i: progress.i, n: progress.n })}</Text>
                    )}
                    <Group justify="flex-end">
                        <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={leads.length === 0}>
                            {t('research.linkedin.camp.enrollNow', 'Import + enroll')}
                        </Button>
                    </Group>
                </>
            )}
        </Stack>
    );
}

/** Tab c — the original paste-a-URL-per-line flow. */
function UrlListTab({ campaignId, onSummary }: { campaignId: string; onSummary: OnSummary }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [invalid, setInvalid] = useState(false);

    const mut = useMutation({
        mutationFn: async (leads: Array<Record<string, string>>) => {
            const ids = await createLeads(leads, 'manual');
            return enrollInChunks(campaignId, ids);
        },
        onSuccess: (r) => { onSummary(formatEnrollSummary(r, t)); setText(''); },
        onError: (err: unknown) => {
            if (err instanceof EnrollPartialError) onSummary(formatEnrollPartial(err, t), 'error');
            else showErrorFromApi(err);
        },
    });

    // Parse + validate BEFORE the mutation so a paste of only separators shows a translated
    // message instead of the raw internal 'no_leads' code (review P3).
    const run = () => {
        setInvalid(false);
        const leads = text.split('\n').map(parseLeadLine).filter(Boolean) as Array<Record<string, string>>;
        if (leads.length === 0) { setInvalid(true); return; }
        mut.mutate(leads);
    };

    return (
        <Stack gap="sm">
            <Textarea
                autosize minRows={6} maxRows={14}
                placeholder={t('research.linkedin.camp.addLeadsPlaceholder', 'One per line: profile URL, public id or URN — optionally add , First, Last, Company, Title')}
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
            />
            {invalid && <Alert color="orange" icon={<IconInfoCircle size={16} />}>{t('research.linkedin.camp.noValidLeads', 'No valid leads found — add a profile URL, public id or URN on each line.')}</Alert>}
            <Group justify="flex-end">
                <Button onClick={run} loading={mut.isPending} disabled={text.trim().length === 0}>
                    {t('research.linkedin.camp.enrollNow', 'Import + enroll')}
                </Button>
            </Group>
        </Stack>
    );
}

/** Row 2 of an invite/message step: AI mode picker + the editor for the chosen mode. */
function StepEditor({ step, validation, invitePlaceholder, onTemplate, onMode, onPrompt, onSections, onApplyTemplate }: {
    step: StepDraft;
    validation: StepValidation;
    invitePlaceholder: string;
    onTemplate: (v: string) => void;
    onMode: (m: AiMode) => void;
    onPrompt: (v: string) => void;
    onSections: (s: AiSection[]) => void;
    onApplyTemplate: (patch: { template: string; ai: AiConfigDraft }) => void;
}) {
    const { t } = useTranslation();
    const ai = step.ai;

    // ── Starter templates ───────────────────────────────────────────────────────
    // Template bodies carry {{spintax}}; resolve them with interpolation disabled (a prefix/suffix
    // that never appears) so i18next leaves the double braces untouched instead of eating them.
    const rawT = (key: string) => t(key, { interpolation: { prefix: '\0', suffix: '\0' } });
    const [tplValue, setTplValue] = useState<string | null>(null);
    const [confirmTpl, setConfirmTpl] = useState<StarterTemplate | null>(null);
    const tplOptions = STARTER_TEMPLATES
        .filter((x) => x.stepType === step.type)
        .map((x) => ({ value: x.id, label: t(x.nameKey) }));
    // Mode-independent: a full-AI prompt or sections written earlier are PRESERVED across a mode
    // switch (normalizeAi keeps them), so applying a starter template would silently erase them —
    // the confirm must fire even when the current mode hides that content.
    const hasContent = step.template.trim().length > 0
        || ai.prompt.trim().length > 0
        || ai.sections.some((s) => s.key || s.prompt.trim());
    const applyTemplate = (tpl: StarterTemplate) => {
        onApplyTemplate({
            template: tpl.templateKey ? rawT(tpl.templateKey) : '',
            ai: {
                mode: tpl.mode,
                prompt: tpl.promptKey ? rawT(tpl.promptKey) : '',
                sections: (tpl.sections ?? []).map((s) => ({ key: s.key, prompt: rawT(s.promptKey) })),
            },
        });
        setTplValue(null);
        setConfirmTpl(null);
    };
    const pickTemplate = (val: string | null) => {
        if (!val) { setTplValue(null); return; }
        const tpl = STARTER_TEMPLATES.find((x) => x.id === val);
        if (!tpl) return;
        setTplValue(val);
        if (hasContent) setConfirmTpl(tpl); // confirm before clobbering existing content
        else applyTemplate(tpl);
    };
    const cancelTemplate = () => { setConfirmTpl(null); setTplValue(null); };

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
            <Group gap="xs" justify="space-between" wrap="wrap">
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
                <Popover opened={confirmTpl !== null} position="bottom-end" withArrow shadow="md" onClose={cancelTemplate}>
                    <Popover.Target>
                        <Select
                            size="xs" w={210} clearable
                            placeholder={t('research.linkedin.camp.templateSelect', 'Start from a template')}
                            data={tplOptions}
                            value={tplValue}
                            onChange={pickTemplate}
                        />
                    </Popover.Target>
                    <Popover.Dropdown>
                        <Stack gap="xs" maw={240}>
                            <Text size="sm">{t('research.linkedin.camp.templateOverwrite', 'Replace the current content with this template?')}</Text>
                            <Group gap="xs" justify="flex-end">
                                <Button size="xs" variant="default" onClick={cancelTemplate}>{t('research.linkedin.camp.cancel', 'Cancel')}</Button>
                                <Button size="xs" color="red" onClick={() => confirmTpl && applyTemplate(confirmTpl)}>{t('research.linkedin.camp.templateApply', 'Apply')}</Button>
                            </Group>
                        </Stack>
                    </Popover.Dropdown>
                </Popover>
            </Group>

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
    const [selectedLead, setSelectedLead] = useState<LeadOption | null>(null);
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
        if (opened) { setLeadId(null); setSelectedLabel(null); setSelectedLead(null); setSearch(''); setNeedle(''); }
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
                    onChange={(v, opt) => {
                        setLeadId(v);
                        setSelectedLabel(opt?.label ?? null);
                        setSelectedLead(v ? (leadsQuery.data?.data.find((l) => l.id === v) ?? null) : null);
                        previewMut.reset();
                    }}
                />
                {leadId && selectedLead ? (
                    // Show what the picked lead actually carries — a URL-only lead with no first_name
                    // renders "merhaba ," and the facts line makes that visible before generating.
                    <div>
                        <Text size="xs" c="dimmed">
                            {[
                                `${selectedLead.first_name ?? ''} ${selectedLead.last_name ?? ''}`.trim() || '—',
                                selectedLead.company || '—',
                                selectedLead.title || '—',
                            ].join(' · ')}
                        </Text>
                        {(!selectedLead.first_name || !selectedLead.company) && (
                            <Text size="xs" c="dimmed" fs="italic">
                                {t('research.linkedin.camp.ai.previewMissingHint', 'Missing fields render empty in the message.')}
                            </Text>
                        )}
                    </div>
                ) : !leadId ? (
                    <Text size="xs" c="dimmed">{t('research.linkedin.camp.ai.sampleData', 'Using sample data (Ayşe Yılmaz, Acme GmbH).')}</Text>
                ) : null}
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
