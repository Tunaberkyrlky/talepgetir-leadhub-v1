/**
 * profile:crawl (WP7) — the structured output contract for the FAZ 1 website+social crawl.
 *
 * The reading model reads the fetched homepage/about text (+ up to 3 social links,
 * best-effort) and extracts a plain-language company summary, candidate product/service
 * names actually mentioned, a best-guess home country (only with real evidence), and
 * whichever differentiator fields the text genuinely supports. The worker persists the
 * whole validated object into research_projects.profile.ai_draft (frozen model output) —
 * same pattern as research_icps.ai_draft / research_geographies.ai_draft, just inside a
 * JSONB blob instead of a dedicated column. The human-approved final fields (what_they_do,
 * products, differentiators, …) are written ONLY by the wizard steps once the customer
 * confirms — this schema never touches them directly.
 */
import { z } from 'zod/v4';

// Same fence-marker defense as geo/schema.ts and icp/prompt.ts's stripFence: this output
// can be rendered back to the customer (step 3-5 pre-fill) and later serialized into other
// LLM prompts — refuse fence-marker lookalikes at the schema boundary.
const noFence = (max: number) =>
    z.string().min(1).max(max).refine((s) => !s.includes('<<<'), { message: 'fence markers not allowed' });

// Keys are always present (never truly optional) so downstream merge code never has to
// handle `undefined` — "no evidence" is expressed as null / an empty array, not a missing
// key. Mirrors geoAnalysisSchema's estimate/confidence (required, nullable) convention.
const differentiatorsSchema = z.object({
    moq: noFence(200).nullable(),
    lead_time: noFence(200).nullable(),
    certifications: z.array(noFence(200)).max(20),
    capacity: noFence(200).nullable(),
    references: z.array(noFence(200)).max(20),
    languages: z.array(noFence(80)).max(20),
});

export const profileCrawlSchema = z.object({
    /** A few plain sentences on what the company does and who it sells to. */
    company_summary: noFence(2000),
    /** Concrete product/service names actually mentioned in the fetched text (not categories).
     *  Each item pairs a `name` with an `evidence_quote` — a short snippet copied VERBATIM
     *  from the fetched text, which must itself CONTAIN the name, proving the product/service
     *  is genuinely offered. The worker's grounding gate (profileCrawl.ts) drops any item
     *  unless the evidence_quote both contains the name AND actually appears (normalized) in a
     *  single fetched page before persisting — this is what makes the hallucination
     *  structurally impossible instead of merely discouraged by the prompt. */
    products_services: z.array(z.object({ name: noFence(200), evidence_quote: noFence(400) })).max(30),
    /** Best guess of the company's OWN home country; null when there is no real evidence. */
    company_country: noFence(120).nullable(),
    /** Filled only where the fetched text supports it; null/empty otherwise — no guessing. */
    differentiators: differentiatorsSchema,
});

export type ProfileCrawlResult = z.infer<typeof profileCrawlSchema>;
export type ProfileDifferentiators = z.infer<typeof differentiatorsSchema>;
