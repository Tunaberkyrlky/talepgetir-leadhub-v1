/**
 * Z1 — output contract for the free-text AI-revise draft.
 *
 * runLlmJson RE-VALIDATES model output against this zod schema (router.ts:162). The provider strips
 * min/max from the JSON schema sent to the model (sanitizeSchema), so the max cap here is a
 * re-validation guard that rejects+retries runaway output — same rationale as icp/reviseSchema.ts.
 *
 * The cap is FIELD-SPECIFIC: it mirrors the real per-field maxLength the target PATCH endpoint
 * enforces (e.g. pain_hypothesis 400, value_prop 500, segment 2000, name 200). A flat 4000 cap let
 * the model emit a draft the customer could Apply but never Save (the next PATCH would 400), so the
 * route passes the field's true limit here and the model is told the same ceiling in the prompt.
 */
import { z } from 'zod/v4';

/** Build the draft output contract for a field whose PATCH endpoint caps it at `maxLen` chars. */
export function reviseDraftSchema(maxLen: number) {
    return z.object({
        draft: z.string().min(1).max(maxLen),
    });
}

export type ReviseDraft = z.infer<ReturnType<typeof reviseDraftSchema>>;
