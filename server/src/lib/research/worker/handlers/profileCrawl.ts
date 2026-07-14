/**
 * profile:crawl (WP7) — FAZ 1 website+social crawl → profile.ai_draft.
 *
 * Loads the project's profile.website (+ up to 3 profile.social_links, best-effort), reads
 * the fetched text with the strong/strategy model, and freezes the extraction as
 * profile.ai_draft: a company summary, candidate product/service names, a best-guess home
 * country, and whatever differentiator fields the text supports. This is the pre-fill for
 * FAZ 1's human-approval screens (adım 3-5) — it never writes the customer-approved fields
 * itself.
 *
 * Free setup-time job (no credit gate — COGS is admin-visible only, same split as every
 * other research job). $0 network fetches (fetchPage never throws) + one metered strategy-
 * role LLM call (Claude Opus 4.8 — one call per project, so the cost bump over the cheap
 * reading role is acceptable; it also enforces HARD structured output, unlike DeepSeek).
 *
 * Grounding gate: the model returns each product/service as {name, evidence_quote}, and this
 * handler drops any item unless (a) the evidence_quote itself contains the product name and
 * (b) that quote near-verbatim-appears (after normalization) in a SINGLE fetched page sent to
 * the model — see normalizeForGrounding() below. Requiring the name inside the quote (not just
 * the quote existing somewhere) closes the hole where a generic real quote ("contact us
 * today") could be paired with an unrelated hallucinated name. This makes hallucinated
 * products (e.g. a metal-machining site returning "ceramic floor tiles" with no grounding)
 * structurally impossible to persist, not just prompt-discouraged.
 */
import type { HandlerContext } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { runLlmJson } from '../../llm/index.js';
import { withLlmMeter, type MeteredError } from '../../llm/meter.js';
import { costFromUsageSummary } from '../../engine/pricing.js';
import { fetchPage, type PageResult } from '../../engine/fetch.js';
import { profileCrawlSchema } from '../../profile/schema.js';
import { buildProfileCrawlPrompt, type ProfileCrawlPageInput } from '../../profile/prompt.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:profile-crawl');

/** Best-effort — a dead/blocked social link must not fail the job (only the first 3 are read). */
const MAX_SOCIAL_LINKS = 3;

/**
 * Grounding-gate normalizer — used for the per-page fetched-content haystacks, each candidate
 * evidence_quote, AND the candidate product name, so the comparison is robust to
 * whitespace/punctuation and Unicode-representation differences between how the model quotes
 * text and how it was actually fetched, without weakening the check into a fuzzy match:
 * NFKC-normalize first (so canonically-equivalent precomposed/decomposed accented characters
 * and locale-specific casing quirks — e.g. Turkish dotted/dotless I — line up), lowercase,
 * then collapse any run of non-letter/non-digit characters (unicode-aware — \p{L}/\p{N} keep
 * accented/Turkish/CJK/etc. letters and digits intact) into a single space, then trim. This is
 * near-verbatim / whitespace-and-punctuation-insensitive matching by design, applied
 * identically to both sides — a quote that survives this and still appears in a page's
 * haystack was genuinely present in that source text.
 */
