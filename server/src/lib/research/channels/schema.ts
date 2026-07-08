/**
 * Y1 channel discovery + list harvest (WP3) — structured output contracts.
 *
 * channelClassificationSchema — channels:discover's reading-role pass over SearXNG results:
 * which URLs are COMPANY-LIST sources (association member lists, directories, fair exhibitor
 * lists, chambers/registries, clusters, marketplaces, editorial "top N" pages) for one
 * sub-ICP × country cell. URLs must come from the presented results — never invented.
 *
 * memberExtractionSchema — channels:harvest's reading-role pass over ONE fetched member-list
 * page: the member companies (name + website + city) located in / serving the target country.
 * Websites only when present on the page — never guessed.
 */
import { z } from 'zod/v4';

/** 056 CHECK list for research_channels.type. */
export const CHANNEL_TYPES = [
    'association', 'fair', 'chamber', 'registry', 'cluster',
    'directory', 'customs', 'marketplace', 'map', 'editorial', 'other',
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

// Channel names/notes can resurface in later prompts (harvest context) — refuse
// fence-marker lookalikes at the schema boundary (same hygiene as the geo spec).
const noFence = (max: number) =>
    z.string().min(1).max(max).refine((s) => !s.includes('<<<'), { message: 'fence markers not allowed' });

const urlField = z.string().min(8).max(500).refine((s) => /^https?:\/\//i.test(s), { message: 'must be an absolute http(s) URL' });

// Models routinely emit "" / null for an absent optional field instead of omitting it
// (live DeepSeek behavior) — normalize those to undefined before validating.
const emptyToUndefined = (v: unknown) => (v == null || (typeof v === 'string' && v.trim() === '') ? undefined : v);

export const classifiedChannelSchema = z.object({
    type: z.enum(CHANNEL_TYPES),
    name: noFence(200),
    /** The channel's main URL — MUST be one of the presented result URLs (or its page). */
    url: urlField,
    /** Direct member/exhibitor/tenant LIST page when visible in the results; else omit. */
    member_list_url: z.preprocess(emptyToUndefined, urlField.optional()),
    /** One short line: why this is a company-list source for the cell. */
    note: z.preprocess(emptyToUndefined, noFence(300).optional()),
});

export const channelClassificationSchema = z.object({
    channels: z.array(classifiedChannelSchema).max(40),
});
export type ClassifiedChannel = z.infer<typeof classifiedChannelSchema>;

export const extractedMemberSchema = z.object({
    name: noFence(200),
    /** Company website EXACTLY as it appears on the page; omit when absent — never invented. */
    website: z.preprocess(emptyToUndefined, z.string().min(4).max(300).optional()),
    city: z.preprocess(emptyToUndefined, noFence(120).optional()),
});

export const memberExtractionSchema = z.object({
    members: z.array(extractedMemberSchema).max(200),
    /** True when the page clearly is NOT a company list (news article, 404, login wall…). */
    not_a_list: z.boolean().optional(),
});
export type ExtractedMember = z.infer<typeof extractedMemberSchema>;
