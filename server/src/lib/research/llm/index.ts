/**
 * TG-Research LLM layer — public surface.
 * Use runLlm / runLlmJson with a ROLE; never import a provider directly.
 */
export type {
    LlmRole,
    LlmMessage,
    LlmCitation,
    LlmUsage,
    LlmFinish,
    LlmRunOptions,
    LlmResult,
    LlmProvider,
} from './types.js';
export { LlmError } from './types.js';
export { runLlm, runLlmJson, llmProviderFor } from './router.js';
export type { LlmJsonResult } from './router.js';
