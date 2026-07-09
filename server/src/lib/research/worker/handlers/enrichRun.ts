/**
 * enrich:run — Hunter contact enrichment for customer-selected companies.
 *
 * Cost discipline is the design center (the Hunter allowance is small and every
 * domain-search request is one Hunter credit):
 *   • fully-enriched companies (once-ever event + persisted Hunter contacts) are FREE
 *     skips — no request; an event WITHOUT contacts (a crash between bill and insert)
 *     is a BACKFILL: one request, contacts persisted, the bill call dedups to no charge;
 *   • one request per company, no pagination, no retry;
 *   • the loop never fires more requests than the run cap AND (for fresh charges) the
 *     hold actually reserved — a Hunter request without a credit behind it is a leak;
 *   • a Hunter quota/auth refusal STOPS the loop (partial success, flagged);
 *   • STRICT DOMAIN MATCH: Hunter's echoed domain must equal the company's registrable
 *     domain, else nothing persists and nothing is billed.
 *
 * Billing mirrors the MATCH spine, with a stricter order (codex P1): a company is
 * billed ONLY when Hunter yields contacts the tenant does NOT already have (novelty
 * gate), and the fenced research_bill_enrichment RPC runs BEFORE contacts persist —
 * a suppressed/fenced refusal therefore persists nothing. Ranking: the customer's
 * ordered title buckets (multilingual keyword bundles) + optional custom keywords;
 * leftover cap slots fill with the highest-confidence unmatched personals. Generic
 * (info@…) addresses are counted but never persisted.
 */
import type { HandlerContext, JobHandler } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { createLogger } from '../../../logger.js';
import {
    reserveHold, settleHold, releaseHold, billEnrichment, enrichedCanonicalKeys,
    ReservationExhaustedError, InsufficientCreditsError, type HoldRow,
} from '../../engine/ledger.js';
import { hunterDomainSearch, HunterQuotaError, HunterConfigError, type HunterEmail } from '../../enrichment/hunter.js';
import { matchTitleBucket, isKnownBucket } from '../../enrichment/titleBundles.js';

const log = createLogger('research:handler:enrich-run');

const MAX_COMPANIES = 50;
const DEFAULT_MAX_CONTACTS = 3;
const MAX_CONTACTS_CEILING = 10;

interface EnrichPayload {
    company_ids?: unknown;
    title_buckets?: unknown;
    custom_keywords?: unknown;
    max_contacts?: unknown;
}

interface CompanyRow {
    id: string;
    canonical_key: string;
    name: string;
    domain: string | null;
    suppressed: boolean;
}

function asStringArray(v: unknown, cap: number): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, cap);
}

