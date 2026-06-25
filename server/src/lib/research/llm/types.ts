/**
 * TG-Research LLM layer — provider-agnostic contract.
 *
 * Product code never names a provider; it asks for a ROLE and the router picks
 * the model (K5/D16: price is decoupled from model/provider). Routing today:
 *   strategy → Claude Opus 4.8   (ICP synthesis, geo strategy, planning, messages)
 *   search   → Gemini 3.1 Pro    (web discovery via Google Search grounding)
 *   reading  → DeepSeek V4 Pro    (read/classify/summarize — high-token bulk)
 * Collapsing to fewer providers later is a one-file change in router.ts.
 */
export type LlmRole = 'strategy' | 'search' | 'reading';

export interface LlmMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface LlmCitation {
    title?: string;
    url?: string;
}

export interface LlmUsage {
    inputTokens?: number;
    outputTokens?: number;
}

/** Why generation stopped — callers must treat anything but 'stop' as suspect. */
export type LlmFinish = 'stop' | 'length' | 'refusal' | 'filtered' | 'other';

export interface LlmRunOptions {
    system?: string;
    messages: LlmMessage[];
    /** Constrain output to this JSON Schema (provider-native structured output). Populates result.json. */
    jsonSchema?: Record<string, unknown>;
    /** 'search' role only: enable web-search grounding (Gemini). Ignored by other providers. */
    webSearch?: boolean;
    maxTokens?: number;
    /** Reasoning depth — anthropic→effort, gemini→thinkingLevel, deepseek→reasoning_effort. */
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** Toggle model thinking. Default: on for reasoning; the router turns it off for strict JSON on deepseek. */
    thinking?: boolean;
    /** Per-call model override; otherwise the role's configured default. */
    model?: string;
    signal?: AbortSignal;
}

export interface LlmResult {
    text: string;
    /** Parsed JSON output, when jsonSchema was provided (provider-native structured output). */
    json?: unknown;
    finish: LlmFinish;
    provider: string;
    model: string;
    usage?: LlmUsage;
    /** Grounding citations (search role). */
    citations?: LlmCitation[];
    /** Search queries the model actually executed — needed for per-search cost attribution. */
    searchQueries?: string[];
    /** Raw provider response, for debugging/logging. */
    raw?: unknown;
}

export interface LlmProvider {
    readonly name: string;
    run(opts: LlmRunOptions): Promise<LlmResult>;
}

/** Thrown when a provider call fails (network/auth/refusal-as-error). Carries provider name. */
export class LlmError extends Error {
    readonly provider: string;
    readonly cause?: unknown;
    constructor(message: string, provider: string, cause?: unknown) {
        super(message);
        this.name = 'LlmError';
        this.provider = provider;
        this.cause = cause;
    }
}
