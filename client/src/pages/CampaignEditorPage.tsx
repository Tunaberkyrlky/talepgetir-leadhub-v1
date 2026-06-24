import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Container, Paper, Group, Stack, Text, TextInput, Button, Badge, Grid, Tabs, Loader, Center, Modal, Alert, Tooltip, SegmentedControl, NumberInput,
} from '@mantine/core';
import {
    IconArrowLeft, IconDeviceFloppy, IconPlayerPause, IconChartBar, IconUsers, IconList, IconAlertCircle, IconSettings, IconSitemap, IconHourglass,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import SequenceTimeline from '../components/campaigns/SequenceTimeline';
import StepEditor from '../components/campaigns/StepEditor';
import ConditionInspector from '../components/campaigns/graph/ConditionInspector';
import EnrollmentPanel from '../components/campaigns/EnrollmentPanel';
import ActivationGuard from '../components/campaigns/ActivationGuard';
import CampaignStatsPanel from '../components/campaigns/CampaignStatsPanel';
import CampaignSettingsPanel from '../components/campaigns/CampaignSettingsPanel';
import type { Campaign, CampaignStep, CampaignSettings } from '../types/campaign';
import { newId, serializeStepsToNodes, relinkLinear, TRIGGER_ID } from '../lib/graph';

// Görsel tuval (React Flow) yalnız "Görsel" görünüme geçilince yüklensin — Basit
// görünümde editör chunk'ı hafif kalır (React Flow ayrı 'flow' chunk'ında).
const GraphEditor = lazy(() => import('../components/campaigns/graph/GraphEditor'));

const STATUS_COLORS: Record<string, string> = {
    draft: 'gray', active: 'green', paused: 'yellow', completed: 'blue',
};

export default function CampaignEditorPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const { t } = useTranslation();
    const { user } = useAuth();
    const qc = useQueryClient();
    const isNew = !id || id === 'new';

    const [name, setName] = useState('');
    const [steps, setSteps] = useState<CampaignStep[]>([]);
    const [fromName, setFromName] = useState('');
    const [settings, setSettings] = useState<CampaignSettings>({});
    const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
    const [stepsView, setStepsView] = useState<'simple' | 'visual'>('simple');
    const [activeTab, setActiveTab] = useState<string | null>('steps');
    const [confirmLeave, setConfirmLeave] = useState(false);
    const [hasUnsaved, setHasUnsaved] = useState(false);
    const [loadedId, setLoadedId] = useState<string | null>(null);
    const isDirty = useRef(false);

    // İlk değişiklikte "kaydedilmedi" göstergesini aç (her tuş basışında değil).
    const markDirty = useCallback(() => {
        if (!isDirty.current) setHasUnsaved(true);
        isDirty.current = true;
    }, []);

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

    // Sunucudan farklı bir kampanya yüklendiğinde düzenlenebilir state'i sıfırla.
    // Effect yerine render-anı reset (React'in "prop değişince state sıfırla" deseni):
    // arka plan refetch'i (aynı id) in-flight düzenlemeyi ezmez. Ref sıfırlamaları
    // render'da yapılamadığı için aşağıdaki effect'e taşındı.
    if (campaign && campaign.id !== loadedId) {
        setLoadedId(campaign.id);
        setName(campaign.name);
        setSteps(campaign.steps || []);
        setFromName(campaign.from_name || '');
        setSettings(campaign.settings || {});
        setHasUnsaved(false);
    }

    // Yeni kampanya yüklendiğinde dirty bayrağı + undo geçmişini sıfırla (ref → effect).
    useEffect(() => {
        isDirty.current = false;
        undoStack.current = [];
    }, [loadedId]);

    // Dirty tracking — text edits don't push undo (native undo handles those)
    const setNameDirty = (v: string) => { setName(v); markDirty(); };
    const setSettingsDirty = (s: CampaignSettings) => { setSettings(s); markDirty(); };
    // Structural changes (add/delete/reorder steps) push undo
    const setStepsDirty = (v: CampaignStep[]) => { pushUndo(); setSteps(v); markDirty(); };
    // Text edits within a step (subject/body typing) — kısmi patch ile birleştirilir.
    // Tam step yerine patch: zengin editörün stale-closure'ı konu/gecikme alanlarını ezmez.
    const handleStepTextChange = useCallback((patch: Partial<CampaignStep>) => {
        if (selectedIdx === null) return;
        setSteps(prev => {
            const next = [...prev];
            next[selectedIdx] = { ...next[selectedIdx], ...patch };
            return next;
        });
        markDirty();
    }, [selectedIdx, markDirty]);

    // Browser beforeunload guard
    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => { if (isDirty.current) e.preventDefault(); };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);

    const saveMut = useMutation<string | undefined, unknown, void>({
        mutationFn: async () => {
            // Stabil id'lerle {nodes} graf yolundan kaydet (upsert + prune): adım
            // UUID'leri korunur, in-flight enrollment'lar bozulmaz, konumlar saklanır.
            if (isNew) {
                const r = await api.post('/campaigns', { name, from_name: fromName, settings });
                const cid = r.data.data.id;
                if (steps.length) await api.put(`/campaigns/${cid}/steps`, { nodes: serializeStepsToNodes(steps) });
                return cid;
            }
            await api.put(`/campaigns/${id}`, { name, from_name: fromName, settings });
            if (steps.length) await api.put(`/campaigns/${id}/steps`, { nodes: serializeStepsToNodes(steps) });
            return id;
        },
        onSuccess: (cid) => {
            isDirty.current = false;
            setHasUnsaved(false);
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

    const testMut = useMutation<unknown, unknown, { to: string; subject: string; body_html: string }>({
        mutationFn: (p) => api.post(`/campaigns/${id}/test`, p),
        onSuccess: (_d, vars) => showSuccess(t('campaign.editor.testSent', { to: vars.to, defaultValue: 'Test sent to {{to}}' })),
        onError: (err) => showErrorFromApi(err),
    });

    // Görsel tuval düzenleme — SequenceTimeline ile aynı model (steps tek kaynak).
    // Yeni adım her zaman e-posta; ilk adım hemen (delay 0), sonrakiler 2 gün bekler.
    const addEmailStep = () => {
        const s: CampaignStep = {
            id: newId(), // stabil id → {nodes} kaydında upsert (UUID churn yok)
            step_order: steps.length + 1, step_type: 'email',
            subject: '', body_html: '', body_text: null,
            delay_days: 0, delay_hours: 0, // görsel: bekleme ayrı "Bekle" node'u ile eklenir
        };
        setStepsDirty([...steps, s]);
        setSelectedIdx(steps.length);
    };
    // Bağımsız Bekleme adımı (delay node) — sıradaki adıma geçmeden önce bekler.
    const addWaitStep = () => {
        const s: CampaignStep = {
            id: newId(),
            step_order: steps.length + 1, step_type: 'delay',
            subject: null, body_html: null, body_text: null,
            delay_days: 1, delay_hours: 0,
        };
        setStepsDirty([...steps, s]);
        setSelectedIdx(steps.length);
    };
    // Koşul (condition) adımı — sıraya eklenir; Evet/Hayır dalları başta "Diziyi bitir"
    // (null) olur, kullanıcı sağ panelden hedef seçer. Değerlendirilecek mail varsayılan
    // olarak en son e-posta adımıdır (config.eval_step_id, kayıtta step_order'a çevrilir).
    const addConditionStep = () => {
        const lastEmail = [...steps].reverse().find((s) => s.step_type === 'email');
        const s: CampaignStep = {
            id: newId(),
            step_order: steps.length + 1, step_type: 'condition',
            subject: null, body_html: null, body_text: null,
            delay_days: 0, delay_hours: 0,
            condition_type: 'opened', condition_wait_hours: 72,
            condition_true_step_id: null, condition_false_step_id: null,
            config: lastEmail?.id ? { eval_step_id: lastEmail.id } : {},
        };
        setStepsDirty([...steps, s]);
        setSelectedIdx(steps.length);
    };
    const deleteStep = (i: number) => {
        const deletedId = steps[i]?.id;
        // Silinen adıma işaret eden tüm yönlendirmeleri (koşul dalları, next, eval) temizle —
        // aksi halde kopuk pointer kalır (kayıtta "bilinmeyen node" doğrulama hatası).
        const updated = steps.filter((_, idx) => idx !== i).map((s, idx) => {
            const n: CampaignStep = { ...s, step_order: idx + 1 };
            if (deletedId) {
                if (n.condition_true_step_id === deletedId) n.condition_true_step_id = null;
                if (n.condition_false_step_id === deletedId) n.condition_false_step_id = null;
                if (n.next_step_id === deletedId) n.next_step_id = null;
                const cfg = n.config as Record<string, unknown> | null;
                if (cfg && cfg.eval_step_id === deletedId) n.config = { ...cfg, eval_step_id: undefined };
            }
            return n;
        });
        setStepsDirty(updated);
        if (selectedIdx === i) setSelectedIdx(updated.length ? Math.max(0, i - 1) : null);
    };
    // Tuvalde bağla: kaynak adımın pointer'ını hedefe yaz. Trigger → giriş adımı seçer.
    // handle: 'true'/'false' koşul dalı; null lineer next. Tek "next" olduğundan yeni
    // bağlantı eskisini OTOMATİK değiştirir (graf tek pointer'dan türetilir).
    const onConnectNodes = (sourceId: string, handle: string | null, targetId: string) => {
        pushUndo();
        setSteps((prev) => {
            if (sourceId === TRIGGER_ID) return prev.map((s) => ({ ...s, is_entry: s.id === targetId }));
            return prev.map((s) => {
                if (s.id !== sourceId) return s;
                if (handle === 'true') return { ...s, condition_true_step_id: targetId };
                if (handle === 'false') return { ...s, condition_false_step_id: targetId };
                return { ...s, next_step_id: targetId };
            });
        });
        markDirty();
    };
    // Bağlantıyı kopar: ilgili pointer'ı açıkça null (BİTİŞ) yap. Trigger→giriş koparılamaz.
    const onDisconnect = (sourceId: string, handle: string | null) => {
        if (sourceId === TRIGGER_ID) return;
        pushUndo();
        setSteps((prev) => prev.map((s) => {
            if (s.id !== sourceId) return s;
            if (handle === 'true') return { ...s, condition_true_step_id: null };
            if (handle === 'false') return { ...s, condition_false_step_id: null };
            return { ...s, next_step_id: null };
        }));
        markDirty();
    };
    // Tuvalde sürükleme → adımın konumunu config.pos'a yaz (undo'ya gerek yok, küçük).
    const onMoveStep = (i: number, pos: { x: number; y: number }) => {
        setSteps((prev) => {
            const next = [...prev];
            next[i] = { ...next[i], config: { ...(next[i].config as Record<string, unknown> | null), pos } };
            return next;
        });
        markDirty();
    };

    const selectedStep = selectedIdx !== null ? steps[selectedIdx] : null;
    const isReadOnly = campaign?.status === 'active';
    const isDraft = !campaign || campaign.status === 'draft' || campaign.status === 'paused';
    const isActive = campaign?.status === 'active';

    // Seçili adımın düzenleyicisi — Bekle (delay) adımı için gecikme formu, aksi
    // halde StepEditor. Hem Basit hem Görsel görünüm aynı düzenleyiciyi paylaşır.
    const inspectorBody = !selectedStep ? null : selectedStep.step_type === 'condition' ? (
        <ConditionInspector step={selectedStep} steps={steps} selectedIdx={selectedIdx as number}
            onChange={handleStepTextChange} readOnly={isReadOnly} />
    ) : selectedStep.step_type === 'delay' ? (
        <Stack gap="sm">
            <Group gap="xs" mb={4}>
                <IconHourglass size={16} color="var(--mantine-color-gray-6)" />
                <Text size="sm" fw={600}>{t('campaign.editor.graph.waitTitle', 'Wait')}</Text>
            </Group>
            <Text size="xs" c="dimmed">{t('campaign.editor.graph.waitNote', 'Pauses before moving on to the next step.')}</Text>
            <Group grow>
                <NumberInput label={t('campaign.editor.days', 'Days')} min={0} max={90} radius="md" size="sm"
                    value={selectedStep.delay_days || 0} onChange={(v) => handleStepTextChange({ delay_days: Number(v) || 0 })} disabled={isReadOnly} />
                <NumberInput label={t('campaign.editor.hours', 'Hours')} min={0} max={23} radius="md" size="sm"
                    value={selectedStep.delay_hours || 0} onChange={(v) => handleStepTextChange({ delay_hours: Number(v) || 0 })} disabled={isReadOnly} />
            </Group>
        </Stack>
    ) : (
        <StepEditor key={selectedIdx} step={selectedStep} onChange={handleStepTextChange} readOnly={isReadOnly} isFirst={selectedIdx === 0}
            onSendTest={!isNew && id ? (p) => testMut.mutateAsync(p).then(() => undefined) : undefined}
            defaultTestEmail={user?.email} />
    );

    if (!isNew && isLoading) return <Center py="xl"><Loader color="violet" /></Center>;

    return (
        <Container size="xl" pt="md" pb={160}>
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
                            <Tooltip label={t('campaign.editor.unsavedHint', 'You have unsaved changes')} disabled={!hasUnsaved} withArrow>
                                <Button variant={hasUnsaved && !isReadOnly ? 'filled' : 'default'} color={hasUnsaved && !isReadOnly ? 'violet' : 'gray'}
                                    radius="md" size="sm" leftSection={<IconDeviceFloppy size={16} />}
                                    onClick={() => saveMut.mutate()} loading={saveMut.isPending} disabled={!name.trim() || isReadOnly}>{t('campaign.editor.save', 'Save')}</Button>
                            </Tooltip>
                            {!isNew && isDraft && (
                                <ActivationGuard
                                    emailStepCount={steps.filter((s) => s.step_type === 'email').length}
                                    enrolledCount={campaign?.total_enrolled || 0}
                                    onActivate={() => activateMut.mutate()}
                                    loading={activateMut.isPending}
                                />
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
                    {isNew && (
                        <Text size="xs" c="dimmed" mt="xs" ml={4}>
                            {t('campaign.editor.saveFirstHint', 'Save the campaign to unlock the Audience and Analytics tabs.')}
                        </Text>
                    )}

                    <Tabs.Panel value="steps" pt="md">
                        <Group justify="space-between" mb="sm">
                            <Text size="xs" fw={600} c="dimmed">{t('campaign.editor.steps', 'Steps')} ({steps.length})</Text>
                            <SegmentedControl size="xs" value={stepsView} onChange={(v) => setStepsView(v as 'simple' | 'visual')}
                                data={[
                                    { value: 'simple', label: <Group gap={4} wrap="nowrap"><IconList size={12} />{t('campaign.editor.graph.simpleView', 'Simple')}</Group> },
                                    { value: 'visual', label: <Group gap={4} wrap="nowrap"><IconSitemap size={12} />{t('campaign.editor.graph.visualView', 'Visual')}</Group> },
                                ]} />
                        </Group>

                        {stepsView === 'simple' ? (
                            <Grid>
                                <Grid.Col span={4}>
                                    <Paper shadow="xs" radius="md" p="md" withBorder>
                                        <SequenceTimeline steps={steps} onChange={(v) => setStepsDirty(relinkLinear(v))} onSelectStep={setSelectedIdx}
                                            selectedIndex={selectedIdx} readOnly={isReadOnly} />
                                    </Paper>
                                </Grid.Col>
                                <Grid.Col span={8}>
                                    <Paper shadow="xs" radius="md" p="lg" withBorder mih={400}>
                                        {selectedStep ? inspectorBody : (
                                            <Center h={300}>
                                                <Text size="sm" c="dimmed">
                                                    {steps.length === 0 ? t('campaign.editor.addFirstStep', 'Add your first step using the button on the left.') : t('campaign.editor.selectStep', 'Select a step to edit.')}
                                                </Text>
                                            </Center>
                                        )}
                                    </Paper>
                                </Grid.Col>
                            </Grid>
                        ) : (
                            <Grid>
                                <Grid.Col span={8}>
                                    <Suspense fallback={<Center h={540}><Loader color="violet" /></Center>}>
                                        <GraphEditor steps={steps} selectedIndex={selectedIdx} onSelectStep={setSelectedIdx}
                                            readOnly={isReadOnly} onAddEmail={addEmailStep} onAddWait={addWaitStep} onAddCondition={addConditionStep}
                                            onDeleteStep={deleteStep} onMoveStep={onMoveStep}
                                            onConnectNodes={onConnectNodes} onDisconnect={onDisconnect} />
                                    </Suspense>
                                </Grid.Col>
                                <Grid.Col span={4}>
                                    <Paper shadow="xs" radius="md" p="lg" withBorder mih={400}>
                                        {selectedStep ? inspectorBody : (
                                            <Center h={300}>
                                                <Text size="sm" c="dimmed" ta="center">{t('campaign.editor.graph.selectNode', 'Select a node on the canvas to edit it.')}</Text>
                                            </Center>
                                        )}
                                    </Paper>
                                </Grid.Col>
                            </Grid>
                        )}
                    </Tabs.Panel>

                    <Tabs.Panel value="enrollments" pt="md">
                        {id && <EnrollmentPanel campaignId={id} campaignStatus={campaign?.status || 'draft'} />}
                    </Tabs.Panel>

                    <Tabs.Panel value="settings" pt="md">
                        <CampaignSettingsPanel
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
