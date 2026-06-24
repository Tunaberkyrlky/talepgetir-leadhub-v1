// Görsel karar ağacı tuvali (React Flow). Mevcut adımları trigger → (bekle?) →
// mail zinciri olarak gösterir; node'a tıklanınca sağdaki düzenleyici açılır.
// Mail/Bekle ekleme, sürükle-konum ve silme araç çubuğundan yapılır.
import '@xyflow/react/dist/style.css';
import { useCallback, useMemo, useState } from 'react';
import {
    ReactFlow, Background, Controls, MiniMap, Handle, Position, Panel, applyNodeChanges,
    BaseEdge, EdgeLabelRenderer, getSmoothStepPath,
    type Node, type NodeProps, type EdgeProps, type NodeMouseHandler, type OnNodeDrag, type OnNodesChange, type OnConnect,
} from '@xyflow/react';
import { Paper, Text, Group, ThemeIcon, Button } from '@mantine/core';
import { IconMail, IconBolt, IconPlus, IconTrash, IconAlertTriangle, IconHourglass, IconGitBranch } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { migrateLinearToGraph, toFlow, type GraphNodeData } from '../../../lib/graph';
import type { CampaignStep } from '../../../types/campaign';

// Bağlantı noktaları — bilerek büyük/belirgin: oradan kolayca "line alıp" bağlamak için.
const HANDLE_STYLE = { width: 13, height: 13, background: 'var(--mantine-color-gray-5)', border: '2px solid white', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' } as const;

// Önizlemede spintax'ın ilk seçeneğini gösterir (ham {{random|...}} yerine stabil metin).
function resolveSpintaxFirst(text: string): string {
    return text.replace(/\{\{\s*random\s*\|((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/gi, (_m, g: string) => (g.split('|')[0] || '').trim());
}

// ── Custom node'lar (Mantine temalı) ───────────────────────────────────────
function TriggerNode({ isConnectable }: NodeProps) {
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
            <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={isConnectable} />
        </div>
    );
}

function EmailNode({ data, selected, isConnectable }: NodeProps) {
    const { t } = useTranslation();
    const d = data as GraphNodeData;
    const subject = resolveSpintaxFirst((d.subject || '').trim());
    const name = (d.name || '').trim();
    const isEmpty = !subject && !(d.body_html || '').trim();
    // Konu yerine adım adını göster; ad yoksa konuya, o da yoksa "(konusuz)"ya düş.
    const primary = name || subject || t('campaign.editor.graph.untitled', '(no subject)');
    return (
        <div style={{ width: 210 }}>
            <Handle type="target" position={Position.Top} style={HANDLE_STYLE} isConnectable={isConnectable} />
            <Paper withBorder radius="md" p="sm" shadow={selected ? 'md' : 'xs'}
                style={{
                    borderColor: selected ? 'var(--mantine-color-violet-5)' : 'var(--mantine-color-gray-3)',
                    borderWidth: selected ? 2 : 1, cursor: 'pointer',
                }}>
                <Group gap={8} wrap="nowrap">
                    <ThemeIcon size="sm" radius="md" variant="light" color="violet"><IconMail size={14} /></ThemeIcon>
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <Text size="xs" fw={600} c="violet.7">{t('campaign.editor.graph.email', 'Email')}</Text>
                        <Text size="xs" lineClamp={1} c={name ? 'dark' : 'dimmed'} fw={name ? 500 : 400}>{primary}</Text>
                    </div>
                    {isEmpty && (
                        <ThemeIcon size="sm" radius="md" variant="light" color="orange" title={t('campaign.editor.emptyStep', 'Subject or body is empty')}>
                            <IconAlertTriangle size={13} />
                        </ThemeIcon>
                    )}
                </Group>
            </Paper>
            <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={isConnectable} />
        </div>
    );
}

function WaitNode({ data, selected, isConnectable }: NodeProps) {
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
            <Handle type="target" position={Position.Top} style={HANDLE_STYLE} isConnectable={isConnectable} />
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
            <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={isConnectable} />
        </div>
    );
}

// Koşul node'u — açılma/tıklama/yanıt olayına göre iki dala (Evet/Hayır) ayrılır.
// İki çıkış handle'ı (id 'true'/'false') alt köşelerde; kenarlar bunlara bağlanır.
function ConditionNode({ data, selected, isConnectable }: NodeProps) {
    const { t } = useTranslation();
    const d = data as GraphNodeData;
    const ct = d.condition_type || 'opened';
    const wait = d.condition_wait_hours ?? 72;
    const ctLabel = t(`campaign.editor.graph.ct.${ct}`, ct);
    return (
        <div style={{ width: 210 }}>
            <Handle type="target" position={Position.Top} style={HANDLE_STYLE} isConnectable={isConnectable} />
            <Paper withBorder radius="md" p="sm" shadow={selected ? 'md' : 'xs'}
                style={{
                    borderColor: selected ? 'var(--mantine-color-yellow-6)' : 'var(--mantine-color-yellow-3)',
                    borderWidth: selected ? 2 : 1, cursor: 'pointer', background: 'var(--mantine-color-yellow-0)',
                }}>
                <Group gap={8} wrap="nowrap">
                    <ThemeIcon size="sm" radius="md" variant="light" color="yellow"><IconGitBranch size={14} /></ThemeIcon>
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <Text size="xs" fw={600} c="yellow.8">{t('campaign.editor.graph.condition', 'Condition')}</Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>{ctLabel} · {wait}{t('campaign.editor.graph.hourUnit', 'h')}</Text>
                    </div>
                </Group>
            </Paper>
            {/* İki çıkış: sol Evet (yeşil), sağ Hayır (kırmızı). Etiketler handle'ların altında. */}
            <Handle id="true" type="source" position={Position.Bottom} isConnectable={isConnectable}
                style={{ ...HANDLE_STYLE, left: '28%', background: 'var(--mantine-color-teal-5)' }} />
            <Handle id="false" type="source" position={Position.Bottom} isConnectable={isConnectable}
                style={{ ...HANDLE_STYLE, left: '72%', background: 'var(--mantine-color-red-5)' }} />
            <Group justify="space-between" gap={0} px={4} mt={2} wrap="nowrap">
                <Text fz={9} c="teal.7" fw={600}>{t('campaign.editor.graph.branchTrue', 'Yes')}</Text>
                <Text fz={9} c="red.7" fw={600}>{t('campaign.editor.graph.branchFalse', 'No')}</Text>
            </Group>
        </div>
    );
}

// Stabil referans — React Flow her render'da yeni nodeTypes nesnesi uyarısı vermesin.
const NODE_TYPES = { trigger: TriggerNode, email: EmailNode, wait: WaitNode, condition: ConditionNode };

// ── Özel kenar: orta noktada bir "sil ✕" butonu taşır ───────────────────────
// Bağlantıyı koparmak için kullanıcı butona tıklar → data.onDelete (kaynak adımın
// pointer'ını null'lar). Yapısal kenarlarda (adım-içi bekle, trigger→giriş) onDelete
// enjekte edilmez → buton görünmez.
function EditableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps) {
    const { t } = useTranslation();
    const [hovered, setHovered] = useState(false);
    const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
    const onDelete = (data as { onDelete?: () => void } | undefined)?.onDelete;
    // Hover'da çizgiyi kalınlaştır (geri bildirim). style undefined ise RF varsayılanı.
    const edgeStyle = { ...style, strokeWidth: hovered ? 2.5 : (style as { strokeWidth?: number } | undefined)?.strokeWidth };
    return (
        <>
            <BaseEdge id={id} path={path} markerEnd={markerEnd} style={edgeStyle} />
            {onDelete && (
                <>
                    {/* Geniş görünmez yakalama yolu — kenarın üstüne gelince ×'i tetikler. */}
                    <path d={path} fill="none" stroke="transparent" strokeWidth={26}
                        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                        onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} />
                    {hovered && (
                        <EdgeLabelRenderer>
                            <button
                                className="nodrag nopan"
                                title={t('campaign.editor.graph.removeEdge', 'Remove connection')}
                                onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
                                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                                style={{
                                    position: 'absolute',
                                    transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                                    pointerEvents: 'all', width: 20, height: 20, borderRadius: '50%',
                                    border: '1px solid var(--mantine-color-red-3)', background: 'white',
                                    color: 'var(--mantine-color-red-6)', cursor: 'pointer', padding: 0,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontSize: 14, lineHeight: 1, boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                                }}
                            >×</button>
                        </EdgeLabelRenderer>
                    )}
                </>
            )}
        </>
    );
}

const EDGE_TYPES = { editable: EditableEdge };

interface Props {
    steps: CampaignStep[];
    selectedIndex: number | null;
    onSelectStep: (i: number) => void;
    readOnly?: boolean;
    onAddEmail?: () => void;
    onAddWait?: () => void;
    onAddCondition?: () => void;
    onDeleteStep?: (i: number) => void;
    onMoveStep?: (i: number, pos: { x: number; y: number }) => void;
    // Tuvalde bağla: kaynak node id'sinden (adım UUID'si veya 'trigger') hedef adıma kenar.
    // handle: 'true'/'false' (koşul dalı) veya null (lineer next / giriş).
    onConnectNodes?: (sourceId: string, handle: string | null, targetId: string) => void;
    // Bağlantıyı kopar: kaynak node id'si + handle → ilgili pointer null'lanır.
    onDisconnect?: (sourceId: string, handle: string | null) => void;
}

export default function GraphEditor({ steps, selectedIndex, onSelectStep, readOnly, onAddEmail, onAddWait, onAddCondition, onDeleteStep, onMoveStep, onConnectNodes, onDisconnect }: Props) {
    const { t } = useTranslation();
    const graph = useMemo(() => migrateLinearToGraph(steps), [steps]);
    const flow = useMemo(
        () => toFlow(graph.nodes, graph.edges, selectedIndex, !readOnly),
        [graph, selectedIndex, readOnly],
    );

    // Silinebilir kenarlara "sil" geri-çağrısını enjekte et (EditableEdge butonu kullanır).
    const rfEdges = useMemo(
        () => flow.edges.map((e) => (
            e.deletable
                ? { ...e, data: { ...e.data, onDelete: () => onDisconnect?.(e.source, (e.sourceHandle as string | undefined) ?? null) } }
                : e
        )),
        [flow.edges, onDisconnect],
    );

    // Kullanıcı bir handle'dan diğerine sürükleyince yeni bağlantı (kaynak adımın pointer'ı).
    const onConnect = useCallback<OnConnect>((c) => {
        if (!c.source || !c.target || c.source === c.target) return;
        onConnectNodes?.(c.source, c.sourceHandle ?? null, c.target);
    }, [onConnectNodes]);

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
                edges={rfEdges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                onNodesChange={onNodesChange}
                onNodeClick={onNodeClick}
                onNodeDragStop={onNodeDragStop}
                onConnect={onConnect}
                nodesDraggable={!readOnly}
                nodesConnectable={!readOnly}
                elementsSelectable={false}
                deleteKeyCode={null}
                connectionRadius={48}
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
                            {onAddCondition && (
                                <Button size="xs" variant="light" color="yellow" leftSection={<IconGitBranch size={14} />} onClick={onAddCondition}>
                                    {t('campaign.editor.graph.addCondition', 'Add condition')}
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
                {!readOnly && (
                    <Panel position="bottom-center">
                        <Text fz={10} c="dimmed" px="xs" py={2}
                            style={{ background: 'rgba(255,255,255,0.85)', borderRadius: 6 }}>
                            {t('campaign.editor.graph.connectHint', 'Drag from a node’s dot to another node to connect; hover a line and click × to disconnect.')}
                        </Text>
                    </Panel>
                )}
                <Background gap={16} color="var(--mantine-color-gray-3)" />
                <Controls showInteractive={false} />
                <MiniMap pannable zoomable nodeStrokeWidth={2} />
            </ReactFlow>
        </div>
    );
}
