// Görsel karar ağacı tuvali (React Flow). Batch 1: SALT-OKUNUR — mevcut lineer
// adımları trigger → (bekle?) → mail zinciri olarak gösterir, mail node'una
// tıklanınca sağdaki StepEditor'ı açar. Node ekleme/bağlama/silme sonraki batch'te.
import '@xyflow/react/dist/style.css';
import { useCallback, useMemo, type MouseEvent } from 'react';
import {
    ReactFlow, Background, Controls, MiniMap, Handle, Position, Panel,
    type Node, type NodeProps,
} from '@xyflow/react';
import { Paper, Text, Group, ThemeIcon, Button } from '@mantine/core';
import { IconMail, IconClock, IconBolt, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { migrateLinearToGraph, toFlow, type GraphNodeData } from '../../../lib/graph';
import type { CampaignStep } from '../../../types/campaign';

const HANDLE_STYLE = { width: 6, height: 6, background: 'var(--mantine-color-gray-4)', border: 'none' } as const;

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
    const subject = (d.subject || '').trim();
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
                    <div style={{ minWidth: 0 }}>
                        <Text size="xs" fw={600} c="violet.7">{t('campaign.editor.graph.email', 'Email')}</Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>{subject || t('campaign.editor.graph.untitled', '(no subject)')}</Text>
                    </div>
                </Group>
            </Paper>
            <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
        </div>
    );
}

function WaitNode({ data }: NodeProps) {
    const { t } = useTranslation();
    const d = data as GraphNodeData;
    const days = d.delay_days || 0;
    const hours = d.delay_hours || 0;
    const parts: string[] = [];
    if (days) parts.push(`${days}${t('campaign.editor.graph.dayShort', 'd')}`);
    if (hours) parts.push(`${hours}${t('campaign.editor.graph.hourShort', 'h')}`);
    const dur = parts.join(' ') || '0';
    return (
        <div style={{ width: 160 }}>
            <Handle type="target" position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
            <Paper withBorder radius="xl" px="sm" py={6}>
                <Group gap={6} wrap="nowrap" justify="center">
                    <IconClock size={13} color="var(--mantine-color-gray-6)" />
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
    onDeleteStep?: (i: number) => void;
}

export default function GraphEditor({ steps, selectedIndex, onSelectStep, readOnly, onAddEmail, onDeleteStep }: Props) {
    const { t } = useTranslation();
    const graph = useMemo(() => migrateLinearToGraph(steps), [steps]);
    const { nodes, edges } = useMemo(
        () => toFlow(graph.nodes, graph.edges, selectedIndex),
        [graph, selectedIndex],
    );

    const onNodeClick = useCallback((_e: MouseEvent, node: Node) => {
        const idx = (node.data as GraphNodeData).stepIndex;
        if (typeof idx === 'number') onSelectStep(idx);
    }, [onSelectStep]);

    return (
        <div style={{ height: 540, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--mantine-color-gray-3)' }}>
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                onNodeClick={onNodeClick}
                nodesDraggable={false}
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
