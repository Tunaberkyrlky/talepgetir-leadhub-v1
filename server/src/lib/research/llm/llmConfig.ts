/**
 * Per-role model configuration for the LLM router.
 *
 * The router (router.ts) binds each ROLE to a fixed PROVIDER (strategy→Anthropic,
 * search→Gemini, reading→DeepSeek) — that's a code-level design decision and is NOT
 * operator-editable. The MODEL that provider runs, however, is now operator-tunable
 * from the admin COGS panel: an override row in research_llm_config wins; otherwise
 * the env default applies (mirrors each provider's own DEFAULT_MODEL fallback exactly,
 * so an absent override reproduces the pre-config behavior).
 *
 * Reads are cached (short TTL) so the router's hot path doesn't hit the DB per call.
 * A config write invalidates the cache so the change takes effect immediately.
 * A failed read NEVER throws into the router — it falls back to env defaults.
 */
import { researchSupabaseAdmin } from '../supabase.js';
import type { LlmRole } from './types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('research:llm:config');

export const LLM_ROLES: readonly LlmRole[] = ['strategy', 'search', 'reading'] as const;

/** Provider bound to each role in the router (mirror of ROUTE — kept here so the admin
 *  panel can show step→provider→model without importing the provider instances). */
export const ROLE_PROVIDER: Record<LlmRole, string> = {
    strategy: 'anthropic',
    search: 'gemini',
    reading: 'deepseek',
};

/** Human label per provider, for the panel. */
export const PROVIDER_LABEL: Record<string, string> = {
    anthropic: 'Anthropic',
    gemini: 'Google Gemini',
    deepseek: 'DeepSeek',
};

/** Env default per role — MUST match each provider's DEFAULT_MODEL literal + env var,
 *  or resolving through here would silently change behavior for an unconfigured role. */
export function envDefaultModel(role: LlmRole): string {
    switch (role) {
        case 'strategy':
            return process.env.RESEARCH_STRATEGY_MODEL || 'claude-opus-4-8';
        case 'search':
            return process.env.RESEARCH_SEARCH_MODEL || 'gemini-3.1-pro-preview';
        case 'reading':
            return process.env.RESEARCH_READING_MODEL || 'deepseek-v4-pro';
    }
}

export interface ModelChoice {
    value: string;
    label: string;
}

/** Curated model suggestions per role for the dropdown. Provider is fixed, so every
 *  entry must be a model the role's provider can run. The panel also allows a custom
 *  ID (validated by MODEL_ID_RE) — this list is convenience, not an allow-list. */
export const MODEL_CATALOG: Record<LlmRole, ModelChoice[]> = {
    strategy: [
        { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
        { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
        { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
        { value: 'claude-fable-5', label: 'Claude Fable 5' },
    ],
    search: [
        { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
        { value: 'gemini-3.1-flash-preview', label: 'Gemini 3.1 Flash' },
    ],
    reading: [
        { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
        { value: 'deepseek-chat', label: 'DeepSeek Chat' },
    ],
};

/** A model id the operator may set. Conservative charset (provider ids are ascii
 *  slugs). Matches the DB CHECK (non-empty, ≤120). Free-form on purpose: the operator
 *  owns correctness of a custom id, exactly as the env override already was. */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export function isValidModelId(model: string): boolean {
    return typeof model === 'string' && MODEL_ID_RE.test(model.trim());
}

// ── override cache ───────────────────────────────────────────────────────────
// Design notes (codex P2 x2):
//  - Request coalescing: a single in-flight load is shared by all concurrent callers, so a
//    cache miss (startup / TTL expiry) issues ONE DB query, not one per in-flight LLM call.
//  - Generation guard: invalidateLlmConfigCache() bumps `generation`; a load that started
//    before an invalidation will NOT publish its (now-possibly-stale) result to the cache, and
//    a caller arriving after the invalidation starts a fresh load rather than joining the old one.
//    Staleness is bounded by TTL and process-local — other instances (e.g. the worker) pick up a
//    config change within TTL_MS. Good enough: model changes are rare and not safety-critical.
const TTL_MS = 30_000;
type OverrideMap = Partial<Record<LlmRole, string>>;
let cache: { at: number; map: OverrideMap } | null = null;
let generation = 0;
let inFlight: Promise<OverrideMap> | null = null;
let inFlightGen = -1;

async function loadOverrides(): Promise<OverrideMap> {
    const now = Date.now();
    if (cache && now - cache.at < TTL_MS) return cache.map;
    if (inFlight && inFlightGen === generation) return inFlight;

    const gen = generation;
    inFlightGen = gen;
    inFlight = (async () => {
        try {
            const { data, error } = await researchSupabaseAdmin
                .from('research_llm_config')
                .select('role, model');
            if (error) throw error;
            const map: OverrideMap = {};
            for (const row of (data ?? []) as Array<{ role: LlmRole; model: string }>) {
                if (LLM_ROLES.includes(row.role) && isValidModelId(row.model)) map[row.role] = row.model.trim();
            }
            // Publish only if no invalidation happened while we were loading.
            if (generation === gen) cache = { at: Date.now(), map };
            return map;
        } catch (err) {
            // Never throw into the router: fall back to env defaults. Reuse any previously
            // cached map (or empty) and briefly cache it so we don't hammer a down DB.
            log.warn({ err }, 'llm config load failed; falling back to env defaults');
            const fallback = cache?.map ?? {};
            if (generation === gen) cache = { at: Date.now(), map: fallback };
            return fallback;
        } finally {
            if (inFlightGen === gen) inFlight = null;
        }
    })();
    return inFlight;
}

/** Resolve the model for a role: configured override → env default. Never throws. */
export async function getModelForRole(role: LlmRole): Promise<string> {
    const overrides = await loadOverrides();
    return overrides[role] ?? envDefaultModel(role);
}

/** Current resolved model per role, with its source — for the admin panel. */
export async function getRoleModels(): Promise<
    Record<LlmRole, { model: string; source: 'override' | 'default'; provider: string }>
> {
    const overrides = await loadOverrides();
    const out = {} as Record<LlmRole, { model: string; source: 'override' | 'default'; provider: string }>;
    for (const role of LLM_ROLES) {
        const override = overrides[role];
        out[role] = {
            model: override ?? envDefaultModel(role),
            source: override ? 'override' : 'default',
            provider: ROLE_PROVIDER[role],
        };
    }
    return out;
}

/** Drop the cache so the next resolve re-reads the table (call after a config write). Bumps
 *  the generation so any in-flight load started earlier won't repopulate the cache with a
 *  pre-write value, and the next caller starts a fresh load instead of joining the old one. */
export function invalidateLlmConfigCache(): void {
    cache = null;
    generation += 1;
}
