/**
 * Company pipeline stages — ordered enum.
 * Index = stage order (0-based). Pipeline progress is tracked by position.
 */
export const STAGES = [
    'cold',            // 0 - Soğuk
    'in_queue',        // 1 - Sırada
    'first_contact',   // 2 - İlk Temas
    'connected',       // 2 - Bağlantı Kuruldu
    'qualified',       // 3 - Nitelikli
    'in_meeting',      // 4 - Görüşmede
    'follow_up',       // 5 - Takipte
    'proposal_sent',   // 6 - Teklif Gönderildi
    'negotiation',     // 7 - Müzakere
    'won',             // 8 - Kazanıldı
    'lost',            // 9 - Kaybedildi
    'on_hold',         // 10 - Askıda
] as const;

export type Stage = (typeof STAGES)[number];

/** Stage order index (0-based). Use for comparing pipeline progress. */
export const STAGE_ORDER: Record<Stage, number> = Object.fromEntries(
    STAGES.map((s, i) => [s, i])
) as Record<Stage, number>;

export const stageColors: Record<Stage, string> = {
    cold: 'gray',
    in_queue: 'blue',
    first_contact: 'cyan',
    connected: 'indigo',
    qualified: 'teal',
    in_meeting: 'yellow',
    follow_up: 'orange',
    proposal_sent: 'violet',
    negotiation: 'grape',
    won: 'green',
    lost: 'red',
    on_hold: 'gray',
};

/** Active pipeline stages (excludes terminal states) */
export const PIPELINE_STAGES = STAGES.filter(
    (s) => !['won', 'lost', 'on_hold'].includes(s)
);

/** Terminal stages */
export const TERMINAL_STAGES: Stage[] = ['won', 'lost', 'on_hold'];

/** Get stage color safely (returns 'gray' for unknown stages) */
export function getStageColor(stage: string): string {
    return stageColors[stage as Stage] || 'gray';
}

/** Compare two stages by pipeline order. Returns negative if a < b, 0 if equal, positive if a > b */
export function compareStages(a: Stage, b: Stage): number {
    return STAGE_ORDER[a] - STAGE_ORDER[b];
}
