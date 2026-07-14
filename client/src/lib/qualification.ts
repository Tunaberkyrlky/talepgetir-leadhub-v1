// Qualification + tag constants (v2 Phase 6, slice E4). Mirror the server enums in
// server/src/lib/validation.ts — keep the two in sync.

export const COMPANY_PRIORITIES = ['low', 'normal', 'high'] as const;
export type CompanyPriority = typeof COMPANY_PRIORITIES[number];

export const QUALIFICATION_STATUSES = ['unqualified', 'in_progress', 'qualified', 'disqualified'] as const;
export type QualificationStatus = typeof QUALIFICATION_STATUSES[number];

export const DEAL_LOSS_REASON_CODES = ['price', 'timing', 'competitor', 'no_budget', 'no_need', 'no_response', 'other'] as const;
export type DealLossReasonCode = typeof DEAL_LOSS_REASON_CODES[number];

// Mantine's default palette minus 'dark' — matches the shared tags.color CHECK.
export const TAG_COLORS = ['gray', 'red', 'pink', 'grape', 'violet', 'indigo', 'blue', 'cyan', 'teal', 'green', 'lime', 'yellow', 'orange'] as const;
export type TagColor = typeof TAG_COLORS[number];

// Mantine `color` prop for a priority Badge.
export const PRIORITY_BADGE_COLOR: Record<CompanyPriority, string> = {
    low: 'gray',
    normal: 'blue',
    high: 'red',
};

// Mantine `color` prop for a qualification-status Badge.
export const QUALIFICATION_STATUS_BADGE_COLOR: Record<QualificationStatus, string> = {
    unqualified: 'gray',
    in_progress: 'yellow',
    qualified: 'green',
    disqualified: 'red',
};

// The single canonical "win" terminal outcome. The whole app treats the 'won' slug as
// the win (statistics conversion, dashboards), so a standardized loss reason never
// applies to it. NOTE: pipeline_stages has no per-tenant won/lost flag, so a tenant that
// adds a *custom* win terminal stage can't be detected here — see the E4 open question.
export const WON_STAGE_SLUG = 'won';
export function isWinOutcome(outcome: string | null | undefined): boolean {
    return outcome === WON_STAGE_SLUG;
}

// Parse the closing-report loss-reason marker the server folds into activity detail
// ("[loss_reason_code:price]\n<free text>"). Returns the code + the detail sans marker.
export function parseLossReasonMarker(detail: string | null | undefined): { code: DealLossReasonCode | null; rest: string } {
    if (!detail) return { code: null, rest: '' };
    const m = detail.match(/^\[loss_reason_code:([a-z_]+)\]\n?/);
    if (!m) return { code: null, rest: detail };
    const code = DEAL_LOSS_REASON_CODES.includes(m[1] as DealLossReasonCode) ? (m[1] as DealLossReasonCode) : null;
    return { code, rest: detail.slice(m[0].length) };
}
