/**
 * COGS pricing (engine pilot). The WHOLE POINT of the capped pilot is to measure the real
 * cost of producing one MATCH lead before we set a lead price + tier quotas. So every
 * external call is costed here, in ONE place, and recorded (research_search_log.cost_usd +
 * the job result cost breakdown). pricing_version is 'v1'.
 *
 * These rates are ASSUMPTIONS until the pilot reconciles them against real invoices — so
 * they are all env-overridable, and the pilot also records raw token/call counts so COGS can
 * be recomputed with corrected rates after the fact. Rates are USD.
 */
import type { LlmResult, LlmUsage } from '../llm/index.js';
import type { LlmUsageSummary } from '../llm/meter.js';

function envNum(key: string, fallback: number): number {
    const v = process.env[key];
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/** USD per 1M tokens, per provider. Keys match LlmResult.provider. cachedInPerM prices the
 *  prompt-cache-hit share of input (defaults to inPerM when the provider has no discount). */
interface TokenRate {
    inPerM: number;
    outPerM: number;
    cachedInPerM: number;
}

// Rates CONFIRMED against list prices on 2026-07-02 (01_KREDI_FIYATLAMA.md §4.1):
//   Gemini 3.1 Pro   $2 / $12 per 1M (≤200K ctx; our calls are far below), grounding $14/1000 q.
//   DeepSeek V4 Pro  $0.435 in (cache-miss) / $0.87 out / $0.003625 cache-hit per 1M.
//   Claude Opus 4.8  $5 / $25 per 1M (1M ctx at the same price).
const TOKEN_RATES: Record<string, TokenRate> = {
    // Strategy model — ICP generation only, NOT in the harvest path (ICP-setup cost line).
    anthropic: {
        inPerM: envNum('RESEARCH_PRICE_ANTHROPIC_IN', 5),
        outPerM: envNum('RESEARCH_PRICE_ANTHROPIC_OUT', 25),
        cachedInPerM: envNum('RESEARCH_PRICE_ANTHROPIC_CACHED_IN', 0.5),
    },
    // Gemini 3.1 Pro (search/grounding) — token cost; grounding has a separate per-query fee.
    gemini: {
        inPerM: envNum('RESEARCH_PRICE_GEMINI_IN', 2),
        outPerM: envNum('RESEARCH_PRICE_GEMINI_OUT', 12),
        // No confirmed implicit-cache discount for our call shapes — price cached = full (safe side).
        cachedInPerM: envNum('RESEARCH_PRICE_GEMINI_CACHED_IN', 2),
    },
    // DeepSeek V4 Pro (reading) — cheap high-volume validation; cache-hit input is ~free.
    deepseek: {
        inPerM: envNum('RESEARCH_PRICE_DEEPSEEK_IN', 0.435),
        outPerM: envNum('RESEARCH_PRICE_DEEPSEEK_OUT', 0.87),
        cachedInPerM: envNum('RESEARCH_PRICE_DEEPSEEK_CACHED_IN', 0.003625),
    },
};

/** Flat fee per grounded Google-Search query (Gemini grounding billing), USD. Default = Google's
 *  current listed rate ($14 / 1,000 search queries = $0.014). Gemini 3.1 Pro's actual rate + any
 *  free-quota treatment must be confirmed against a real invoice; env-overridable. A single request
 *  can trigger MULTIPLE charged queries — the meter counts the actual executed queries (searchQueries). */
const GEMINI_GROUNDING_PER_QUERY = envNum('RESEARCH_PRICE_GEMINI_GROUNDING_QUERY', 0.014);

/** Per successful page fetch via Jina Reader (r.jina.ai), USD. 0 = within free tier. */
const JINA_PER_FETCH = envNum('RESEARCH_PRICE_JINA_FETCH', 0);

/** USD per Hunter domain-search request (each request = one Hunter credit). 0 = free/trial
 *  plan (the shipped default) — the raw request COUNT is the meaningful figure until a paid
 *  Hunter plan sets a real per-request rate here. Surfaced ONLY on the internal admin margin
 *  panel; enrichment is a distinct product line, not part of per-MATCH harvest COGS. */
export const HUNTER_PER_REQUEST_USD = envNum('RESEARCH_PRICE_HUNTER_REQUEST', 0);

/** USD per UN Comtrade API request. 0 = the free/keyless preview endpoint (the shipped default —
 *  see COMTRADE_SUBSCRIPTION_KEY in trade/comtrade.ts for the optional higher-quota path). Surfaced
 *  ONLY on the internal admin margin panel; the raw request COUNT is the meaningful figure for
 *  rate-limit budgeting, same posture as HUNTER_PER_REQUEST_USD. */
export const COMTRADE_PER_REQUEST_USD = envNum('RESEARCH_PRICE_COMTRADE_REQUEST', 0);

function tokenCost(provider: string, usage: LlmUsage | undefined): number {
    const rate = TOKEN_RATES[provider];
    if (!rate || !usage) return 0;
    const inTok = usage.inputTokens ?? 0;
    // Cache-hit input is billed at the (often much cheaper) cached rate; the miss share at full.
    const cached = Math.min(usage.cachedInputTokens ?? 0, inTok);
    const outTok = usage.outputTokens ?? 0;
    return (
        ((inTok - cached) / 1_000_000) * rate.inPerM +
        (cached / 1_000_000) * rate.cachedInPerM +
        (outTok / 1_000_000) * rate.outPerM
    );
}

/** Cost of one non-grounded LLM call (reading/strategy structuring): tokens only. */
export function costOfLlm(result: Pick<LlmResult, 'provider' | 'usage'>): number {
    return round6(tokenCost(result.provider, result.usage));
}

/**
 * Cost of one grounded search call: token cost + a flat grounding fee for each Google-Search
 * query the model actually executed (searchQueries). On a cache hit, pass executedQueries=0.
 */
export function costOfSearch(
    result: Pick<LlmResult, 'provider' | 'usage' | 'searchQueries'>,
    executedQueries?: number
): number {
    const queries = executedQueries ?? result.searchQueries?.length ?? 0;
    const grounding = result.provider === 'gemini' ? queries * GEMINI_GROUNDING_PER_QUERY : 0;
    return round6(tokenCost(result.provider, result.usage) + grounding);
}

/** Cost of one page fetch (0 when served from cache — caller passes cacheHit). */
export function costOfFetch(cacheHit: boolean): number {
    return cacheHit ? 0 : round6(JINA_PER_FETCH);
}

/** Dollar cost of one aggregated usage bucket (a provider tally OR a per-model sub-tally) at the
 *  current rate book: tokens + Gemini grounding. Pricing is provider-based, so the same rates apply
 *  whether the bucket is the provider total or one model within it. Used by the admin breakdown to
 *  attribute historical spend per actual model. */
export function costOfUsageBucket(
    provider: string,
    u: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; groundedQueries?: number }
): number {
    const tok = tokenCost(provider, {
        inputTokens: u.inputTokens ?? 0,
        cachedInputTokens: u.cachedInputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
    });
    const grounding = provider === 'gemini' ? (u.groundedQueries ?? 0) * GEMINI_GROUNDING_PER_QUERY : 0;
    return round6(tok + grounding);
}

