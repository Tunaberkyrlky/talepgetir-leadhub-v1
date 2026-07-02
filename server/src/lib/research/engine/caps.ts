/**
 * Cap + cost tracker (engine pilot). The pilot harvests 1 ICP × 1 geography under HARD caps
 * with a full cost ledger, so it can never run away on spend while we learn real COGS. The
 * tracker is the single rail: the handler asks it before each expensive step, and feeds every
 * costed call back into it. Hitting a cap is a GRACEFUL stop (the job still succeeds with a
 * partial summary) — never a failure.
 */

export interface EngineCaps {
    /** Max discovery (grounded search) queries. */
    maxQueries: number;
    /** Max page fetches (network/Jina). */
    maxFetches: number;
    /** Max fresh candidates processed (validated). */
    maxCandidates: number;
    /** Hard USD ceiling across search + fetch + LLM. */
    maxSpendUsd: number;
}

export const DEFAULT_CAPS: EngineCaps = {
    maxQueries: 5,
    maxFetches: 25,
    maxCandidates: 40,
    maxSpendUsd: 2.0,
};

// Authorized hard ceilings — a caller can ask for LESS but never more than these. The spend
// ceiling is env-tunable so an operator can deliberately raise it for a sanctioned larger run,
// rather than letting any client_admin jump straight to the old $25.
const CEILING = {
    queries: Number(process.env.RESEARCH_MAX_QUERIES_CEILING ?? 10),
    fetches: Number(process.env.RESEARCH_MAX_FETCHES_CEILING ?? 60),
    candidates: Number(process.env.RESEARCH_MAX_CANDIDATES_CEILING ?? 80),
    spendUsd: Number(process.env.RESEARCH_MAX_SPEND_CEILING ?? 5),
};

/** Clamp caller-supplied caps to the authorized ceilings (a request can only ask for LESS). */
export function resolveCaps(input?: Partial<EngineCaps>): EngineCaps {
    const c = { ...DEFAULT_CAPS, ...(input ?? {}) };
    return {
        maxQueries: clamp(c.maxQueries, 1, CEILING.queries),
        maxFetches: clamp(c.maxFetches, 1, CEILING.fetches),
        maxCandidates: clamp(c.maxCandidates, 1, CEILING.candidates),
        maxSpendUsd: clamp(c.maxSpendUsd, 0.01, CEILING.spendUsd),
    };
}

function clamp(n: number, lo: number, hi: number): number {
    if (!Number.isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
}

export interface CostBreakdown {
    searchUsd: number;
    fetchUsd: number;
    llmUsd: number;
    totalUsd: number;
}

export class CapTracker {
    readonly caps: EngineCaps;
    queries = 0;
    fetches = 0;
    candidates = 0;
    private searchUsd = 0;
    private fetchUsd = 0;
    private llmUsd = 0;

    constructor(caps: EngineCaps) {
        this.caps = caps;
    }

    private get spendUsd(): number {
        return this.searchUsd + this.fetchUsd + this.llmUsd;
    }

    /** First cap that is now hit, or null when there is still room to do more work. */
    reasonToStop(): string | null {
        if (this.spendUsd >= this.caps.maxSpendUsd) return 'spend_cap';
        if (this.candidates >= this.caps.maxCandidates) return 'candidate_cap';
        if (this.fetches >= this.caps.maxFetches) return 'fetch_cap';
        return null;
    }

    canQuery(): boolean {
        return this.queries < this.caps.maxQueries && this.spendUsd < this.caps.maxSpendUsd;
    }
    canFetch(): boolean {
        return this.fetches < this.caps.maxFetches && this.spendUsd < this.caps.maxSpendUsd;
    }
    canTakeCandidate(): boolean {
        return this.candidates < this.caps.maxCandidates && this.spendUsd < this.caps.maxSpendUsd;
    }

    countQuery(): void {
        this.queries++;
    }
    countFetch(): void {
        this.fetches++;
    }
    countCandidate(): void {
        this.candidates++;
    }

    addSearchCost(usd: number): void {
        this.searchUsd += usd;
    }
    addFetchCost(usd: number): void {
        this.fetchUsd += usd;
    }
    addLlmCost(usd: number): void {
        this.llmUsd += usd;
    }

    cost(): CostBreakdown {
        return {
            searchUsd: round6(this.searchUsd),
            fetchUsd: round6(this.fetchUsd),
            llmUsd: round6(this.llmUsd),
            totalUsd: round6(this.spendUsd),
        };
    }
}

function round6(n: number): number {
    return Math.round(n * 1_000_000) / 1_000_000;
}
