// Görsel karar ağacı tuvali (React Flow). Mevcut adımları trigger → (bekle?) →
// mail zinciri olarak gösterir; node'a tıklanınca sağdaki düzenleyici açılır.
// Mail/Bekle ekleme, sürükle-konum ve silme araç çubuğundan yapılır.
import '@xyflow/react/dist/style.css';
import { useCallback, useMemo, useState } from 'react';
import {
    ReactFlow, Background, Controls, MiniMap, Handle, Position, Panel, applyNodeChanges,
    type Node, type NodeProps, type NodeMouseHandler, type OnNodeDrag, type OnNodesChange,
} from '@xyflow/react';
import { Paper, Text, Group, ThemeIcon, Button } from '@mantine/core';
import { IconMail, IconBolt, IconPlus, IconTrash, IconAlertTriangle, IconHourglass } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { migrateLinearToGraph, toFlow, type GraphNodeData } from '../../../lib/graph';
import type { CampaignStep } from '../../../types/campaign';

const HANDLE_STYLE = { width: 6, height: 6, background: 'var(--mantine-color-gray-4)', border: 'none' } as const;

// Önizlemede spintax'ın ilk seçeneğini gösterir (ham {{random|...}} yerine stabil metin).
function resolveSpintaxFirst(text: string): string {
    return text.replace(/\{\{\s*random\s*\|((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/gi, (_m, g: string) => (g.split('|')[0] || '').trim());
}

// ── Custom node'lar (Mantine temalı) ───────────────────────────────────────
function TriggerNode() {
    const { t } = useTranslation();
    return (
        <div style={{ width: 190 }}>
            <Paper withBorder radius="md" p="sm" bg="teal.0" style={{ borderColor: 'var(--mantine-color-teal-3)' }}>
                <Group gap={8} wrap="nowrap">
                    <ThemeIcon size="sm" radius="xl" color="teal"><IconBolt size={14} /></ThemeIcon>
                    <div>
                        <Text size="xs" fw={700} c="teal.8">{t('campaign.editor.graph.entry', 'Entry')}</Text>
                        <Text size="xs" c="teal.7">{t('campaign.editor.graph.entryDesc', 'Contacts enter here')}</Text>
                    </div>
                </Group>
            </Paper>
            <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
        </div>
    );
}

function EmailNode({ data, selected }: NodeProps) {
    const { t } = useTranslation();
    const d = data as GraphNodeData;
    const subject = resolveSpintaxFirst((d.subject || '').trim());
    const isEmpty = !subject && !(d.body_html || '').trim();
    return (
        <div style={{ width: 210 }}>
            <Handle type="target" position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
            <Paper withBorder radius="md" p="sm" shadow={selected ? 'md' : 'xs'}
                style={{
                    borderColor: selected ? 'var(--mantine-color-violet-5)' : 'var(--mantine-color-gray-3)',
                    borderWidth: selected ? 2 : 1, cursor: 'pointer',
                }}>
                <Group gap={8} wrap="nowrap">
                    <ThemeIcon size="sm" radius="md" variant="light" color="violet"><IconMail size={14} /></ThemeIcon>
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <Text size="xs" fw={600} c="violet.7">{t('campaign.editor.graph.email', 'Email')}</Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>{subject || t('campaign.editor.graph.untitled', '(no subject)')}</Text>
                    </div>
                    {isEmpty && (
                        <ThemeIcon size="sm" radius="md" variant="light" color="orange" title={t('campaign.editor.emptyStep', 'Subject or body is empty')}>
                            <IconAlertTriangle size={13} />
                        </ThemeIcon>
                    )}
                </Group>
            </Paper>
            <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
        </div>
    );
}

function WaitNode({ data, selected }: NodeProps) {
    const { t } = useTranslation();
    const d = data as GraphNodeData;
    const days = d.delay_days || 0;
    const hours = d.delay_hours || 0;
    const parts: string[] = [];
    if (days) parts.push(`${days} ${t('campaign.editor.graph.dayUnit', 'd')}`);
    if (hours) parts.push(`${hours} ${t('campaign.editor.graph.hourUnit', 'h')}`);
    const dur = parts.join(' ') || '—';
    const editable = !d.derived; // bağımsız bekle adımı → seçilebilir/vurgulanabilir
    return (
        <div style={{ width: 170 }}>
            <Handle type="target" position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
            <Paper withBorder radius="xl" px="sm" py={6}
                style={{
                    borderColor: selected ? 'var(--mantine-color-gray-6)' : 'var(--mantine-color-gray-3)',
                    borderWidth: selected ? 2 : 1,
                    cursor: editable ? 'pointer' : 'default',
                    background: editable ? undefined : 'var(--mantine-color-gray-0)',
                }}>
                <Group gap={6} wrap="nowrap" justify="center">
                    <IconHourglass size={13} color="var(--mantine-color-gray-6)" />
                    <Text size="xs" c="dimmed" fw={500}>{t('campaign.editor.graph.wait', 'Wait')} {dur}</Text>
                </Group>
            </Paper>
            <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
        </div>
    );
}

// Stabil referans — React Flow her render'da yeni nodeTypes nesnesi uyarısı vermesin.
const NODE_TYPES = { trigger: TriggerNode, email: EmailNode, wait: WaitNode };

interface Props {
    steps: CampaignStep[];
    selectedIndex: number | null;
    onSelectStep: (i: number) => void;
    readOnly?: boolean;
    onAddEmail?: () => void;
    onAddWait?: () => void;
    onDeleteStep?: (i: number) => void;
    onMoveStep?: (i: number, pos: { x: number; y: number }) => void;
}

export default function GraphEditor({ steps, selectedIndex, onSelectStep, readOnly, onAddEmail, onAddWait, onDeleteStep, onMoveStep }: Props) {
    const { t } = useTranslation();
    const graph = useMemo(() => migrateLinearToGraph(steps), [steps]);
    const flow = useMemo(
        () => toFlow(graph.nodes, graph.edges, selectedIndex, !readOnly),
        [graph, selectedIndex, readOnly],
    );

    // React Flow düğümlerini yerel state'te tut → sürükleme sırasında konum CANLI
    // güncellensin. (Kontrollü modda onNodesChange uygulanmazsa node imlece uymaz,
    // doğrudan son noktaya ışınlanır.) Türetilen graf (steps/seçim/readOnly) değişince
    // state'i tazele — render-anı state-guard (effect değil, sürüklemeyi kesmez).
    const [rfNodes, setRfNodes] = useState<Node[]>(flow.nodes);
    const [syncedFlow, setSyncedFlow] = useState(flow);
    if (flow !== syncedFlow) {
        setSyncedFlow(flow);
        setRfNodes(flow.nodes);
    }
    const onNodesChange = useCallback<OnNodesChange>((changes) => {
        setRfNodes((nds) => applyNodeChanges(changes, nds));
    }, []);

    const onNodeClick = useCallback<NodeMouseHandler>((_e, node) => {
        const idx = (node.data as GraphNodeData).stepIndex;
        if (typeof idx === 'number') onSelectStep(idx);
    }, [onSelectStep]);

    // Sürükleme bitince adımın konumunu (config.pos) kaydet — yeniden açılışta korunur.
    const onNodeDragStop = useCallback<OnNodeDrag>((_e, node) => {
        const idx = (node.data as GraphNodeData).stepIndex;
        if (typeof idx === 'number') onMoveStep?.(idx, { x: Math.round(node.position.x), y: Math.round(node.position.y) });
    }, [onMoveStep]);

    return (
        <div style={{ height: 540, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--mantine-color-gray-3)' }}>
            <ReactFlow
                nodes={rfNodes}
                edges={flow.edges}
                nodeTypes={NODE_TYPES}
                onNodesChange={onNodesChange}
                onNodeClick={onNodeClick}
                onNodeDragStop={onNodeDragStop}
                nodesDraggable={!readOnly}
                nodesConnectable={false}
                elementsSelectable={false}
                fitView
                fitViewOptions={{ padding: 0.25 }}
                minZoom={0.3}
                maxZoom={1.5}
            >
                {!readOnly && onAddEmail && (
                    <Panel position="top-left">
                        <Group gap="xs" p={6} bg="white" style={{ borderRadius: 8, boxShadow: '0 1px 6px rgba(0,0,0,0.08)' }}>
                            <Button size="xs" variant="light" color="violet" leftSection={<IconPlus size={14} />} onClick={onAddEmail}>
                                {t('campaign.editor.addEmailStep', 'Add email step')}
                            </Button>
                            {onAddWait && (
                                <Button size="xs" variant="light" color="gray" leftSection={<IconHourglass size={14} />} onClick={onAddWait}>
                                    {t('campaign.editor.graph.addWait', 'Add wait')}
                                </Button>
                            )}
                            <Button size="xs" variant="light" color="red" leftSection={<IconTrash size={14} />}
                                disabled={selectedIndex === null}
                                onClick={() => { if (selectedIndex !== null) onDeleteStep?.(selectedIndex); }}>
                                {t('campaign.editor.graph.deleteNode', 'Delete')}
                            </Button>
                        </Group>
                    </Panel>
                )}
                <Background gap={16} color="var(--mantine-color-gray-3)" />
                <Controls showInteractive={false} />
                <MiniMap pannable zoomable nodeStrokeWidth={2} />
            </ReactFlow>
        </div>
    );
}
