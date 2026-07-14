/**
 * LLM usage meter (engine pilot). The capped pilot exists to measure REAL COGS per MATCH lead
 * before we set a lead price + tier quotas. Dollars are computed from ASSUMED rates (pricing.ts),
 * so the pilot must also keep the RAW per-provider token/call counts — then COGS can be recomputed
 * against real invoices after the fact, with any corrected rate, without re-running (and re-paying
 * for) the pilot.
 *
 * The meter sits at the router choke point (runLlm), so it captures EVERY provider call inside a
 * metered scope automatically — including the two calls per discovery query and every internal
 * retry of runLlmJson (which the dollar CapTracker misses; codex deferral B.3). It uses
 * AsyncLocalStorage so concurrent harvest jobs each get their own isolated tally (a module-global
 * counter would cross-contaminate parallel runs); calls made OUTSIDE a metered scope (e.g. ICP
 * generation) are simply not recorded — a no-op.
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface LlmCallRecord {
    provider: string;
    model: string;
    role: string;
    inputTokens: number;
    /** Subset of inputTokens served from the provider's prompt cache (billed cheaper). */
    cachedInputTokens: number;
    outputTokens: number;
    /** Grounded Google-Search queries the model actually executed (search role; else 0). */
    groundedQueries: number;
    finish: string;
}

export interface ModelUsage {
    calls: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    groundedQueries: number;
}

export interface ProviderUsage extends ModelUsage {
    /** Per-model sub-tally within this provider. Lets COGS attribute historical spend to the
     *  ACTUAL model that ran (not the currently-configured one) — the model is operator-editable,
     *  so provider-only attribution would relabel history after a model switch. */
    models: Record<string, ModelUsage>;
}

export interface LlmUsageSummary {
    /** Per-provider raw tallies (keys match LlmResult.provider). */
    byProvider: Record<string, ProviderUsage>;
    totalCalls: number;
    totalInputTokens: number;
    totalCachedInputTokens: number;
    totalOutputTokens: number;
    totalGroundedQueries: number;
}

interface MeterStore {
    calls: LlmCallRecord[];
}

const meterStorage = new AsyncLocalStorage<MeterStore>();

/** Record one provider call into the current meter scope (no-op when not metered). */
export function recordLlmCall(rec: LlmCallRecord): void {
    const store = meterStorage.getStore();
    if (store) store.calls.push(rec);
}

function summarize(calls: LlmCallRecord[]): LlmUsageSummary {
    const byProvider: Record<string, ProviderUsage> = {};
    let totalCalls = 0,
        totalInputTokens = 0,
        totalCachedInputTokens = 0,
        totalOutputTokens = 0,
        totalGroundedQueries = 0;
    for (const c of calls) {
        // models: null-prototype map so a model id that collides with an Object.prototype key
        // (e.g. "constructor", "toString") gets its own tally instead of reusing the inherited value.
        const p = (byProvider[c.provider] ??= { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, groundedQueries: 0, models: Object.create(null) as Record<string, ModelUsage> });
        p.calls += 1;
        p.inputTokens += c.inputTokens;
        p.cachedInputTokens += c.cachedInputTokens;
        p.outputTokens += c.outputTokens;
        p.groundedQueries += c.groundedQueries;
        const m = (p.models[c.model] ??= { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, groundedQueries: 0 });
        m.calls += 1;
        m.inputTokens += c.inputTokens;
        m.cachedInputTokens += c.cachedInputTokens;
        m.outputTokens += c.outputTokens;
        m.groundedQueries += c.groundedQueries;
        totalCalls += 1;
        totalInputTokens += c.inputTokens;
        totalCachedInputTokens += c.cachedInputTokens;
        totalOutputTokens += c.outputTokens;
        totalGroundedQueries += c.groundedQueries;
    }
    return { byProvider, totalCalls, totalInputTokens, totalCachedInputTokens, totalOutputTokens, totalGroundedQueries };
}

/** Carries the partial usage tally on an error thrown out of withLlmMeter, so a run that failed
 *  AFTER spending real money still leaves a COGS trail (no survivorship bias in calibration). */
export interface MeteredError {
    llmUsage?: LlmUsageSummary;
}

/**
 * Run `fn` inside a fresh meter scope; returns its result plus the raw usage tally of every LLM
 * call made within. Nested scopes get their own store (the inner scope shadows the outer), so a
 * caller never double-counts another caller's calls. If `fn` throws AFTER spending on LLM calls,
 * the partial tally is attached to the error as `llmUsage` before rethrowing — the caller can log
 * the spend instead of losing it (failed-but-paid runs are exactly where COGS data matters most).
 */
export async function withLlmMeter<T>(fn: () => Promise<T>): Promise<{ result: T; usage: LlmUsageSummary }> {
    const store: MeterStore = { calls: [] };
    try {
        const result = await meterStorage.run(store, fn);
        return { result, usage: summarize(store.calls) };
    } catch (err) {
        // Best-effort: attach the partial tally for the caller to log. Use defineProperty in a
        // try/catch — a raw assignment on a frozen/non-extensible error would itself throw and MASK
        // the original failure. On any issue we just skip the attach and rethrow the real error.
        if (err && typeof err === 'object') {
            try {
                Object.defineProperty(err, 'llmUsage', { value: summarize(store.calls), configurable: true, enumerable: false });
            } catch {
                /* frozen error — can't attach; the original error still propagates */
            }
        }
        throw err;
    }
}
