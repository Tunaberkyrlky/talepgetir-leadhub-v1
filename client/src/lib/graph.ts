// Kampanya dizisinin graf modeli (görsel karar ağacı editörü).
// Faz 2 Batch 1: yalnız mevcut LİNEER adımları salt-okunur tuvalde göstermek için
// kullanılır (trigger → (bekle?) → mail zinciri). Düzenlenebilir graf + kalıcı
// kayıt sonraki batch'lerde gelir; o zaman node id'leri client-üretimi UUID olur.

import type { Node, Edge, MarkerType } from '@xyflow/react';
import type { CampaignStep } from '../types/campaign';

export type GraphNodeKind = 'trigger' | 'email' | 'wait' | 'condition' | 'split' | 'action';

export interface GraphNodeData {
    // email
    name?: string | null; // kullanıcı verdiği adım adı (config.name) — node'da konunun yerine gösterilir
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
    // Lineer adıma geri bağ — seçili mail node'unu steps[stepIndex]'e eşler.
    stepIndex?: number;
    // Türev bekle node'u (mail'in satır-içi gecikmesinden üretilmiş, düzenlenemez).
    derived?: boolean;
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
export const TRIGGER_ID = 'trigger';

// Bir adımın React Flow node id'si = stabil step.id (UUID). Böylece tuvaldeki
// bağla/kopar (onConnect/edge sil) doğrudan adımın pointer'ına eşlenir — ayrı bir
// kenar tablosu gerekmez. id yoksa (taze, kaydedilmemiş) indeks tabanlı yedek.
export function nodeIdOf(s: CampaignStep, i: number): string {
    return s.id || `n${i}`;
}

// Bir non-condition adımın sıradaki adımını çözer: açık next_step_id ÖNCELİKLİ
// (string = hedef, null = açıkça BİTİŞ); TANIMSIZ (taze adım) ise lineer yedek
// (dizideki bir sonraki adım). serialize ve migrate AYNI mantığı kullanır → tuval
// ile kaydedilen graf birebir tutarlı.
export function resolveLinearNext(steps: CampaignStep[], i: number): string | null {
    const s = steps[i];
    if (s.next_step_id !== undefined) return s.next_step_id; // açık (hedef veya BİTİŞ=null)
    const nx = steps[i + 1];
    return nx ? nodeIdOf(nx, i + 1) : null; // tanımsız → lineer yedek
}

// Giriş adımının indeksi: is_entry işaretli adım, yoksa ilk adım.
function entryIndex(steps: CampaignStep[]): number {
    const e = steps.findIndex((s) => s.is_entry);
    return e >= 0 ? e : (steps.length ? 0 : -1);
}

// Adım dizisini graf'a çevirir: trigger → giriş → açık pointer'lara göre kenarlar.
// Routing tek kaynak = adımların pointer'ları (next_step_id / condition_true/false_step_id);
// dizi sırası yalnız step_order (sabit sıra) ve lineer yedek içindir, yönlendirme DEĞİL.
export function migrateLinearToGraph(steps: CampaignStep[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    let y = 0;

    nodes.push({ id: TRIGGER_ID, kind: 'trigger', position: { x: COL_X, y }, data: {} });
    y += GAP_Y;

    // stepId → indeks ve stepId → görsel "giriş" node'u (türev bekle varsa o, yoksa adım).
    const indexOfId = new Map<string, number>();
    const entryNodeOf = new Map<string, string>(); // gelen kenarın bağlanacağı node
    steps.forEach((s, i) => indexOfId.set(nodeIdOf(s, i), i));

    // 1. geçiş — node'lar + adım-içi türev bekle kenarı.
    steps.forEach((s, i) => {
        const dd = s.delay_days || 0;
        const dh = s.delay_hours || 0;
        const pos = readPos(s);
        const nodeId = nodeIdOf(s, i);
        let entryId = nodeId;

        if (s.step_type === 'email') {
            // Mail'in satır-içi "önce bekle" gecikmesi → TÜREVİ bekle node'u (düzenlenemez).
            if (dd > 0 || dh > 0) {
                const waitId = `dw-${nodeId}`;
                nodes.push({ id: waitId, kind: 'wait', position: { x: COL_X, y }, data: { delay_days: dd, delay_hours: dh, derived: true } });
                edges.push({ id: `e-${waitId}-${nodeId}`, source: waitId, target: nodeId }); // bekle → mail (adım-içi)
                entryId = waitId;
                y += GAP_Y;
            }
            nodes.push({
                id: nodeId, kind: 'email', position: pos ?? { x: COL_X, y },
                data: { name: stepName(s), subject: s.subject, body_html: s.body_html, body_text: s.body_text, stepIndex: i },
            });
        } else if (s.step_type === 'condition') {
            nodes.push({
                id: nodeId, kind: 'condition', position: pos ?? { x: COL_X, y },
                data: { condition_type: s.condition_type ?? 'opened', condition_wait_hours: s.condition_wait_hours ?? 72, config: (s.config as Record<string, unknown>) ?? undefined, stepIndex: i },
            });
        } else {
            nodes.push({
                id: nodeId, kind: 'wait', position: pos ?? { x: COL_X, y },
                data: { delay_days: dd, delay_hours: dh, stepIndex: i },
            });
        }

        entryNodeOf.set(nodeId, entryId);
        y += GAP_Y;
    });

    // Bir adım id'sini görsel giriş node'una çevirir (yoksa undefined → kenar çizilmez).
    const targetNodeOf = (stepId: string | null | undefined): string | undefined => {
        if (!stepId) return undefined;
        const idx = indexOfId.get(stepId);
        if (idx == null) return undefined;
        return entryNodeOf.get(nodeIdOf(steps[idx], idx));
    };

    // Trigger → giriş adımı.
    const eIdx = entryIndex(steps);
    if (eIdx >= 0) {
        const eNode = targetNodeOf(nodeIdOf(steps[eIdx], eIdx));
        if (eNode) edges.push({ id: `e-${TRIGGER_ID}-${eNode}`, source: TRIGGER_ID, target: eNode });
    }

    // 2. geçiş — adımların çıkış kenarları (açık pointer / koşul dalları).
    steps.forEach((s, i) => {
        const nodeId = nodeIdOf(s, i);
        if (s.step_type === 'condition') {
            const tT = targetNodeOf(s.condition_true_step_id);
            const tF = targetNodeOf(s.condition_false_step_id);
            if (tT) edges.push({ id: `e-${nodeId}-true`, source: nodeId, sourceHandle: 'true', target: tT });
            if (tF) edges.push({ id: `e-${nodeId}-false`, source: nodeId, sourceHandle: 'false', target: tF });
        } else {
            const tN = targetNodeOf(resolveLinearNext(steps, i));
            if (tN) edges.push({ id: `e-${nodeId}-next`, source: nodeId, target: tN });
        }
    });

    return { nodes, edges };
}

// Dizideki adımları lineer zincire bağlar (next_step_id = sıradaki adım, son = null).
// Basit görünüm (SequenceTimeline) sıralama/ekleme/silme yaptığında çağrılır: o görünüm
// doğası gereği lineerdir, bu yüzden açık pointer'ları sıraya göre tazeler (eski/bayat
// pointer kalmaz). Koşul next_step_id'si downstream'de yok sayılır (true/false kullanılır).
export function relinkLinear(steps: CampaignStep[]): CampaignStep[] {
    const withIds = steps.map((s) => ({ ...s, id: s.id || newId() }));
    return withIds.map((s, i) => ({ ...s, next_step_id: i < withIds.length - 1 ? withIds[i + 1].id : null }));
}

// Bir adımın kayıtlı tuval konumunu (config.pos) okur — yoksa undefined.
function readPos(step: CampaignStep): { x: number; y: number } | undefined {
    const p = (step.config as { pos?: { x: number; y: number } } | null | undefined)?.pos;
    return p && typeof p.x === 'number' && typeof p.y === 'number' ? p : undefined;
}

// Adımın kullanıcı verdiği adı (config.name). Boş/yoksa null — çağıran konuya düşer.
export function stepName(step: CampaignStep): string | null {
    const n = (step.config as { name?: string } | null | undefined)?.name;
    return n && n.trim() ? n.trim() : null;
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
    // Adım id → kayıttaki step_order (1-tabanlı). Koşulun "hangi maili kontrol et"
    // referansı (config.eval_step_id) bu haritayla motorun okuduğu eval_step_order'a çevrilir.
    const orderOf = new Map<string, number>();
    withIds.forEach((s, i) => orderOf.set(s.id, i + 1));
    const eIdx = entryIndex(withIds); // tam olarak bir giriş (is_entry işaretli veya ilk adım)

    return withIds.map((s, i) => {
        const isCondition = s.step_type === 'condition';
        const config: Record<string, unknown> = { ...((s.config as Record<string, unknown>) || {}) };
        // Koşulun değerlendireceği mailin step_order'ını (motorun okuduğu alan) id'den çöz.
        if (isCondition) {
            const evalId = config.eval_step_id as string | undefined;
            const evalOrder = evalId ? orderOf.get(evalId) : undefined;
            if (evalOrder) config.eval_step_order = evalOrder;
            else delete config.eval_step_order;
        }
        return {
            id: s.id,
            step_type: s.step_type,
            step_kind: s.step_kind || s.step_type,
            subject: s.subject ?? null,
            body_html: s.body_html ?? null,
            body_text: s.body_text ?? null,
            delay_days: s.delay_days || 0,
            delay_hours: s.delay_hours || 0,
            condition_type: isCondition ? (s.condition_type ?? 'opened') : null,
            condition_wait_hours: isCondition ? (s.condition_wait_hours ?? 72) : null,
            // Koşul next_step_id taşımaz — yönlendirme true/false dallarıyla yapılır.
            // Diğer adımlar açık next_step_id'yi korur (null = BİTİŞ), TANIMSIZ ise lineer
            // yedeğe düşer — migrate'teki resolveLinearNext ile birebir aynı mantık.
            next_step_id: isCondition ? null : resolveLinearNext(withIds, i),
            condition_true_step_id: isCondition ? (s.condition_true_step_id ?? null) : null,
            condition_false_step_id: isCondition ? (s.condition_false_step_id ?? null) : null,
            is_entry: i === eIdx,
            step_order: i + 1,
            config,
        };
    });
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
        // Yalnız gerçek adım (mail) node'ları sürüklenebilir; trigger/türev-bekle değil.
        draggable: editable && n.data.stepIndex != null,
        // Bağlanabilir: düzenlenebilir modda gerçek node'lar (trigger + adımlar). Türev bekle
        // node'u adım-içidir → bağlanamaz (kenarlar adımın kendisine çekilir).
        connectable: editable && !n.data.derived,
    }));
    const flowEdges: Edge[] = edges.map((e) => {
        // Koşul dalları renklendirilir: true → yeşil (Evet), false → kırmızı (Hayır).
        const branchColor = e.sourceHandle === 'true' ? 'var(--mantine-color-teal-5)'
            : e.sourceHandle === 'false' ? 'var(--mantine-color-red-5)'
            : undefined;
        // Silinebilir kenar: kullanıcı yönlendirmesi (adım çıkışı). Adım-içi türev bekle
        // (dw-) ve trigger→giriş kenarları silinemez (yapısal/zorunlu).
        const deletable = editable && !e.source.startsWith('dw-') && e.source !== TRIGGER_ID;
        return {
            id: e.id,
            source: e.source,
            target: e.target,
            // 'next' lineer varsayılan handle'dır (id'siz) → sourceHandle göndermeyiz.
            // Adlı dallar (true/false) ConditionNode handle id'leriyle eşlenir.
            sourceHandle: e.sourceHandle && e.sourceHandle !== 'next' ? e.sourceHandle : undefined,
            label: e.label,
            type: 'editable', // özel kenar (üzerine gelince sil ✕ butonu)
            deletable,
            animated: false,
            style: branchColor ? { stroke: branchColor, strokeWidth: 1.5 } : undefined,
            markerEnd: { type: 'arrowclosed' as MarkerType, color: branchColor }, // akış yönü oku (dal rengiyle)
        };
    });
    return { nodes: flowNodes, edges: flowEdges };
}
