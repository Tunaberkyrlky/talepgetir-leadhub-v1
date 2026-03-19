/**
 * Pipeline stage groups — configurable per tenant.
 * Each group aggregates individual stages into a high-level pipeline phase.
 */

export interface PipelineStageGroup {
    id: string;
    label: string;
    color: string;
    stages: string[];
}

// NOTE: Canonical defaults live in server/src/routes/settings.ts — keep in sync
export const DEFAULT_PIPELINE_GROUPS: PipelineStageGroup[] = [
    {
        id: 'first_contact',
        label: 'firstContact',
        color: 'blue',
        stages: ['in_queue', 'first_contact', 'connected'],
    },
    {
        id: 'qualification',
        label: 'qualification',
        color: 'orange',
        stages: ['qualified', 'in_meeting'],
    },
    {
        id: 'evaluation',
        label: 'evaluation',
        color: 'grape',
        stages: ['follow_up', 'proposal_sent'],
    },
    {
        id: 'closing',
        label: 'closing',
        color: 'green',
        stages: ['negotiation'],
    },
];

/** All available colors for pipeline groups */
export const PIPELINE_GROUP_COLORS = [
    'blue', 'cyan', 'teal', 'green', 'lime',
    'yellow', 'orange', 'red', 'pink', 'grape',
    'violet', 'indigo',
];

/** Stages that can be assigned to pipeline groups (active, non-terminal) */
export const ASSIGNABLE_STAGES = [
    'in_queue', 'first_contact', 'connected', 'qualified',
    'in_meeting', 'follow_up', 'proposal_sent', 'negotiation',
];
