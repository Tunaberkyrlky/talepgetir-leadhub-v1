/**
 * Calibration (WP1) — the structured output contract for ICP revision.
 *
 * The strategy model (Opus, via runLlmJson('strategy', …)) returns a revised ruleset
 * proposal shaped like this. The worker persists the whole validated object into
 * research_icps.revision_draft (fenced RPC 084); the apply-revision route validates
 * it AGAIN against this schema before patching the live ruleset columns — the draft
 * itself never touches billing-relevant state.
 */
import { z } from 'zod/v4';

// Bounds mirror icp/schema.ts (and the PATCH limits in routes/research/icps.ts). The
// provider strips min/max from the JSON schema sent to the model, but runLlmJson
// RE-VALIDATES the output against this zod schema — so these caps reject (and retry)
// runaway model output before it is persisted as a draft. Keep them in sync.
const item = z.string().min(1).max(500);
const list = z.array(item).max(100);

/** The full revision proposal: FULL replacement arrays, never diffs. */
export const icpRevisionSchema = z.object({
    /** Replacement for research_icps.signals. */
    signals: z.array(item).min(1).max(100),
    /** Replacement for research_icps.negative_signals. */
    negative_signals: list,
    /** Replacement for research_icps.neutral_signals. */
    neutral_signals: list,
    /** Replacement for research_icps.elimination_rules. */
    elimination_rules: list,
    /** Human-readable list of each concrete add/remove/modify and its reason. */
    changes_summary: z.array(item).min(1).max(20),
    /** How the calibration feedback drove the changes — shown to the user. */
    rationale: z.string().min(1).max(4000),
});

export type IcpRevision = z.infer<typeof icpRevisionSchema>;