function normalizeForGrounding(text: string): string {
    return text
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/** Punctuation-PRESERVING normalizer (NFKC + case-fold + whitespace-collapse only). Unlike
 *  normalizeForGrounding it does NOT drop punctuation, so a symbol-bearing name like "C++"
 *  stays "c++" and cannot ground against a bare "c" in the source. Used for the strict
 *  name-in-source check; the looser punctuation-insensitive normalizer still governs the
 *  quote-in-page / name-in-quote coherence checks so ordinary formatting variance is tolerated. */
function normalizePreservePunct(text: string): string {
    return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Whole-token containment on normalizeForGrounding() output (single-spaced alnum tokens).
 *  Space-padding both sides makes `phrase` match only on token boundaries, so a short name
 *  like "oil" no longer matches inside "boiler". `phrase` must be non-empty.
 *
 *  ACCEPTED RESIDUAL (deliberate, not an oversight): this is a space-boundary matcher, so
 *  scriptio-continua names written without spaces (e.g. CJK — 茶 inside 本公司销售茶) are
 *  tokenized as one undivided blob and will fail to match even when genuinely present,
 *  causing the item to be DROPPED rather than grounded. This errs safe (a real product is
 *  lost, never a fabricated one persisted) and is out of scope for this Turkish/English
 *  B2B tool's target market. */
function phraseIncludes(haystack: string, phrase: string): boolean {
    if (!phrase) return false;
    return ` ${haystack} `.includes(` ${phrase} `);
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-token containment that treats any non-letter/non-digit (punctuation, whitespace) OR a
 *  string edge as a boundary — for the punctuation-PRESERVED name check, where a legit name like
 *  "c++" abuts prose punctuation ("we sell c++.") yet must still not match mid-token (bare "c"
 *  must not satisfy candidate "c++"). `phrase` is regex-escaped so it is matched literally; the
 *  \p{L}\p{N} lookarounds (u flag) are the Unicode-aware token boundaries. */
function boundedIncludesPreservePunct(haystack: string, phrase: string): boolean {
    if (!phrase) return false;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, 'u');
    return re.test(haystack);
}

export async function profileCrawlHandler({ job, heartbeat }: HandlerContext): Promise<Record<string, unknown>> {
    const projectId = typeof job.payload?.project_id === 'string' ? job.payload.project_id : null;
    if (!projectId) throw new Error('profile:crawl requires payload.project_id');
    const tenantId = job.tenant_id;

    await heartbeat({ stage: 'loading' });

    const { data: project, error: projErr } = await researchSupabaseAdmin
        .from('research_projects')
        .select('id, profile')
        .eq('id', projectId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (projErr) throw projErr;
    if (!project) throw new Error(`profile:crawl: project ${projectId} not found for tenant ${tenantId}`);

    const startProfile = (project.profile ?? {}) as Record<string, unknown>;
    const website = typeof startProfile.website === 'string' ? startProfile.website.trim() : '';
    if (!website) throw new Error(`profile:crawl: project ${projectId} has no profile.website — step 1 requires one`);

    const socialLinks = Array.isArray(startProfile.social_links)
        ? startProfile.social_links.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        : [];
    const socialLinksToFetch = socialLinks.slice(0, MAX_SOCIAL_LINKS);

    // ── Fetch (free — fetchPage never throws, a dead page just returns method:'error') ──
    await heartbeat({ stage: 'crawling_website' });
    const websitePage: PageResult = await fetchPage(website);

    const pages: ProfileCrawlPageInput[] = [{ url: website, page: websitePage }];
    for (let i = 0; i < socialLinksToFetch.length; i++) {
        const link = socialLinksToFetch[i];
        await heartbeat({ stage: 'crawling_social', index: i });
        const page = await fetchPage(link);
        pages.push({ url: link, page });
    }

    const { system, messages } = buildProfileCrawlPrompt({ pages });

    // Metered like geo:analyze: strategy-role spend recorded raw + as a dollar estimate in the
    // job result for the admin margin panel. The catch covers the WHOLE paid section (LLM call
    // + heartbeat + persistence): any failure after the spend warn-logs the tally (captured or
    // the partial withLlmMeter attached to the throw), so a failed-but-paid attempt never
    // disappears from the COGS trail.
    let usage: Awaited<ReturnType<typeof withLlmMeter>>['usage'] | undefined;
    try {
        await heartbeat({ stage: 'summarizing' });
        const metered = await withLlmMeter(() =>
            runLlmJson('strategy', profileCrawlSchema, {
                system,
                messages,
                maxTokens: 8000,
            })
        );
        usage = metered.usage;
        const { value, result } = metered.result;

        // ── Grounding gate ── build per-page haystack arrays from the SAME fetched pages
        // sent to the model (skip dead/empty pages, same filter as pageBlock() in prompt.ts)
        // — kept separate per page (not joined) so a quote/name can never falsely straddle a
        // page boundary via the whitespace normalization. An item only survives if ALL THREE:
        //   1. its cited evidence_quote itself contains the product name (ties the quote to
        //      the name — a generic quote can no longer be laundered onto an unrelated name),
        //   2. that same evidence_quote genuinely appears in SOME single fetched page,
        //   3. the product name ITSELF, with punctuation preserved, also genuinely appears in
        //      SOME single fetched page — this defeats "C++"-style laundering, where stripping
        //      punctuation (as conditions 1-2 do) would let a hallucinated "C++" ground against
        //      a real but unrelated bare "C" in the source. Because this check runs on
        //      punctuation-PRESERVED text, a legit name routinely abuts prose punctuation
        //      ("we sell c++.", "our product is Atlas."), so the match is Unicode letter/digit
        //      -boundary-aware (boundedIncludesPreservePunct) rather than whitespace-only —
        //      accepting punctuation or a string edge as a boundary — while still rejecting a
        //      mid-token match (bare "c" still cannot satisfy candidate "c++"). The model is
        //      already instructed to copy the name verbatim from the source, so this doesn't
        //      over-drop legitimately-copied names.
        // Together these transitively guarantee the product name itself appears, punctuation
        // and all, in the real fetched text — a hallucinated name can no longer piggyback on an
        // unrelated-but-real quote, nor survive by having its punctuation stripped away. This
        // runs BEFORE persistence so an ungrounded/hallucinated item can never reach ai_draft.
        const pageHaystacks = pages
            .filter(({ page }) => page.method !== 'error' && page.content.trim())
            .map(({ page }) => normalizeForGrounding(page.content));
        const rawPageHaystacks = pages
            .filter(({ page }) => page.method !== 'error' && page.content.trim())
            .map(({ page }) => normalizePreservePunct(page.content));
        const droppedNames: string[] = [];
        const gatedProducts: string[] = [];
        for (const item of value.products_services) {
            const nName = normalizeForGrounding(item.name);
            const nQuote = normalizeForGrounding(item.evidence_quote);
            const nNameRaw = normalizePreservePunct(item.name);
            // Token/phrase-boundary-aware (phraseIncludes), not raw substring: normalizeForGrounding()
            // produces single-spaced alnum tokens, so a raw String.includes would let a short name
            // match mid-token (e.g. "oil" inside "boiler"). nName.length > 0 (not a floor like >=2) so
            // legitimate one-character names (e.g. CJK single-character names) aren't dropped — boundary
            // matching alone is enough to reject the mid-token false-positive case.
            const grounded =
                nName.length > 0 &&
                phraseIncludes(nQuote, nName) &&
                pageHaystacks.some((h) => phraseIncludes(h, nQuote)) &&
                rawPageHaystacks.some((h) => boundedIncludesPreservePunct(h, nNameRaw));
            if (grounded) {
                gatedProducts.push(item.name.trim());
            } else {
                droppedNames.push(item.name);
            }
        }
        if (droppedNames.length > 0) {
            log.warn(
                { jobId: job.id, projectId, dropped: droppedNames },
                'profile:crawl grounding gate dropped ungrounded products'
            );
        }
        const cleanedValue = { ...value, products_services: gatedProducts };

        await heartbeat({ stage: 'persisting' });

        // Merge-write: re-read the CURRENT profile right before writing (NOT the copy loaded at
        // job start) — the wizard's own step-1/step-3..6 PATCHes may have written profile keys
        // while this job was crawling. This job ONLY ever writes ai_draft (the frozen raw
        // suggestion) and fills company_country if it is still empty; every customer-approved
        // field (what_they_do, products, differentiators, target_markets, exclusions,
        // contact_name, social_links, or any other existing key) is left untouched — those are
        // written ONLY by the human-confirmed wizard steps. Same pattern as research_icps.ai_draft
        // being frozen server output separate from the human-edited final columns, just inside a
        // JSONB blob instead of separate columns.
        const { data: freshProject, error: freshErr } = await researchSupabaseAdmin
            .from('research_projects')
            .select('profile')
            .eq('id', projectId)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (freshErr) throw freshErr;
        if (!freshProject) throw new Error(`profile:crawl: project ${projectId} vanished before persist`);

        const currentProfile = (freshProject.profile ?? {}) as Record<string, unknown>;

        // Staleness guard (lightweight — this isn't a billing-critical path, so a full
        // job/worker/lease fence like the ICP/geo persist RPCs would be overkill): if the
        // website or social links have changed since this crawl started (another wizard
        // save, or a reaped worker resuming a late/duplicate attempt), the fetched text no
        // longer describes the CURRENT input — skip the write rather than persisting a
        // stale ai_draft for input that's since changed. Worst case without this is a
        // briefly-wrong AI *suggestion*, never a billing/data-integrity issue, but still
        // worth closing cheaply.
        const currentWebsite = typeof currentProfile.website === 'string' ? currentProfile.website.trim() : '';
        const currentSocialLinks = Array.isArray(currentProfile.social_links)
            ? currentProfile.social_links.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, MAX_SOCIAL_LINKS)
            : [];
        const inputChanged = currentWebsite !== website || JSON.stringify(currentSocialLinks) !== JSON.stringify(socialLinksToFetch);

        if (inputChanged) {
            log.warn(
                { jobId: job.id, projectId, crawledWebsite: website, currentWebsite },
                'profile:crawl input changed mid-flight — skipping stale ai_draft write'
            );
            return {
                project_id: projectId,
                skipped: true,
                reason: 'input_changed',
                provider: result.provider,
                model: result.model,
                usage_raw: usage,
                cost_usd: costFromUsageSummary(usage),
            };
        }

        const merged = {
            ...currentProfile,
            ai_draft: cleanedValue,
            company_country: currentProfile.company_country ?? value.company_country,
        };

        const { error: updateErr } = await researchSupabaseAdmin
            .from('research_projects')
            .update({ profile: merged })
            .eq('id', projectId)
            .eq('tenant_id', tenantId);
        if (updateErr) throw updateErr;

        log.info(
            {
                jobId: job.id,
                projectId,
                products: gatedProducts.length,
                hasCountryGuess: !!value.company_country,
                model: result.model,
            },
            'profile:crawl persisted ai_draft'
        );

        return {
            project_id: projectId,
            products_found: gatedProducts.length,
            has_country_guess: !!value.company_country,
            provider: result.provider,
            model: result.model,
            // COGS trail (admin-only downstream: 068 hides result from client reads; the API
            // sanitizer strips usage_raw/cost_usd for non-internal roles).
            usage_raw: usage,
            cost_usd: costFromUsageSummary(usage),
        };
    } catch (err) {
        const partialUsage = usage ?? ((err && typeof err === 'object') ? (err as MeteredError).llmUsage : undefined);
        if (partialUsage && partialUsage.totalCalls > 0) {
            log.warn({ jobId: job.id, usage_raw: partialUsage }, 'profile:crawl failed after spending — partial COGS');
        }
        throw err;
    }
}