export const enrichRunHandler: JobHandler = async ({ job, heartbeat }: HandlerContext) => {
    const tenantId = job.tenant_id;
    const payload = (job.payload ?? {}) as EnrichPayload;

    const companyIds = [...new Set(asStringArray(payload.company_ids, MAX_COMPANIES))];
    if (companyIds.length === 0) throw new Error('enrich:run requires company_ids');
    const buckets = asStringArray(payload.title_buckets, 8).filter(isKnownBucket);
    const customKeywords = asStringArray(payload.custom_keywords, 20).map((k) => k.slice(0, 40));
    const maxContacts = Math.min(
        Math.max(typeof payload.max_contacts === 'number' ? Math.floor(payload.max_contacts) : DEFAULT_MAX_CONTACTS, 1),
        MAX_CONTACTS_CEILING
    );

    // The running attempt's fence identity — every bill call proves it.
    if (!job.locked_by || !job.lease) throw new Error('enrich:run requires a fenced running attempt');
    const fence = { jobId: job.id, worker: job.locked_by, lease: job.lease };

    await heartbeat({ stage: 'loading', companies: companyIds.length });
    const { data: rows, error: compErr } = await researchSupabaseAdmin
        .from('research_companies')
        .select('id, canonical_key, name, domain, suppressed')
        .eq('tenant_id', tenantId)
        .in('id', companyIds);
    if (compErr) throw compErr;
    const companies = (rows ?? []) as CompanyRow[];

    const alreadyEnriched = await enrichedCanonicalKeys(tenantId, companies.map((c) => c.canonical_key));

    // Companies that already carry PERSISTED Hunter contacts. An enrichment event without
    // them marks a bill→insert crash: those re-run as FREE backfill (dedup bill, no charge).
    const withHunterContacts = new Set<string>();
    for (let i = 0; i < companies.length; i += 50) {
        const chunk = companies.slice(i, i + 50).map((c) => c.id);
        const { data, error } = await researchSupabaseAdmin
            .from('research_contacts')
            .select('company_id')
            .eq('tenant_id', tenantId)
            .eq('source', 'hunter')
            .in('company_id', chunk);
        if (error) throw error;
        for (const r of (data ?? []) as Array<{ company_id: string }>) withHunterContacts.add(r.company_id);
    }

    const summary = {
        companies_requested: companyIds.length,
        companies_not_found: companyIds.length - companies.length,
        skipped_suppressed: 0,
        skipped_no_domain: 0,
        skipped_already_enriched: 0,
        eligible: 0,
        backfilled: 0,
        capped_by_run_limit: 0,
        capped_by_credits: 0,
        hunter_requests: 0,
        domain_mismatches: 0,
        generic_skipped: 0,
        nothing_new: 0,
        contacts_persisted: 0,
        companies_billed: 0,
        reservation_exhausted: false,
        hunter_quota_exhausted: false,
    };

    const backfillList: CompanyRow[] = [];
    let freshList: CompanyRow[] = [];
    for (const c of companies) {
        if (c.suppressed) { summary.skipped_suppressed++; continue; }
        if (!c.domain) { summary.skipped_no_domain++; continue; }
        if (alreadyEnriched.has(c.canonical_key)) {
            if (withHunterContacts.has(c.id)) { summary.skipped_already_enriched++; continue; }
            backfillList.push(c);
            continue;
        }
        freshList.push(c);
    }

    // Account guard: one run can never fire more Hunter requests than the operator allows —
    // the external allowance is tiny and shared across every tenant on this deployment.
    // Backfills go first (they are already paid for); fresh companies take the remaining slots.
    const runCap = Math.max(1, Math.floor(Number(process.env.RESEARCH_HUNTER_RUN_CAP) || 25));
    const backfills = backfillList.slice(0, runCap);
    let fresh = freshList.slice(0, Math.max(runCap - backfills.length, 0));
    summary.capped_by_run_limit = (backfillList.length - backfills.length) + (freshList.length - fresh.length);

    // Admission for FRESH charges only (backfills never consume the reservation). The hold's
    // actual `reserved` clamps the fresh list (codex P1): no Hunter request may fire for a
    // company whose credit was never reserved.
    let hold: HoldRow | null = null;
    if (fresh.length > 0) {
        hold = await reserveHold({ tenantId, jobId: job.id, estimate: fresh.length, minRequired: 1 }).catch((err) => {
            if (err instanceof InsufficientCreditsError) throw new Error('insufficient research credits to start enrichment');
            throw err;
        });
        if (fresh.length > hold.reserved) {
            summary.capped_by_credits = fresh.length - hold.reserved;
            fresh = fresh.slice(0, hold.reserved);
        }
    }

    const work: Array<{ company: CompanyRow; isBackfill: boolean }> = [
        ...backfills.map((company) => ({ company, isBackfill: true })),
        ...fresh.map((company) => ({ company, isBackfill: false })),
    ];
    summary.eligible = work.length;
    if (work.length === 0) {
        if (hold) await settleHold(hold.id, fence);
        return summary;
    }

    try {
        for (let i = 0; i < work.length; i++) {
            const { company, isBackfill } = work[i];
            await heartbeat({ stage: 'enriching', done: i, total: work.length });

            let result;
            try {
                result = await hunterDomainSearch(company.domain!, Math.min(maxContacts * 3, 100));
                summary.hunter_requests++;
            } catch (err) {
                if (err instanceof HunterQuotaError || err instanceof HunterConfigError) {
                    summary.hunter_quota_exhausted = true;
                    log.warn({ jobId: job.id, companyId: company.id }, 'hunter unavailable — stopping enrichment loop');
                    break;
                }
                // A single-company transport failure skips that company (no bill), run continues.
                log.warn({ err: err instanceof Error ? err.message : err, companyId: company.id, jobId: job.id }, 'hunter request failed — company skipped');
                summary.hunter_requests++;
                continue;
            }

            // STRICT domain match — Hunter normalizes/redirects; anything but our registrable
            // domain is another organization's data and must not be persisted or billed.
            if (!result.domain || result.domain !== company.domain!.toLowerCase()) {
                summary.domain_mismatches++;
                continue;
            }

            const personals = result.emails.filter((e) => e.type === 'personal');
            summary.generic_skipped += result.emails.length - personals.length;

            const ranked = personals
                .map((e) => ({ e, match: matchTitleBucket(e.position, buckets, customKeywords) }))
                .sort((a, b) => {
                    const pa = a.match?.priority ?? Number.MAX_SAFE_INTEGER;
                    const pb = b.match?.priority ?? Number.MAX_SAFE_INTEGER;
                    if (pa !== pb) return pa - pb;
                    return (b.e.confidence ?? 0) - (a.e.confidence ?? 0);
                })
                .slice(0, maxContacts);
            if (ranked.length === 0) continue; // nothing worth persisting → no bill

            // Novelty gate (codex P1, verify round): the charge requires an email the TENANT
            // does not have ANYWHERE — the same address under another company/source is not
            // new information. One query over the ranked emails yields both sets: tenant-wide
            // (bills) and company-scoped (insert dedup; the unique index is PARTIAL, so
            // filtering beats ON CONFLICT inference).
            // hunter.ts lowercases every email at the boundary; DB rows from scrape/manual may
            // be mixed-case, so the lookup is case-insensitive (ilike without wildcards ==
            // case-insensitive equality). PostgREST or-syntax breaks on , ( ) — an email
            // carrying those (RFC-exotic) is skipped from the lookup and treated as novel.
            const rankedEmails = ranked.map(({ e }) => e.value).filter((v) => !/[,()]/.test(v));
            let existingRows: Array<{ company_id: string; email: string }> = [];
            if (rankedEmails.length > 0) {
                const { data, error: exErr } = await researchSupabaseAdmin
                    .from('research_contacts')
                    .select('company_id, email')
                    .eq('tenant_id', tenantId)
                    .or(rankedEmails.map((v) => `email.ilike.${v}`).join(','));
                if (exErr) throw exErr;
                existingRows = (data ?? []) as Array<{ company_id: string; email: string }>;
            }
            const tenantEmails = new Set<string>();
            const companyEmails = new Set<string>();
            for (const r of existingRows) {
                const em = r.email.toLowerCase();
                tenantEmails.add(em);
                if (r.company_id === company.id) companyEmails.add(em);
            }
            const novel = ranked.filter(({ e }) => !tenantEmails.has(e.value));
            if (novel.length === 0) { summary.nothing_new++; continue; }
            const freshContacts = ranked.filter(({ e }) => !companyEmails.has(e.value));

            // BILL BEFORE PERSIST (codex P1): a suppressed/fenced refusal must leave no data
            // behind. Backfills dedup inside the RPC (existing event returns, no hold touched).
            // The billed count is the tenant-NOVEL emails; persisted rows may add company-new
            // linkage rows the tenant already knew elsewhere (bonus, not a charge dimension).
            const billed = await billEnrichment({
                companyId: company.id,
                jobId: fence.jobId,
                holdId: hold?.id ?? null,
                worker: fence.worker,
                lease: fence.lease,
                contactsCount: novel.length,
            }).catch((err) => {
                if (err instanceof ReservationExhaustedError) {
                    summary.reservation_exhausted = true;
                    return 'stop' as const;
                }
                throw err;
            });
            if (billed === 'stop') break;
            if (!billed) continue; // suppressed/ineligible — nothing persisted

            const inserts = freshContacts.map(({ e, match }: { e: HunterEmail; match: { bucket: string; priority: number } | null }) => ({
                tenant_id: tenantId,
                company_id: company.id,
                job_id: job.id,
                source: 'hunter',
                email: e.value,
                name: [e.first_name, e.last_name].filter(Boolean).join(' ') || null,
                title: e.position,
                seniority: e.seniority,
                department: e.department,
                confidence: e.confidence,
                title_bucket: match?.bucket ?? null,
                // Lower = higher priority in the UI: 0 custom, 1.. buckets, 999 unranked fill.
                priority: match?.priority ?? 999,
                domain: result.domain,
                email_type: e.type,
            }));
            // If this insert fails the job fails AFTER the (idempotent) bill — the next run
            // sees event-without-contacts and BACKFILLS for free, so nothing is lost or re-charged.
            const { error: insErr } = await researchSupabaseAdmin.from('research_contacts').insert(inserts);
            if (insErr) throw insErr;
            summary.contacts_persisted += inserts.length;
            if (isBackfill) summary.backfilled++;
            else summary.companies_billed++;
        }

        if (hold) await settleHold(hold.id, fence);
        log.info({ jobId: job.id, ...summary }, 'enrich:run complete');
        return summary;
    } catch (err) {
        if (hold) {
            await releaseHold(hold.id, fence).catch((relErr) =>
                log.warn({ err: relErr, holdId: hold!.id, jobId: job.id }, 'releaseHold failed after enrichment error')
            );
        }
        throw err;
    }
};
