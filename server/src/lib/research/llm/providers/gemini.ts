/**
 * SEARCH provider — Google Gemini 3.1 Pro with Google Search grounding.
 * Web discovery/scanning. Returns text + citations + the executed search queries
 * (needed for per-query cost attribution).
 *
 * Hard constraint: grounding and JSON mode are mutually exclusive (400 if combined).
 * So the search role returns grounded text + citations; structured extraction is a
 * separate non-grounded pass (router/handler concern), not done here.
 *
 * @google/genai is ESM-only; this server is CommonJS, so the SDK is loaded via a
 * dynamic import() (allowed from CJS) and the value import is avoided.
 */
import type { LlmProvider, LlmRunOptions, LlmResult, LlmFinish, LlmCitation } from '../types.js';
import { LlmError } from '../types.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:llm:gemini');
const DEFAULT_MODEL = process.env.RESEARCH_SEARCH_MODEL || 'gemini-3.1-pro-preview';

// @google/genai is ESM-only; typed import from this CJS module needs resolution-mode
// gymnastics, so it's loaded untyped via dynamic import() and guarded at runtime.
let _mod: any = null;
let _client: any = null;

async function client(): Promise<any> {
    if (!_mod) _mod = await import('@google/genai');
    if (!_client) {
        const apiKey = process.env.GEMINI_KEY;
        if (!apiKey) throw new LlmError('GEMINI_KEY is not set', 'gemini');
        _client = new _mod.GoogleGenAI({ apiKey });
    }
    return _client;
}

/** Gemini 3.1 Pro supports thinkingLevel low|medium|high ('minimal' unsupported). */
function thinkingLevel(effort: LlmRunOptions['effort']): 'low' | 'medium' | 'high' {
    switch (effort) {
        case 'medium':
            return 'medium';
        case 'high':
        case 'xhigh':
        case 'max':
            return 'high';
        default:
            return 'low'; // search/scan defaults to cheap
    }
}

function mapFinish(reason: string | undefined, hasText: boolean): LlmFinish {
    switch (reason) {
        case 'STOP':
            return 'stop';
        case 'MAX_TOKENS':
            return 'length';
        case 'SAFETY':
        case 'RECITATION':
        case 'BLOCKLIST':
        case 'PROHIBITED_CONTENT':
        case 'SPII':
            return 'filtered';
        default:
            return hasText ? 'stop' : 'other';
    }
}

export const geminiProvider: LlmProvider = {
    name: 'gemini',
    async run(opts: LlmRunOptions): Promise<LlmResult> {
        const model = opts.model || DEFAULT_MODEL;
        const ai = await client();

        const systemParts = [opts.system, ...opts.messages.filter((m) => m.role === 'system').map((m) => m.content)]
            .filter((s): s is string => !!s && s.trim().length > 0);
        const contents = opts.messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

        const config: Record<string, unknown> = { thinkingLevel: opts.thinking === false ? 'low' : thinkingLevel(opts.effort) };
        if (systemParts.length) config.systemInstruction = systemParts.join('\n\n');
        if (opts.maxTokens) config.maxOutputTokens = opts.maxTokens;
        if (opts.signal) config.abortSignal = opts.signal;

        // grounding ⊻ JSON: prefer grounding for the search role.
        if (opts.webSearch) {
            config.tools = [{ googleSearch: {} }];
            if (opts.jsonSchema) log.warn('jsonSchema ignored on grounded search call (grounding ⊻ JSON mode)');
        } else if (opts.jsonSchema) {
            config.responseMimeType = 'application/json';
            config.responseSchema = opts.jsonSchema;
        }

        let resp: Record<string, any>;
        try {
            resp = (await ai.models.generateContent({ model, contents, config } as never)) as Record<string, any>;
        } catch (err) {
            const status = _mod && err instanceof _mod.ApiError ? (err as { status?: number }).status : undefined;
            throw new LlmError(
                `gemini call failed${status ? ` (${status})` : ''}: ${err instanceof Error ? err.message : String(err)}`,
                'gemini',
                err
            );
        }

        const text: string = typeof resp.text === 'string' ? resp.text : '';
        const cand = Array.isArray(resp.candidates) ? resp.candidates[0] : undefined;
        const finish = mapFinish(cand?.finishReason, !!text);

        const gm = cand?.groundingMetadata;
        const searchQueries: string[] = Array.isArray(gm?.webSearchQueries) ? gm.webSearchQueries : [];
        const citations: LlmCitation[] = Array.isArray(gm?.groundingChunks)
            ? gm.groundingChunks
                  .map((c: any) => c?.web)
                  .filter((w: any) => w && (w.uri || w.title))
                  .map((w: any) => ({ url: w.uri, title: w.title }))
            : [];

        let json: unknown;
        if (opts.jsonSchema && !opts.webSearch && finish === 'stop' && text) {
            try {
                json = JSON.parse(text);
            } catch {
                log.warn({ model }, 'gemini JSON output not parseable');
            }
        }

        const um = resp.usageMetadata;
        // Gemini bills THINKING tokens at the OUTPUT rate but reports them in thoughtsTokenCount,
        // SEPARATE from candidatesTokenCount. Grounded search always runs with thinking on
        // (thinkingLevel >= 'low'), so thoughtsTokenCount is reliably > 0 — folding it in is
        // mandatory or the dominant grounded-search COGS undercounts in the UNDERPRICING direction,
        // and the count is dropped at this boundary (unrecoverable from usage_raw). Tool-use prompt
        // tokens (the grounding tool's input) bill at the INPUT rate — include them too.
        const inputTokens = (um?.promptTokenCount ?? 0) + (um?.toolUsePromptTokenCount ?? 0);
        const outputTokens = (um?.candidatesTokenCount ?? 0) + (um?.thoughtsTokenCount ?? 0);
        return {
            text,
            json,
            finish,
            provider: 'gemini',
            model,
            usage: { inputTokens, outputTokens },
            citations: citations.length ? citations : undefined,
            searchQueries: searchQueries.length ? searchQueries : undefined,
            raw: resp,
        };
    },
};
