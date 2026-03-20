/**
 * Pipeline stage defaults — used as fallback values.
 * Components should use useStages() hook from StagesContext for dynamic, tenant-specific stages.
 */

/** Default stage color mapping (fallback when StagesContext is unavailable) */
export const DEFAULT_STAGE_COLORS: Record<string, string> = {
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

/** Get stage color safely (returns 'gray' for unknown stages) — fallback only */
export function getStageColor(stage: string): string {
    return DEFAULT_STAGE_COLORS[stage] || 'gray';
}
