/**
 * READING provider — DeepSeek V4 Pro (OpenAI-compatible at api.deepseek.com).
 * High-token bulk: read company text, classify MATCH/PARTIAL/ELIMINATED, summarize, extract.
 *
 * JSON: response_format json_object (the word "json" MUST appear in the prompt + an example),
 * and thinking is disabled for strict JSON (reasoning modes are more prone to empty/wrapped
 * output). Never echo `reasoning_content` back into a later turn (400).
 */
import OpenAI from 'openai';
import type { LlmProvider, LlmRunOptions, LlmResult, LlmFinish } from '../types.js';
import { LlmError } from '../types.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:llm:deepseek');
const DEFAULT_MODEL = process.env.RESEARCH_READING_MODEL || 'deepseek-v4-pro';
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

let _client: OpenAI | null = null;
function client(): OpenAI {
    if (!_client) {
        const apiKey = process.env.DEEPSEEK_KEY;
        if (!apiKey) throw new LlmError('DEEPSEEK_KEY is not set', 'deepseek');
        // maxRetries: 0 — the OpenAI SDK retries (default 2) below this boundary, so one logical
        // run() could be several physical HTTP attempts that the router meter records only once
        // (it would undercount COGS). Disable SDK retries so one run() == one metered call. The
        // pilot is re-runnable; if production wants retries, add them ABOVE the meter (in runLlm)
        // so each attempt is recorded.
        _client = new OpenAI({ apiKey, baseURL: BASE_URL, maxRetries: 0 });
    }
    return _client;
}

function mapFinish(reason: string | null | undefined): LlmFinish {
    switch (reason) {
        case 'stop':
            return 'stop';
        case 'length':
            return 'length';
        case 'content_filter':
            return 'filtered';
        default:
            // includes 'insufficient_system_resource' (server overload — retryable) + 'tool_calls'
            return 'other';
    }
}

export const deepseekProvider: LlmProvider = {
    name: 'deepseek',
    async run(opts: LlmRunOptions): Promise<LlmResult> {
        const model = opts.model || DEFAULT_MODEL;

        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
        const sysParts = [opts.system].filter((s): s is string => !!s && s.trim().length > 0);
        if (opts.jsonSchema) {
            // Mandatory: mention "json" + give the schema so output is parseable.
            sysParts.push(
                `Respond with ONLY a single valid JSON object — no markdown, no prose — matching this JSON Schema:\n${JSON.stringify(opts.jsonSchema)}`
            );
        }
        if (sysParts.length) messages.push({ role: 'system', content: sysParts.join('\n\n') });
        for (const m of opts.messages) messages.push({ role: m.role, content: m.content });

        // Strict JSON → disable thinking (reliability). Otherwise default thinking on (reasoning),
        // unless the caller turned it off.
        const thinkingOn = opts.thinking ?? !opts.jsonSchema;

        const params: Record<string, unknown> = {
            model,
            messages,
            max_tokens: opts.maxTokens ?? 8000,
            // DeepSeek extensions (not in OpenAI's TS types) — forwarded verbatim.
            thinking: { type: thinkingOn ? 'enabled' : 'disabled' },
        };
        if (thinkingOn && opts.effort) {
            params.reasoning_effort = opts.effort === 'max' || opts.effort === 'xhigh' ? 'max' : 'high';
        }
        if (opts.jsonSchema) params.response_format = { type: 'json_object' };

        let resp: OpenAI.Chat.Completions.ChatCompletion;
        try {
            resp = (await client().chat.completions.create(params as never, { signal: opts.signal })) as OpenAI.Chat.Completions.ChatCompletion;
        } catch (err) {
            const status = err instanceof OpenAI.APIError ? err.status : undefined;
            throw new LlmError(`deepseek call failed${status ? ` (${status})` : ''}: ${err instanceof Error ? err.message : String(err)}`, 'deepseek', err);
        }

        const choice = resp.choices?.[0];
        const text = choice?.message?.content ?? '';
        const finish = mapFinish(choice?.finish_reason);

        let json: unknown;
        if (opts.jsonSchema && text.trim()) {
            try {
                json = JSON.parse(text);
            } catch {
                log.warn({ model }, 'deepseek JSON output not parseable');
            }
        }

        // DeepSeek auto-caches the (large, constant) validation system prefix and bills cache hits
        // ~10x cheaper than misses. prompt_tokens is the BLENDED total; the hit count is a DeepSeek
        // extension (top-level prompt_cache_hit_tokens, also in prompt_tokens_details.cached_tokens).
        // Capture the cached subset so usage_raw can reconcile input COGS against the real invoice's
        // hit/miss split — pricing.ts keeps the dollar figures blended (conservative overcount).
        const u = resp.usage as (typeof resp.usage & { prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }) | undefined;
        const cachedInputTokens = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens;
        return {
            text,
            json,
            finish,
            provider: 'deepseek',
            model,
            usage: { inputTokens: resp.usage?.prompt_tokens, cachedInputTokens, outputTokens: resp.usage?.completion_tokens },
            raw: resp,
        };
    },
};