function round6(n: number): number {
    return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Recompute LLM + grounding dollars from the RAW per-provider meter tally (not the CapTracker's
 * incremental dollars). Used by the pilot to (a) recompute COGS with any corrected rate set later
 * and (b) cross-check the CapTracker. The meter records EVERY provider call — including the
 * app-level runLlmJson retries that the tracker costs only on the final attempt — so this is a
 * RETRY-FAITHFUL ESTIMATE at the configured rates, cache-aware since the 2026-07-02 rate
 * confirmation: the cache-hit share of input is priced at cachedInPerM (DeepSeek's is ~free), the
 * miss share at inPerM. It is typically ≥ the tracker's LLM+grounding dollars; treat small
 * differences as retry tokens plus per-call-vs-aggregate rounding (sub-cent), not a bug.
 * (SDK-internal retries are off — maxRetries:0.) Excludes fetch cost (Jina is not an LLM call).
 */
export interface UsageCostBreakdown {
    byProvider: Record<string, number>;
    tokensUsd: number;
    groundingUsd: number;
    totalUsd: number;
}

export function costFromUsageSummary(usage: LlmUsageSummary): UsageCostBreakdown {
    const byProvider: Record<string, number> = {};
    let tokensUsd = 0;
    let groundingUsd = 0;
    for (const [provider, u] of Object.entries(usage.byProvider)) {
        const tok = tokenCost(provider, {
            inputTokens: u.inputTokens,
            cachedInputTokens: u.cachedInputTokens,
            outputTokens: u.outputTokens,
        });
        const grounding = provider === 'gemini' ? u.groundedQueries * GEMINI_GROUNDING_PER_QUERY : 0;
        byProvider[provider] = round6(tok + grounding);
        tokensUsd += tok;
        groundingUsd += grounding;
    }
    return {
        byProvider,
        tokensUsd: round6(tokensUsd),
        groundingUsd: round6(groundingUsd),
        totalUsd: round6(tokensUsd + groundingUsd),
    };
}

// v2 = COGS rate book confirmed against list prices on 2026-07-02 (Gemini $2/$12 + $0.014/query;
// DeepSeek $0.435/$0.87 + $0.003625 cache-hit; cache-aware input pricing). v1 = the pre-pilot
// assumptions. Stamped on billable events for audit; billing eligibility never depends on it.
export const PRICING_VERSION = 'v2';
