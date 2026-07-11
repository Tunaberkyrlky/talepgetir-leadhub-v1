/**
 * profile:crawl (WP7) — FAZ 1 website+social crawl → profile.ai_draft.
 *
 * Loads the project's profile.website (+ up to 3 profile.social_links, best-effort), reads
 * the fetched text with the reading model, and freezes the extraction as profile.ai_draft:
 * a company summary, candidate product/service names, a best-guess home country, and
 * whatever differentiator fields the text supports. This is the pre-fill for FAZ 1's
 * human-approval screens (adım 3-5) — it never writes the customer-approved fields itself.
 *
 * Free setup-time job (no credit gate — COGS is admin-visible only, same split as every
 * other research job). $0 network fetches (fetchPage never throws) + one metered reading-
 * role LLM call.
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

    // Metered like geo:analyze: reading-role spend recorded raw + as a dollar estimate in the
    // job result for the admin margin panel. The catch covers the WHOLE paid section (LLM call
    // + heartbeat + persistence): any failure after the spend warn-logs the tally (captured or
    // the partial withLlmMeter attached to the throw), so a failed-but-paid attempt never
    // disappears from the COGS trail.
    let usage: Awaited<ReturnType<typeof withLlmMeter>>['usage'] | undefined;
    try {
        await heartbeat({ stage: 'summarizing' });
        const metered = await withLlmMeter(() =>
            runLlmJson('reading', profileCrawlSchema, {
                system,
                messages,
                maxTokens: 4000,
            })
        );
        usage = metered.usage;
        const { value, result } = metered.result;

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
            ai_draft: value,
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
                products: value.products_services.length,
                hasCountryGuess: !!value.company_country,
                model: result.model,
            },
            'profile:crawl persisted ai_draft'
        );

        return {
            project_id: projectId,
            products_found: value.products_services.length,
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
