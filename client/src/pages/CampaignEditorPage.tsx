import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Container, Paper, Group, Stack, Text, TextInput, Button, Badge, Grid, Tabs, Loader, Center, Modal, Alert,
} from '@mantine/core';
import {
    IconArrowLeft, IconDeviceFloppy, IconPlayerPlay, IconPlayerPause, IconChartBar, IconUsers, IconList, IconAlertCircle, IconSettings,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import SequenceTimeline from '../components/campaigns/SequenceTimeline';
import StepEditor from '../components/campaigns/StepEditor';
import EnrollmentPanel from '../components/campaigns/EnrollmentPanel';
import CampaignStatsPanel from '../components/campaigns/CampaignStatsPanel';
import CampaignSettingsPanel from '../components/campaigns/CampaignSettingsPanel';
import type { Campaign, CampaignStep, CampaignSettings } from '../types/campaign';

const STATUS_COLORS: Record<string, string> = {
    draft: 'gray', active: 'green', paused: 'yellow', completed: 'blue',
};

export default function CampaignEditorPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const { t } = useTranslation();
    const qc = useQueryClient();
    const isNew = !id || id === 'new';

    const [name, setName] = useState('');
    const [steps, setSteps] = useState<CampaignStep[]>([]);
    const [fromName, setFromName] = useState('');
    const [settings, setSettings] = useState<CampaignSettings>({});
    const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
    const [activeTab, setActiveTab] = useState<string | null>('steps');
    const [confirmLeave, setConfirmLeave] = useState(false);
    const isDirty = useRef(false);

    // ── Undo stack (Cmd+Z) ─────────────────────────────────────────────
    interface Snapshot { name: string; steps: CampaignStep[] }
    const undoStack = useRef<Snapshot[]>([]);
    const MAX_UNDO = 50;

    const pushUndo = useCallback(() => {
        undoStack.current.push({ name, steps: structuredClone(steps) });
        if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
    }, [name, steps]);

    const undo = useCallback(() => {
        const prev = undoStack.current.pop();
        if (!prev) return;
        setName(prev.name);
        setSteps(prev.steps);
    }, []);

    // Cmd+Z handler — only when not typing in an input (native undo handles that)
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
                const tag = (e.target as HTMLElement)?.tagName;
                // Let native undo handle text inputs/textareas
                if (tag === 'INPUT' || tag === 'TEXTAREA') return;
                e.preventDefault();
                undo();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [undo]);

    const { data: campaign, isLoading } = useQuery<Campaign>({
        queryKey: ['campaign', id],
        queryFn: async () => { const r = await api.get(`/campaigns/${id}`); return r.data.data; },
        enabled: !isNew && !!id,
    });

    useEffect(() => {
        if (campaign) {
            setName(campaign.name);
            setSteps(campaign.steps || []);
            setFromName(campaign.from_name || '');
            setSettings(campaign.settings || {});
            isDirty.current = false;
            undoStack.current = [];
        }
    }, [campaign]);

    // Dirty tracking — text edits don't push undo (native undo handles those)
    const setNameDirty = (v: string) => { setName(v); isDirty.current = true; };
    const setFromNameDirty = (v: string) => { setFromName(v); isDirty.current = true; };
    const setSettingsDirty = (s: CampaignSettings) => { setSettings(s); isDirty.current = true; };
    // Structural changes (add/delete/reorder steps) push undo
    const setStepsDirty = (v: CampaignStep[]) => { pushUndo(); setSteps(v); isDirty.current = true; };
    // Text edits within a step (subject/body typing) — no undo push, no step array replace
    const handleStepTextChange = useCallback((updated: CampaignStep) => {
        if (selectedIdx === null) return;
        setSteps(prev => {
            const next = [...prev];
            next[selectedIdx] = updated;
            return next;
        });
        isDirty.current = true;
    }, [selectedIdx]);

    // Browser beforeunload guard
    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => { if (isDirty.current) e.preventDefault(); };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);

    const saveMut = useMutation<string | undefined, unknown, void>({
        mutationFn: async () => {
            if (isNew) {
                const r = await api.post('/campaigns', { name, from_name: fromName, settings });
                const cid = r.data.data.id;
                if (steps.length) await api.put(`/campaigns/${cid}/steps`, { steps });
                return cid;
            }
            await api.put(`/campaigns/${id}`, { name, from_name: fromName, settings });
            await api.put(`/campaigns/${id}/steps`, { steps });
            return id;
        },
        onSuccess: (cid) => {
            isDirty.current = false;
            showSuccess(t('campaign.saved', 'Campaign saved'));
            qc.invalidateQueries({ queryKey: ['campaigns'] });
            if (isNew) navigate(`/campaigns/drip/${cid}/edit`, { replace: true });
            else qc.invalidateQueries({ queryKey: ['campaign', id] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    const activateMut = useMutation<unknown, unknown, void>({
        mutationFn: () => api.post(`/campaigns/${id}/activate`),
        onSuccess: () => { showSuccess(t('campaign.activated', 'Campaign activated')); qc.invalidateQueries({ queryKey: ['campaign', id] }); },
        onError: (err) => showErrorFromApi(err),
    });

    const pauseMut = useMutation<unknown, unknown, void>({
        mutationFn: () => api.post(`/campaigns/${id}/pause`),
        onSuccess: () => { showSuccess(t('campaign.paused', 'Campaign paused')); qc.invalidateQueries({ queryKey: ['campaign', id] }); },
        onError: (err) => showErrorFromApi(err),
    });

    const selectedStep = selectedIdx !== null ? steps[selectedIdx] : null;
    const isReadOnly = campaign?.status === 'active';
    const isDraft = !campaign || campaign.status === 'draft' || campaign.status === 'paused';
    const isActive = campaign?.status === 'active';

    if (!isNew && isLoading) return <Center py="xl"><Loader color="violet" /></Center>;

    return (
        <Container size="xl" py="md">
            <Stack gap="md">
                <Paper shadow="sm" radius="lg" p="lg" withBorder>
                    <Group justify="space-between">
                        <Group gap="sm">
                            <Button variant="subtle" color="gray" size="sm" leftSection={<IconArrowLeft size={16} />}
                                onClick={() => isDirty.current ? setConfirmLeave(true) : navigate('/campaigns')}>{t('campaign.editor.back', 'Back')}</Button>
                            <TextInput placeholder={t('campaign.editor.namePlaceholder', 'Campaign name...')} variant="unstyled" size="lg" fw={700}
                                value={name} onChange={(e) => setNameDirty(e.currentTarget.value)}
                                styles={{ input: { fontSize: '1.3rem', fontWeight: 700 } }} disabled={isReadOnly} />
                            {campaign && <Badge size="lg" variant="light" color={STATUS_COLORS[campaign.status]}>{campaign.status.toUpperCase()}</Badge>}
                        </Group>
                        <Group gap="xs">
                            <Button variant="default" radius="md" size="sm" leftSection={<IconDeviceFloppy size={16} />}
                                onClick={() => saveMut.mutate()} loading={saveMut.isPending} disabled={!name.trim() || isReadOnly}>{t('campaign.editor.save', 'Save')}</Button>
                            {!isNew && isDraft && (
                                <Button variant="gradient" gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }} radius="md" size="sm"
                                    leftSection={<IconPlayerPlay size={16} />} onClick={() => activateMut.mutate()} loading={activateMut.isPending}>{t('campaign.editor.activate', 'Activate')}</Button>
                            )}
                            {isActive && (
                                <Button variant="light" color="yellow" radius="md" size="sm"
                                    leftSection={<IconPlayerPause size={16} />} onClick={() => pauseMut.mutate()} loading={pauseMut.isPending}>{t('campaign.editor.pause', 'Pause')}</Button>
                            )}
                        </Group>
                    </Group>
                </Paper>

                <Tabs value={activeTab} onChange={setActiveTab} radius="md">
                    <Tabs.List>
                        <Tabs.Tab value="steps" leftSection={<IconList size={14} />}>{t('campaign.editor.tabSequence', 'Sequence')}</Tabs.Tab>
                        <Tabs.Tab value="enrollments" leftSection={<IconUsers size={14} />} disabled={isNew}>
                            {t('campaign.editor.tabAudience', 'Audience')} {campaign?.total_enrolled ? <Badge size="xs" variant="light" color="violet" ml={6}>{campaign.total_enrolled}</Badge> : null}
                        </Tabs.Tab>
                        <Tabs.Tab value="settings" leftSection={<IconSettings size={14} />}>{t('campaign.editor.tabSettings', 'Settings')}</Tabs.Tab>
                        <Tabs.Tab value="stats" leftSection={<IconChartBar size={14} />} disabled={isNew}>{t('campaign.editor.tabStats', 'Analytics')}</Tabs.Tab>
                    </Tabs.List>

                    <Tabs.Panel value="steps" pt="md">
                        <Grid>
                            <Grid.Col span={4}>
                                <Paper shadow="xs" radius="md" p="md" withBorder>
                                    <Text size="xs" fw={600} c="dimmed" mb="sm">{t('campaign.editor.steps', 'Steps')} ({steps.length})</Text>
                                    <SequenceTimeline steps={steps} onChange={setStepsDirty} onSelectStep={setSelectedIdx}
                                        selectedIndex={selectedIdx} readOnly={isReadOnly} />
                                </Paper>
                                {steps.length > 0 && (
                                    <Paper shadow="xs" radius="md" p="md" mt="sm" withBorder bg="gray.0">
                                        <Text size="xs" fw={600} c="dimmed" mb="xs">{t('campaign.editor.timelinePreview', 'Timeline')}</Text>
                                        {(() => {
                                            let cumDays = 0;
                                            return steps.map((s, i) => {
                                                // Wait-before: her adımın beklemesi kümülatif güne eklenir.
                                                cumDays += (s.delay_days || 0) + (s.delay_hours || 0) / 24;
                                                const label = cumDays === 0 ? t('campaign.editor.immediately', 'Immediately') : `${t('campaign.editor.day', 'Day')} ${Math.round(cumDays)}`;
                                                return <Text key={i} size="xs" c="dimmed"><Text span fw={600} c="violet">{label}:</Text> {s.subject || '(no subject)'}</Text>;
                                            });
                                        })()}
                                    </Paper>
                                )}
                            </Grid.Col>
                            <Grid.Col span={8}>
                                <Paper shadow="xs" radius="md" p="lg" withBorder mih={400}>
                                    {selectedStep ? (
                                        <StepEditor step={selectedStep} onChange={handleStepTextChange} readOnly={isReadOnly} isFirst={selectedIdx === 0} />
                                    ) : (
                                        <Center h={300}>
                                            <Text size="sm" c="dimmed">
                                                {steps.length === 0 ? t('campaign.editor.addFirstStep', 'Add your first step using the button on the left.') : t('campaign.editor.selectStep', 'Select a step to edit.')}
                                            </Text>
                                        </Center>
                                    )}
                                </Paper>
                            </Grid.Col>
                        </Grid>
                    </Tabs.Panel>

                    <Tabs.Panel value="enrollments" pt="md">
                        {id && <EnrollmentPanel campaignId={id} campaignStatus={campaign?.status || 'draft'} />}
                    </Tabs.Panel>

                    <Tabs.Panel value="settings" pt="md">
                        <CampaignSettingsPanel
                            fromName={fromName} onFromNameChange={setFromNameDirty}
                            settings={settings} onSettingsChange={setSettingsDirty}
                            readOnly={isReadOnly}
                        />
                    </Tabs.Panel>

                    <Tabs.Panel value="stats" pt="md">
                        {id && <CampaignStatsPanel campaignId={id} />}
                    </Tabs.Panel>
                </Tabs>
            </Stack>

            {/* Unsaved changes confirmation */}
            <Modal opened={confirmLeave} onClose={() => setConfirmLeave(false)}
                title={t('common.unsavedChangesTitle', 'Unsaved Changes')} radius="lg" centered size="sm"
                overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}>
                <Stack gap="md">
                    <Alert icon={<IconAlertCircle size={16} />} color="orange" variant="light">
                        <Text size="sm">{t('common.unsavedChanges', 'You have unsaved changes that will be lost.')}</Text>
                    </Alert>
                    <Group justify="flex-end">
                        <Button variant="default" radius="md" onClick={() => setConfirmLeave(false)}>
                            {t('common.stayEditing', 'Stay')}
                        </Button>
                        <Button color="red" radius="md" onClick={() => { isDirty.current = false; navigate('/campaigns'); }}>
                            {t('common.discardChanges', 'Discard')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Container>
    );
}
