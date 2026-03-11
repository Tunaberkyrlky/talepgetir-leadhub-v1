export const STAGES = [
    'new',
    'researching',
    'contacted',
    'meeting_scheduled',
    'proposal_sent',
    'negotiation',
    'won',
    'lost',
    'on_hold',
] as const;

export type Stage = (typeof STAGES)[number];

export const stageColors: Record<Stage, string> = {
    new: 'blue',
    researching: 'cyan',
    contacted: 'indigo',
    meeting_scheduled: 'yellow',
    proposal_sent: 'orange',
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
