/**
 * Y1 channel-discovery query templates (WP3, 00 §3 "liste-hasadı keşif açıları").
 *
 * Deterministic, multilingual query specs for ONE sub-ICP × country cell: find EVERY
 * reachable company-list source (associations, directories, fairs, chambers/registries,
 * clusters, editorial lists, marketplaces). English templates always run; the cell's
 * local-language sector terms (WP2 spec) add the local variants that carry most weight
 * in non-English geographies. SearXNG is $0, so the bound is generous.
 */

export interface ChannelQuerySpec {
    /** Canonical discovery category the query serves (rule-A coverage tracking). */
    category: 'association' | 'directory' | 'fair' | 'chamber_registry' | 'cluster' | 'editorial' | 'marketplace' | 'local_language';
    query: string;
}

const DEFAULT_MAX_QUERIES = Number(process.env.RESEARCH_CHANNELS_DISCOVER_MAX_QUERIES ?? 24);

/** All rule-A discovery categories (a full round runs every one of them). */
export const CHANNEL_DISCOVERY_CATEGORIES: ReadonlyArray<ChannelQuerySpec['category']> = [
    'association', 'directory', 'fair', 'chamber_registry', 'cluster', 'editorial', 'marketplace', 'local_language',
];

export function buildChannelDiscoveryQueries(
    sector: string,
    country: string,
    localTerms: string[] = [],
    max = DEFAULT_MAX_QUERIES
): ChannelQuerySpec[] {
    const seg = sector.replace(/\s+/g, ' ').trim();
    const specs: ChannelQuerySpec[] = [
        { category: 'association', query: `${seg} association ${country} members list` },
        { category: 'association', query: `${seg} industry association ${country}` },
        { category: 'directory', query: `${seg} suppliers directory ${country}` },
        { category: 'directory', query: `list of ${seg} companies ${country}` },
        { category: 'fair', query: `${seg} trade fair ${country} exhibitor list` },
        { category: 'fair', query: `${seg} exhibition ${country} exhibitors` },
        { category: 'chamber_registry', query: `chamber of commerce ${seg} ${country} member companies` },
        { category: 'chamber_registry', query: `${country} ${seg} company register` },
        { category: 'cluster', query: `${seg} industrial cluster ${country}` },
        { category: 'cluster', query: `${seg} industrial zone companies ${country}` },
        { category: 'editorial', query: `top ${seg} companies ${country}` },
        { category: 'editorial', query: `biggest ${seg} distributors ${country}` },
        { category: 'marketplace', query: `${seg} b2b marketplace ${country}` },
        { category: 'marketplace', query: `${seg} suppliers portal ${country}` },
    ];
    // Local-language variants (mandatory weight in non-English geographies, 00 §3 angle 10):
    // the WP2 cell's local sector phrases stand in for the sector — a native association or
    // directory rarely surfaces under the English phrasing.
    for (const term of localTerms.slice(0, 3)) {
        const local = term.replace(/\s+/g, ' ').trim();
        if (!local) continue;
        specs.push(
            { category: 'local_language', query: `${local} ${country}` },
            { category: 'local_language', query: `${local} list ${country}` }
        );
    }
    // Round-robin by category so a tight cap still touches EVERY category (rule A requires
    // all discovery angles to have run).
    const byCategory = new Map<string, ChannelQuerySpec[]>();
    for (const s of specs) {
        const bucket = byCategory.get(s.category) ?? [];
        bucket.push(s);
        byCategory.set(s.category, bucket);
    }
    const ordered: ChannelQuerySpec[] = [];
    let added = true;
    while (added) {
        added = false;
        for (const bucket of byCategory.values()) {
            const next = bucket.shift();
            if (next) { ordered.push(next); added = true; }
        }
    }
    const seen = new Set<string>();
    return ordered
        .filter((s) => {
            const k = s.query.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        })
        .slice(0, Math.max(1, max));
}
