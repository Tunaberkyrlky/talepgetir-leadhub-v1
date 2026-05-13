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

// NOTE: Canonical defaults live in server/src/routes/settings.ts — keep in sync.
// Groups contain only pipeline-type stages. Terminal stages (won/lost) are
// rendered as a visual "Karar" group in the UI but live outside the group data model.
export const DEFAULT_PIPELINE_GROUPS: PipelineStageGroup[] = [
    { id: 'first_contact', label: 'firstContact',  color: 'blue',   stages: ['connected'] },
    { id: 'qualification', label: 'qualification', color: 'orange', stages: ['follow_up'] },
    { id: 'evaluation',    label: 'evaluation',    color: 'grape',  stages: ['in_meeting'] },
];

/** All available colors for pipeline groups */
export const PIPELINE_GROUP_COLORS = [
    'blue', 'cyan', 'teal', 'green', 'lime',
    'yellow', 'orange', 'red', 'pink', 'grape',
    'violet', 'indigo',
];

// ASSIGNABLE_STAGES removed — now dynamic per tenant via StagesContext
