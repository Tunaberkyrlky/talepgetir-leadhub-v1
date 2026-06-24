// Kampanya dizisinin graf modeli (görsel karar ağacı editörü).
// Faz 2 Batch 1: yalnız mevcut LİNEER adımları salt-okunur tuvalde göstermek için
// kullanılır (trigger → (bekle?) → mail zinciri). Düzenlenebilir graf + kalıcı
// kayıt sonraki batch'lerde gelir; o zaman node id'leri client-üretimi UUID olur.

import type { Node, Edge } from '@xyflow/react';
import type { CampaignStep } from '../types/campaign';

export type GraphNodeKind = 'trigger' | 'email' | 'wait' | 'condition' | 'split' | 'action';

export interface GraphNodeData {
    // email
    subject?: string | null;
    body_html?: string | null;
    body_text?: string | null;
    // wait
    delay_days?: number;
    delay_hours?: number;
    // condition (Batch 4)
    condition_type?: string;
    condition_wait_hours?: number;
    eval_step_order?: number;
    // split/action (Batch 5)
    config?: Record<string, unknown>;
    // Lineer adıma geri bağ — Batch 1'de seçili mail node'unu steps[stepIndex]'e eşler.
    stepIndex?: number;
    [key: string]: unknown;
}

export interface GraphNode {
    id: string;
    kind: GraphNodeKind;
    position: { x: number; y: number };
    data: GraphNodeData;
}

export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    sourceHandle?: string | null; // 'next' | 'true' | 'false' | varyant anahtarı
    label?: string;
}

// Düzenlenebilir grafta yeni node/edge için (Batch 3+). Batch 1 deterministik id kullanır.
export function newId(): string {
    return crypto.randomUUID();
}

const GAP_Y = 130;
const COL_X = 0;

// Lineer adım dizisini graf'a çevirir: trigger → (gecikme>0 ise Bekle node) → mail → …
// Ayrı Bekleme node modeli (kullanıcı tercihi): adımın delay'i ondan ÖNCE bir Bekle
// node'u olur. Batch 1 salt-okunur olduğu için id'ler DETERMİNİSTİK (her render aynı) —
// böylece useMemo ile yeniden üretilse de React Flow node kimliği ve seçim stabil kalır.
export function migrateLinearToGraph(steps: CampaignStep[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    let y = 0;

    nodes.push({ id: 'trigger', kind: 'trigger', position: { x: COL_X, y }, data: {} });
    let prevId = 'trigger';
    y += GAP_Y;

    steps.forEach((s, i) => {
        const dd = s.delay_days || 0;
        const dh = s.delay_hours || 0;
        if (dd > 0 || dh > 0) {
            const waitId = `wait-${i}`;
            nodes.push({ id: waitId, kind: 'wait', position: { x: COL_X, y }, data: { delay_days: dd, delay_hours: dh } });
            edges.push({ id: `e-${prevId}-${waitId}`, source: prevId, target: waitId, sourceHandle: 'next' });
            prevId = waitId;
            y += GAP_Y;
        }
        const nodeId = `step-${i}`;
        const kind: GraphNodeKind = s.step_type === 'condition' ? 'condition' : s.step_type === 'delay' ? 'wait' : 'email';
        // Konum: kullanıcı sürüklediyse config.pos'tan, yoksa otomatik dikey yerleşim.
        const pos = readPos(s);
        nodes.push({
            id: nodeId, kind, position: pos ?? { x: COL_X, y },
            data: { subject: s.subject, body_html: s.body_html, body_text: s.body_text, stepIndex: i },
        });
        edges.push({ id: `e-${prevId}-${nodeId}`, source: prevId, target: nodeId, sourceHandle: 'next' });
        prevId = nodeId;
        y += GAP_Y;
    });

    return { nodes, edges };
}

// Bir adımın kayıtlı tuval konumunu (config.pos) okur — yoksa undefined.
function readPos(step: CampaignStep): { x: number; y: number } | undefined {
    const p = (step.config as { pos?: { x: number; y: number } } | null | undefined)?.pos;
    return p && typeof p.x === 'number' && typeof p.y === 'number' ? p : undefined;
}

// ── Kayıt serileştirme: steps[] → {nodes} (save_campaign_graph RPC payload) ──
// Batch 4a: lineer zincir (next_step_id = sıradaki adım), ilk adım giriş. Stabil
// id'ler korunur (upsert) → eski delete+reinsert'in UUID churn'ü ortadan kalkar,
// böylece in-flight enrollment'ların current_step_id'si bozulmaz. config.pos saklanır.
export interface GraphSaveNode {
    id: string;
    step_type: string;
    step_kind: string;
    subject: string | null;
    body_html: string | null;
    body_text: string | null;
    delay_days: number;
    delay_hours: number;
    condition_type: string | null;
    condition_wait_hours: number | null;
    next_step_id: string | null;
    condition_true_step_id: string | null;
    condition_false_step_id: string | null;
    is_entry: boolean;
    step_order: number;
    config: Record<string, unknown>;
}

export function serializeStepsToNodes(steps: CampaignStep[]): GraphSaveNode[] {
    // Her adımın stabil bir id'si olmalı (ekleme yollarında newId() atanır; eski
    // kampanyalarda sunucudan gelir). Yine de eksikse burada üret — churn olmasın.
    const withIds = steps.map((s) => ({ ...s, id: s.id || newId() }));
    return withIds.map((s, i) => ({
        id: s.id,
        step_type: s.step_type,
        step_kind: s.step_kind || s.step_type,
        subject: s.subject ?? null,
        body_html: s.body_html ?? null,
        body_text: s.body_text ?? null,
        delay_days: s.delay_days || 0,
        delay_hours: s.delay_hours || 0,
        condition_type: s.condition_type ?? null,
        condition_wait_hours: s.condition_wait_hours ?? null,
        next_step_id: i < withIds.length - 1 ? withIds[i + 1].id : null,
        condition_true_step_id: s.condition_true_step_id ?? null,
        condition_false_step_id: s.condition_false_step_id ?? null,
        is_entry: i === 0,
        step_order: i + 1,
        config: (s.config as Record<string, unknown>) || {},
    }));
}

// Graf modelini React Flow node/edge'lerine çevirir. selectedStepIndex eşleşen mail
// node'una `selected` bayrağı koyar (custom node bu prop'a göre kendini vurgular).
export function toFlow(
    nodes: GraphNode[],
    edges: GraphEdge[],
    selectedStepIndex: number | null,
    editable = false,
): { nodes: Node[]; edges: Edge[] } {
    const flowNodes: Node[] = nodes.map((n) => ({
        id: n.id,
        type: n.kind,
        position: n.position,
        data: n.data,
        selected: n.data.stepIndex != null && n.data.stepIndex === selectedStepIndex,
        // Yalnız gerçek adım (mail) node'ları sürüklenebilir; trigger/bekle türevdir.
        draggable: editable && n.data.stepIndex != null,
        connectable: false,
    }));
    const flowEdges: Edge[] = edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        // 'next' lineer varsayılan handle'dır (id'siz) → sourceHandle göndermeyiz,
        // yoksa React Flow eşleşen handle bulamayıp kenarı düşürür (görünmez olur).
        // Adlı dallar (true/false/varyant) Batch 4b'de handle id'leriyle eşlenir.
        sourceHandle: e.sourceHandle && e.sourceHandle !== 'next' ? e.sourceHandle : undefined,
        label: e.label,
        type: 'smoothstep',
        animated: false,
    }));
    return { nodes: flowNodes, edges: flowEdges };
}
