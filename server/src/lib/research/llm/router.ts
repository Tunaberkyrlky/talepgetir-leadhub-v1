/**
 * LLM router — maps a ROLE to its provider and runs the call. Product code calls
 * runLlm/runLlmJson(role, …) and never names a provider (K5/D16). Switching a
 * role to a different provider is a one-line change to ROUTE below.
 */
import { z } from 'zod/v4';
import type { LlmRole, LlmRunOptions, LlmResult, LlmProvider } from './types.js';
import { LlmError } from './types.js';
import { anthropicProvider } from './providers/anthropic.js';
import { geminiProvider } from './providers/gemini.js';
import { deepseekProvider } from './providers/deepseek.js';
import { recordLlmCall } from './meter.js';
import { createLogger } from '../../logger.js';

const log = createLogger('research:llm');

const ROUTE: Record<LlmRole, LlmProvider> = {
    strategy: anthropicProvider, // Claude Opus 4.8
    search: geminiProvider, // Gemini 3.1 Pro + Google Search grounding
    reading: deepseekProvider, // DeepSeek V4 Pro
};

export function llmProviderFor(role: LlmRole): string {
    return ROUTE[role].name;
}

/** Free-text / grounded generation. */
export async function runLlm(role: LlmRole, opts: LlmRunOptions): Promise<LlmResult> {
    const provider = ROUTE[role];
    const started = Date.now();
    try {
        const res = await provider.run(opts);
        // Record raw usage into the active meter scope (no-op when not metered). This is the single
        // choke point for every provider call, so the pilot's usage tally captures discovery's two
        // calls per query AND every runLlmJson retry below — which the dollar CapTracker misses.
        recordLlmCall({
            provider: provider.name,
            model: res.model,
            role,
            inputTokens: res.usage?.inputTokens ?? 0,
            cachedInputTokens: res.usage?.cachedInputTokens ?? 0,
            outputTokens: res.usage?.outputTokens ?? 0,
            groundedQueries: res.searchQueries?.length ?? 0,
            finish: res.finish,
        });
        log.info(
            {
                role,
                provider: provider.name,
                model: res.model,
                finish: res.finish,
                ms: Date.now() - started,
                inTok: res.usage?.inputTokens,
                outTok: res.usage?.outputTokens,
                searches: res.searchQueries?.length,
            },
            'llm call'
        );
        return res;
    } catch (err) {
        if (err instanceof LlmError) throw err;
        throw new LlmError(err instanceof Error ? err.message : String(err), provider.name, err);
    }
}

// Anthropic structured outputs reject many JSON-schema keywords and require
// additionalProperties:false. Strip the unsupported set + force closed objects.
// (DeepSeek receives the same schema as prompt guidance; it tolerates anything.)
const UNSUPPORTED_SCHEMA_KEYS = new Set([
    'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'multipleOf', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', '$schema',
    'default', 'examples',
]);

function sanitizeSchema(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(sanitizeSchema);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
        out[k] = sanitizeSchema(v);
    }
    if (out.type === 'object' || 'properties' in out) out.additionalProperties = false;
    return out;
}

/**
 * Best-effort JSON extraction for the fallback path (when the provider didn't
 * already parse it): direct parse → strip a ```json fence → outermost {...} span
 * as a last resort. The span heuristic is loose, so callers MUST re-validate the
 * result against the schema (runLlmJson does) — never trust it raw.
 */
function extractJson(text: string): unknown {
    const tryParse = (s: string): unknown | undefined => {
        try {
            return JSON.parse(s);
        } catch {
            return undefined;
        }
    };
    let v = tryParse(text);
    if (v !== undefined) return v;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
        v = tryParse(fence[1].trim());
        if (v !== undefined) return v;
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        v = tryParse(text.slice(start, end + 1));
        if (v !== undefined) return v;
    }
    return undefined;
}

export interface LlmJsonResult<T> {
    value: T;
    result: LlmResult;
}

/**
 * Schema-constrained generation. Converts the zod schema to a provider-native
 * JSON schema, then parses + validates the result with the same zod schema,
 * retrying once with an error nudge (the design's "schema is a contract; retry
 * on wrong format"). Throws LlmError on refusal or repeated invalid output.
 */
export async function runLlmJson<T>(role: LlmRole, schema: z.ZodType<T>, opts: LlmRunOptions): Promise<LlmJsonResult<T>> {
    const jsonSchema = sanitizeSchema(z.toJSONSchema(schema)) as Record<string, unknown>;
    let lastErr = '';
    // Structured JSON never grounds — grounding ⊻ JSON-mode are mutually exclusive
    // (Gemini 400s if combined and silently ignores the schema). Discovery is a
    // separate grounded runLlm('search') call; this is the structuring pass.
    let maxTokens = opts.maxTokens;

    for (let attempt = 1; attempt <= 2; attempt++) {
        const messages =
            attempt === 1
                ? opts.messages
                : [
                      ...opts.messages,
                      {
                          role: 'user' as const,
                          content: `Your previous reply was unusable (${lastErr}). Reply with ONLY a single valid JSON object matching the schema — no markdown, no commentary.`,
                      },
                  ];

        const result = await runLlm(role, { ...opts, webSearch: false, jsonSchema, messages, maxTokens });
        if (result.finish === 'refusal') throw new LlmError('model refused the request', ROUTE[role].name);

        // Only accept output that finished cleanly — truncated ('length') or
        // filtered output that happens to validate must NOT be returned as success.
        if (result.finish !== 'stop') {
            lastErr = `output did not finish cleanly (finish=${result.finish})`;
            if (result.finish === 'length') maxTokens = Math.min(64000, Math.round((maxTokens ?? 8000) * 1.6));
            log.warn({ role, attempt, finish: result.finish }, 'llm json non-stop finish; retrying');
            continue;
        }

        const candidate = result.json !== undefined ? result.json : extractJson(result.text);
        if (candidate !== undefined) {
            const check = schema.safeParse(candidate);
            if (check.success) return { value: check.data, result };
            lastErr = check.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        } else {
            lastErr = 'output was not parseable JSON';
        }
        log.warn({ role, attempt, lastErr }, 'llm json invalid; retrying');
    }

    throw new LlmError(`structured output failed validation after retries: ${lastErr}`, ROUTE[role].name);
}
