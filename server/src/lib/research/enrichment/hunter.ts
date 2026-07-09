/**
 * Hunter.io client — domain-search only, cost-disciplined.
 *
 * Every domain-search request consumes ONE Hunter credit regardless of how many
 * emails it returns (up to 100/page), so the client: (a) never paginates, (b) never
 * retries (a retry could double-spend), (c) surfaces quota/payment refusals as a
 * typed error so the run stops instead of burning the remaining allowance.
 *
 * STRICT DOMAIN MATCH is enforced by the caller: the response echoes the domain
 * Hunter actually searched (`data.domain`) — anything that differs from the
 * requested registrable domain is treated as a mismatch (no persist, no bill).
 */
import { createLogger } from '../../logger.js';

const log = createLogger('research:enrichment:hunter');

const HUNTER_ENDPOINT = 'https://api.hunter.io/v2/domain-search';
const TIMEOUT_MS = 20_000;

export class HunterConfigError extends Error {}
/** 401/402/403/429 — key invalid, plan exhausted, or rate-limited: STOP the run. */
export class HunterQuotaError extends Error {}

export interface HunterEmail {
    value: string;
    type: 'personal' | 'generic';
    confidence: number | null;
    first_name: string | null;
    last_name: string | null;
    position: string | null;
    seniority: string | null;
    department: string | null;
}

export interface HunterDomainResult {
    /** The domain Hunter actually searched (its normalization of our input). */
    domain: string | null;
    organization: string | null;
    emails: HunterEmail[];
}

function apiKey(): string {
    const key = process.env.HUNTER_API || process.env.HUNTER_API_KEY;
    if (!key) throw new HunterConfigError('HUNTER_API is not configured on this process');
    return key;
}

/** One domain-search call = one Hunter credit. `limit` caps returned emails — the FREE/starter
 *  plans reject limit>10 with a 400 pagination_error (live-verified), so the page size clamps
 *  to RESEARCH_HUNTER_PAGE_LIMIT (default 10; raise it only on a plan that allows more). */
export async function hunterDomainSearch(domain: string, limit: number): Promise<HunterDomainResult> {
    const planPageLimit = Math.min(Math.max(Math.floor(Number(process.env.RESEARCH_HUNTER_PAGE_LIMIT) || 10), 1), 100);
    const url = new URL(HUNTER_ENDPOINT);
    url.searchParams.set('domain', domain);
    url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), planPageLimit)));
    url.searchParams.set('api_key', apiKey());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
        res = await fetch(url, { signal: controller.signal });
    } catch (err) {
        // No retry — an ambiguous network failure must not risk a second billed request.
        throw new Error(`hunter domain-search failed (network): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 429) {
        const body = await res.text().catch(() => '');
        log.warn({ status: res.status, domain }, 'hunter refused (quota/auth) — stopping');
        throw new HunterQuotaError(`hunter refused (${res.status}): ${body.slice(0, 200)}`);
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`hunter domain-search failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
        data?: {
            domain?: string | null;
            organization?: string | null;
            emails?: Array<{
                value?: string;
                type?: string;
                confidence?: number;
                first_name?: string | null;
                last_name?: string | null;
                position?: string | null;
                seniority?: string | null;
                department?: string | null;
            }>;
        };
    };

    const emails: HunterEmail[] = (json.data?.emails ?? [])
        .filter((e) => typeof e.value === 'string' && e.value.includes('@'))
        .map((e) => ({
            value: (e.value as string).toLowerCase(),
            type: e.type === 'generic' ? 'generic' : 'personal',
            confidence: typeof e.confidence === 'number' ? e.confidence : null,
            first_name: e.first_name ?? null,
            last_name: e.last_name ?? null,
            position: e.position ?? null,
            seniority: e.seniority ?? null,
            department: e.department ?? null,
        }));

    return {
        domain: json.data?.domain?.toLowerCase() ?? null,
        organization: json.data?.organization ?? null,
        emails,
    };
}
