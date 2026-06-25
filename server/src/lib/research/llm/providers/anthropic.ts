/**
 * STRATEGY provider — Anthropic Claude Opus 4.8.
 * ICP synthesis, geography strategy, channel-discovery planning, message drafting.
 * Adaptive thinking on by default; structured output via output_config.format.
 * No temperature/top_p/budget_tokens (removed on Opus 4.8 — would 400).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider, LlmRunOptions, LlmResult, LlmFinish } from '../types.js';
import { LlmError } from '../types.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:llm:anthropic');
const DEFAULT_MODEL = process.env.RESEARCH_STRATEGY_MODEL || 'claude-opus-4-8';

let _client: Anthropic | null = null;
function client(): Anthropic {
    if (!_client) {
        const apiKey = process.env.CLAUDE_KEY;
        if (!apiKey) throw new LlmError('CLAUDE_KEY is not set', 'anthropic');
        _client = new Anthropic({ apiKey });
    }
    return _client;
}

function mapFinish(stop: string | null | undefined): LlmFinish {
    switch (stop) {
        case 'end_turn':
        case 'stop_sequence':
            return 'stop';
        case 'max_tokens':
            return 'length';
        case 'refusal':
            return 'refusal';
        default:
            return 'other';
    }
}

export const anthropicProvider: LlmProvider = {
    name: 'anthropic',
    async run(opts: LlmRunOptions): Promise<LlmResult> {
        const model = opts.model || DEFAULT_MODEL;
        // Anthropic separates system from the user/assistant turns. Fold any
        // 'system'-role messages + opts.system into the top-level system param.
        const sysParts = [opts.system, ...opts.messages.filter((m) => m.role === 'system').map((m) => m.content)]
            .filter((s): s is string => !!s && s.trim().length > 0);
        const system = sysParts.length ? sysParts.join('\n\n') : undefined;
        const msgs = opts.messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        const thinkingOn = opts.thinking !== false;
        const outputConfig: Record<string, unknown> = { effort: opts.effort ?? 'medium' };
        if (opts.jsonSchema) {
            outputConfig.format = { type: 'json_schema', schema: opts.jsonSchema };
        }

        const params: Record<string, unknown> = {
            model,
            max_tokens: opts.maxTokens ?? 16000,
            messages: msgs,
            output_config: outputConfig,
        };
        if (system) params.system = system;
        if (thinkingOn) params.thinking = { type: 'adaptive', display: 'summarized' };

        let resp: Anthropic.Messages.Message;
        try {
            // Cast: newer params (output_config/adaptive thinking) may outpace the SDK's types.
            resp = (await client().messages.create(params as never, { signal: opts.signal })) as Anthropic.Messages.Message;
        } catch (err) {
            throw new LlmError(`anthropic call failed: ${err instanceof Error ? err.message : String(err)}`, 'anthropic', err);
        }

        const finish = mapFinish(resp.stop_reason);
        const text = resp.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('');

        let json: unknown;
        if (opts.jsonSchema && finish === 'stop' && text) {
            try {
                json = JSON.parse(text);
            } catch {
                log.warn({ model }, 'anthropic structured output was not parseable JSON');
            }
        }

        return {
            text,
            json,
            finish,
            provider: 'anthropic',
            model,
            usage: { inputTokens: resp.usage?.input_tokens, outputTokens: resp.usage?.output_tokens },
            raw: resp,
        };
    },
};
