/**
 * Offer/angle layer (WP4) — the structured output contract for offer:generate.
 *
 * An offer is one evidence-bound OUTREACH ANGLE for an ICP: a pain hypothesis, a value
 * proposition, proof points and likely objections. It is NOT message copy — the message text
 * lives in TG-Core campaigns; these cards are the angle MAP the validation pass later picks
 * angle_suggestion from and the export carries into CRM custom_fields.
 */
import { z } from 'zod/v4';

// Angle codes + value props re-enter the VALIDATION prompt's trusted zone (validate.ts renders
// the approved list) — refuse fence-marker lookalikes at the schema boundary (geo/channels
// convention), and keep codes slug-like so they survive as CRM field values.
const noFence = (max: number) =>
    z.string().min(1).max(max).refine((s) => !s.includes('<<<'), { message: 'fence markers not allowed' });

const emptyToUndefined = (v: unknown) => (v == null || (typeof v === 'string' && v.trim() === '') ? undefined : v);

export const offerDraftSchema = z.object({
    /** Short slug identifying the angle (e.g. "moq-flex", "eu-stock-speed"). */
    angle_code: z.string().min(2).max(40).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase slug (a-z, 0-9, dashes)'),
    /** The buyer pain this angle speaks to — one tight sentence. */
    pain_hypothesis: noFence(400),
    /** The value proposition — one or two sentences, grounded in the exporter's profile. */
    value_prop: noFence(500),
    /** 2-4 proof points drawn from the profile/differentiators/evidence — never invented. */
    proof_points: z.array(noFence(300)).min(1).max(4),
    /** 1-3 likely objections this segment will raise (with the implied counter). */
    objections: z.array(noFence(300)).max(3),
    /** Outreach language for the angle (e.g. "en", "de") when it matters; omit otherwise. */
    language: z.preprocess(emptyToUndefined, z.string().min(2).max(12).optional()),
});

export const offerGenerationSchema = z.object({
    offers: z.array(offerDraftSchema).min(3).max(5),
});

export type OfferDraft = z.infer<typeof offerDraftSchema>;
