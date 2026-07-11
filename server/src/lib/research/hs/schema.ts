/**
 * HS matching (WP11) — the structured output contract for physical-product classification.
 *
 * The strategy model proposes raw six-digit HS candidates for customer-approved products.
 * The worker treats these as untrusted guesses: every code is normalized and validated
 * against the live UN Comtrade nomenclature before any customer-visible row is persisted.
 */
import { z } from 'zod/v4';

// Bounds mirror the route/profile limits feeding this prompt. Free-text fields become
// customer-visible stored data, so fence-marker lookalikes are rejected at the schema boundary.
const noFence = (max: number) =>
    z.string().min(1).max(max).refine((s) => !s.includes('<<<'), { message: 'fence markers not allowed' });

/** One raw model proposal; code validity is checked against Comtrade after generation. */
export const hsMatchSchema = z.object({
    candidates: z.array(z.object({
        /** Model's raw HS guess; normalized and live-validated before persistence. */
        code: z.string().min(1).max(20),
        /** Human-facing description of the classified physical good. */
        description: noFence(300),
        /** The exact profile.products item this candidate maps back to. */
        source_product: noFence(300),
    })).max(30),
});

export type HsMatch = z.infer<typeof hsMatchSchema>;
