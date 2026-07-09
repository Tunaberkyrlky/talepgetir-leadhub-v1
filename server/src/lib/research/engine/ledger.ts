/**
 * Engine ledger writes (Y1+). The ONLY place the harvest touches company/verdict/billing state,
 * and it goes through the hardened RPCs from 062 so the locked invariants hold:
 *   • company writes  → research_upsert_company  (suppression-checked under the per-tenant lock)
 *   • billing         → research_bill_match       (bills a CURRENT, APPROVED, unsuppressed MATCH
 *                                                  once-ever; writes the ledger decrement atomically)
 *   • credits         → research_grant_credits / research_credit_balance
 * Verdicts are inserted directly (service-role bypasses RLS; the table is user-SELECT-only).
 * Search COGS is appended to research_search_log (per-tenant).
 */
import { researchSupabaseAdmin } from '../supabase.js';
import { createLogger } from '../../logger.js';
import type { Verdict } from './validate.js';

const log = createLogger('research:engine:ledger');

export interface CompanyRow {
    id: string;
    tenant_id: string;
    canonical_key: string;
    status: string;
}

export interface UpsertCompanyInput {
    tenantId: string;
    canonicalKey: string;
    projectId?: string | null;
    domain?: string | null;
    name: string;
    website?: string | null;
    country?: string | null;
    city?: string | null;
    phone?: string | null;
    address?: string | null;
    /** null preserves an existing rollup status; a new row defaults to review in the RPC. */
    status: string | null;
    score?: number | null;
    siteSummary?: string | null;
    evidence?: string | null;
    eliminationReason?: string | null;
    icpId?: string | null;
    geoId?: string | null;
    sourcePath?: string | null;
    /** Y1 channel provenance (WP3/092): which list source produced this firm. COALESCE
     *  semantics in the RPC — a later non-channel run never clears an existing ref. */
    channelId?: string | null;
    /** The running attempt's fence identity (070) — the RPC refuses unfenced rollup writes. */
    jobId: string;
    worker: string;
    lease: string;
}

/** Distinguish "blocked by suppression" (expected, skip) from a real DB error (throw). */
export class SuppressedError extends Error {}

/** Upsert a company through the race-safe, lease-fenced RPC (070). Throws SuppressedError if the
 *  key is suppressed; a lost lease is a hard error (zombie attempt — abort the run). */
export async function upsertCompany(input: UpsertCompanyInput): Promise<CompanyRow> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_upsert_company', {
        p_tenant: input.tenantId,
        p_canonical_key: input.canonicalKey,
        p_project_id: input.projectId ?? null,
        p_domain: input.domain ?? null,
        p_name: input.name,
        p_website: input.website ?? null,
        p_country: input.country ?? null,
        p_city: input.city ?? null,
        p_phone: input.phone ?? null,
        p_address: input.address ?? null,
        p_status: input.status,
        p_score: input.score ?? null,
        p_site_summary: input.siteSummary ?? null,
        p_evidence: input.evidence ?? null,
        p_elimination_reason: input.eliminationReason ?? null,
        p_icp_id: input.icpId ?? null,
        p_geo_id: input.geoId ?? null,
        p_source_path: input.sourcePath ?? null,
        p_job_id: input.jobId,
        p_worker: input.worker,
        p_lease: input.lease,
        p_channel: input.channelId ?? null,
    });
    if (error) {
        // Structured suppression marker (069/070). The insert-trigger path (060) has no DETAIL,
        // so the message match stays as a fallback for it.
        if (error.code === '23514' && (error.details === 'SUPPRESSED' || /suppressed/i.test(error.message))) {
            throw new SuppressedError(error.message);
        }
        log.error({ err: error, key: input.canonicalKey }, 'upsertCompany failed');
        throw error;
    }
    return data as CompanyRow;
}

/** The verdict ROW OF RECORD returned by the fenced persist RPC. Normally echoes the computed
 *  verdict; differs ONLY when the RPC preserved an existing BILLED match (immutable) — callers
 *  must tally + bill from THIS, not from what they computed. */
export interface PersistedVerdict {
    id: string;
    verdict: string;
    score: number | null;
    evidence: string | null;
    eliminationReason: string | null;
}

/**
 * Persist a per-ICP verdict through the fenced, atomic RPC (067). Structurally requires the
 * running attempt's (job, worker, lease) — a reaped/zombie attempt writes NOTHING (plain throw).
 * Under the per-tenant lock the RPC also refuses a suppressed company (SuppressedError here) and
 * NEVER overwrites a billed MATCH verdict (it returns the existing row untouched instead — the
 * evidence a charge was billed from is immutable).
 */
export async function persistVerdict(params: {
    tenantId: string;
    companyId: string;
    icpId: string;
    rulesetVersion: number;
    verdict: Verdict;
    model: string;
    jobId: string;
    worker: string;
    lease: string;
}): Promise<PersistedVerdict> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_persist_verdict', {
        p_tenant: params.tenantId,
        p_company_id: params.companyId,
        p_icp_id: params.icpId,
        p_ruleset_version: params.rulesetVersion,
        p_verdict: params.verdict.verdict,
        p_score: params.verdict.score,
        p_evidence: params.verdict.evidence,
        p_elimination_reason: params.verdict.elimination_reason || null,
        p_model: params.model,
        p_job_id: params.jobId,
        p_worker: params.worker,
        p_lease: params.lease,
        // WP4 personalization (096) — rides the same fenced write; a preserved BILLED row
        // ignores these entirely (the RPC returns the row of record before any write).
        p_hooks: params.verdict.hooks && params.verdict.hooks.length > 0 ? params.verdict.hooks : null,
        p_angle_suggestion: params.verdict.angle_suggestion ?? null,
    });
    if (error) {
        // Suppression is signalled by a STRUCTURED marker (069): check_violation + DETAIL of
        // 'SUPPRESSED' / 'SUPPRESSED_OR_MISSING'. Any other 23514 (e.g. the table's own score
        // CHECK) is a hard error — mapping bare SQLSTATE to "suppressed" would silently skip
        // malformed data as if it were a KVKK block. A lost lease (plain RAISE) also lands here.
        if (error.code === '23514' && (error.details === 'SUPPRESSED' || error.details === 'SUPPRESSED_OR_MISSING')) {
            throw new SuppressedError(error.message);
        }
        log.error({ err: error, companyId: params.companyId }, 'persistVerdict failed');
        throw error;
    }
    const row = data as {
        id: string; verdict: string; score: number | null;
        evidence: string | null; elimination_reason: string | null;
    };
    return {
        id: row.id, verdict: row.verdict, score: row.score,
        evidence: row.evidence, eliminationReason: row.elimination_reason,
    };
}

export interface BillOutcome {
    /** 'billed' = the RPC settled a (possibly already-existing) charge for this canonical key. */
    eventId: string;
    ledgerId: string | null;
}

/** Raised when research_bill_match refuses because the run's reservation (hold) is exhausted. */
export class ReservationExhaustedError extends Error {}

/**
 * Bill a MATCH verdict via the idempotent, hold-aware RPC. Returns the event on success (whether
 * this call created the charge or it already existed). Behaviour by outcome:
 *   • success (fresh charge OR dedup)         → BillOutcome (the run continues)
 *   • ineligible: not current/approved/       → null (an expected per-candidate skip; the run
 *     unsuppressed match, OR the credit floor    continues, and a floored match awaits a top-up
 *                                                via reconciliation)
 *   • reservation exhausted (hold consumed)   → throws ReservationExhaustedError (the caller STOPS
 *                                                spending COGS — the DB enforced the cap)
 *   • transport/DB failure OR a lost lease     → throws (do NOT swallow; a swallowed billing failure
 *     fence (zombie attempt)                     would leave a persisted match unbilled, losing
 *                                                revenue — codex P0; a fenced zombie must abort)
 * holdId/worker/lease tie the charge to this run's reservation and running lease: a fresh charge
 * consumes one unit of the hold atomically with the ledger decrement, and a reaped attempt is fenced.
 */
export async function billMatch(params: {
    verdictId: string;
    jobId?: string | null;
    holdId?: string | null;
    worker?: string | null;
    lease?: string | null;
    amountUsd?: number;
    pricingVersion?: string;
}): Promise<BillOutcome | null> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_bill_match', {
        p_verdict_id: params.verdictId,
        p_pricing_version: params.pricingVersion ?? 'v1',
        p_amount_usd: params.amountUsd ?? 0,
        p_job_id: params.jobId ?? null,
        p_hold_id: params.holdId ?? null,
        p_worker: params.worker ?? null,
        p_lease: params.lease ?? null,
    });
    if (error) {
        if (error.code === '23514') {
            // The reservation-exhausted refusal carries a structured marker (DETAIL), not free-form
            // message text: it means "stop the run" (the cap is enforced server-side), unlike the
            // floor/ineligible refusals (same SQLSTATE, no marker) which mean "skip this candidate".
            if (error.details === 'RESERVATION_EXHAUSTED') {
                log.info({ verdictId: params.verdictId, holdId: params.holdId }, 'billMatch: reservation exhausted (stop)');
                throw new ReservationExhaustedError(error.message);
            }
            // Deliberate ineligibility (not a current/approved/unsuppressed match, or the credit floor).
            log.info({ verdictId: params.verdictId, msg: error.message }, 'billMatch: verdict ineligible (not billed)');
            return null;
        }
        // Transport/DB failure OR a lost-lease fence — do NOT swallow.
        log.error({ err: error, verdictId: params.verdictId }, 'billMatch transport/DB error (or lease fenced)');
        throw error;
    }
    const row = data as { id: string; ledger_id: string | null };
    return { eventId: row.id, ledgerId: row.ledger_id };
}

/**
 * Reconciliation: current-ruleset MATCH verdicts for this ICP whose canonical_key has NO
 * billable_event yet — i.e. a match that was persisted but not billed (e.g. a crash or transport
 * error between verdict-write and bill). One SQL anti-join RPC (067) — the previous client-side
 * three-query join could silently HIDE rows past the PostgREST row cap (lost revenue). Bounded:
 * a remainder past `limit` is picked up by the next run (verdicts persist). Returns verdict ids.
 */
export async function unbilledMatchVerdicts(params: {
    tenantId: string;
    icpId: string;
    rulesetVersion: number;
    limit?: number;
}): Promise<string[]> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_unbilled_match_verdicts', {
        p_tenant: params.tenantId,
        p_icp_id: params.icpId,
        p_ruleset: params.rulesetVersion,
        p_limit: params.limit ?? 500,
    });
    if (error) {
        log.error({ err: error }, 'unbilledMatchVerdicts failed');
        throw error;
    }
    return (data ?? []) as string[];
}

/** Per-tenant search COGS (append-only). */
export async function logSearch(params: {
    tenantId: string;
    projectId?: string | null;
    jobId?: string | null;
    engine?: string;
    query: string;
    resultCount: number;
    cacheHit: boolean;
    costUsd: number;
}): Promise<void> {
    const { createHash } = await import('crypto');
    const { error } = await researchSupabaseAdmin.from('research_search_log').insert({
        tenant_id: params.tenantId,
        project_id: params.projectId ?? null,
        job_id: params.jobId ?? null,
        engine: params.engine ?? 'gemini',
        query: params.query,
        query_hash: createHash('sha256').update(params.query).digest('hex'),
        result_count: params.resultCount,
        cache_hit: params.cacheHit,
        cost_usd: params.costUsd,
    });
    if (error) log.warn({ err: error }, 'logSearch failed (non-fatal)');
}

/** An existing registry company, with the fields needed to dedup OR re-score it from cache. */
export interface ExistingCompany {
    id: string;
    canonicalKey: string;
    domain: string | null;
    name: string;
    country: string | null;
    city: string | null;
}

/**
 * Existing registry companies for this tenant + the given canonical keys, keyed by canonical_key.
 * Replaces the keys-only dedup lookup: the handler needs the identity to (a) skip a firm that already
 * has a current verdict and (b) re-score one that does NOT, from its CACHED FULL page text
 * (no re-fetch; the summary is intentionally NOT used — it is prior LLM output, not source text).
 */
export async function existingCompanies(tenantId: string, keys: string[]): Promise<Map<string, ExistingCompany>> {
    const out = new Map<string, ExistingCompany>();
    if (keys.length === 0) return out;
    const { data, error } = await researchSupabaseAdmin
        .from('research_companies')
        .select('id, canonical_key, domain, name, country, city')
        .eq('tenant_id', tenantId)
        .in('canonical_key', keys);
    if (error) {
        log.error({ err: error }, 'existingCompanies failed');
        throw error;
    }
    for (const r of data ?? []) {
        const row = r as {
            id: string; canonical_key: string; domain: string | null;
            name: string; country: string | null; city: string | null;
        };
        out.set(row.canonical_key, {
            id: row.id, canonicalKey: row.canonical_key, domain: row.domain,
            name: row.name, country: row.country, city: row.city,
        });
    }
    return out;
}

/**
 * Of the given company ids, those that ALREADY have a verdict for (icp, ruleset_version) — the true
 * dedup set for a harvest run. An existing firm NOT in this set has no current verdict for the ICP
 * being harvested, so it is re-scored (not skipped): the dedup gate is now "(company, icp, ruleset)
 * has a verdict?", not "company exists?". Re-scoring under a bumped ruleset_version naturally re-runs
 * (old-version verdicts don't satisfy the predicate). Tenant-scoped.
 */
export async function companiesWithCurrentVerdict(params: {
    tenantId: string;
    icpId: string;
    rulesetVersion: number;
    companyIds: string[];
}): Promise<Set<string>> {
    if (params.companyIds.length === 0) return new Set();
    const { data, error } = await researchSupabaseAdmin
        .from('research_company_verdicts')
        .select('company_id')
        .eq('tenant_id', params.tenantId)
        .eq('icp_id', params.icpId)
        .eq('ruleset_version', params.rulesetVersion)
        .in('company_id', params.companyIds);
    if (error) {
        log.error({ err: error }, 'companiesWithCurrentVerdict failed');
        throw error;
    }
    return new Set((data ?? []).map((r) => (r as { company_id: string }).company_id));
}

/** Suppressed canonical keys for this tenant (pre-filter so one suppressed row can't abort work). */
export async function suppressedCanonicalKeys(tenantId: string, keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const { data, error } = await researchSupabaseAdmin
        .from('research_suppression')
        .select('identity_key')
        .eq('tenant_id', tenantId)
        .eq('entity_type', 'company')
        .in('identity_key', keys);
    if (error) {
        log.error({ err: error }, 'suppressedCanonicalKeys failed');
        throw error;
    }
    return new Set((data ?? []).map((r) => (r as { identity_key: string }).identity_key));
}

/** Per-tenant research tier/quota config (073 — operator-managed, no Stripe). */
export interface TenantResearchSettings {
    researchTier: string;
    monthlyLeadQuota: number;
    reserveEstimate: number | null;
    autoGrant: boolean;
}

/** Read a tenant's research settings row; null when unset (defaults apply). */
export async function tenantResearchSettings(tenantId: string): Promise<TenantResearchSettings | null> {
    const { data, error } = await researchSupabaseAdmin
        .from('research_tenant_settings')
        .select('research_tier, monthly_lead_quota, reserve_estimate, auto_grant')
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (error) {
        log.error({ err: error, tenantId }, 'tenantResearchSettings failed');
        throw error;
    }
    if (!data) return null;
    const row = data as {
        research_tier: string; monthly_lead_quota: number;
        reserve_estimate: number | null; auto_grant: boolean;
    };
    return {
        researchTier: row.research_tier,
        monthlyLeadQuota: row.monthly_lead_quota,
        reserveEstimate: row.reserve_estimate,
        autoGrant: row.auto_grant,
    };
}

export async function creditBalance(tenantId: string): Promise<number> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_credit_balance', { p_tenant: tenantId });
    if (error) {
        log.error({ err: error }, 'creditBalance failed');
        throw error;
    }
    return (data as number) ?? 0;
}

// ── Pre-run quota holds (reserve / settle / release) — migration 064 ─────────────

/** Raised when there is not enough available credit to reserve a run (RPC check_violation). */
export class InsufficientCreditsError extends Error {}

export interface HoldRow {
    id: string;
    tenant_id: string;
    job_id: string | null;
    reserved: number;
    settled: number;
    released: number;
    status: 'open' | 'settled' | 'released';
}

/**
 * Available credits = balance − Σ(open holds' outstanding). The pre-enqueue gate (route) and UI
 * read this; it is an advisory snapshot (the authoritative admission decision is made under the
 * lock by reserveHold).
 */
export async function availableCredits(tenantId: string): Promise<number> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_available_credits', { p_tenant: tenantId });
    if (error) {
        log.error({ err: error }, 'availableCredits failed');
        throw error;
    }
    return (data as number) ?? 0;
}

/**
 * Reserve up to `estimate` credits for a run as an OPEN hold (admission control). Throws
 * InsufficientCreditsError when available < minRequired (the run must not start and burn COGS).
 * Idempotent per job: a re-reserve for the same job returns the existing hold. The returned
 * `reserved` is the engine's hard billing cap for the run (capped to what was actually available).
 */
export async function reserveHold(params: {
    tenantId: string;
    jobId?: string | null;
    estimate: number;
    minRequired?: number;
}): Promise<HoldRow> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_reserve_hold', {
        p_tenant: params.tenantId,
        p_job_id: params.jobId ?? null,
        p_estimate: params.estimate,
        p_min_required: params.minRequired ?? 1,
    });
    if (error) {
        // 23514 = check_violation → the availability guard fired (not enough credit to start).
        if (error.code === '23514' || /insufficient credits/i.test(error.message)) {
            throw new InsufficientCreditsError(error.message);
        }
        log.error({ err: error, tenantId: params.tenantId }, 'reserveHold failed');
        throw error;
    }
    return data as HoldRow;
}

/** Fence proof for closing a job-attributed hold: the closing attempt's (job, worker, lease). */
export interface HoldFence {
    jobId?: string | null;
    worker?: string | null;
    lease?: string | null;
}

/**
 * Close a hold normally (success path). The realized count is `settled`, maintained transactionally
 * by research_bill_match as each fresh charge consumed the reservation; this just frees the unused
 * remainder (released = reserved − settled) and marks the hold settled. Idempotent. A job-attributed
 * hold REQUIRES the fence (067): only the attempt still holding that job's running lease may close
 * it — a zombie can no longer settle a reservation out from under a live successor.
 */
export async function settleHold(holdId: string, fence?: HoldFence): Promise<HoldRow> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_settle_hold', {
        p_hold_id: holdId,
        p_job_id: fence?.jobId ?? null,
        p_worker: fence?.worker ?? null,
        p_lease: fence?.lease ?? null,
    });
    if (error) {
        log.error({ err: error, holdId }, 'settleHold failed');
        throw error;
    }
    return data as HoldRow;
}

/** Release the whole outstanding reservation (failure/abort path). Idempotent. Same fence rule as
 *  settleHold: closing a job-attributed hold requires proving the running lease (067). */
export async function releaseHold(holdId: string, fence?: HoldFence): Promise<HoldRow> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_release_hold', {
        p_hold_id: holdId,
        p_job_id: fence?.jobId ?? null,
        p_worker: fence?.worker ?? null,
        p_lease: fence?.lease ?? null,
    });
    if (error) {
        log.error({ err: error, holdId }, 'releaseHold failed');
        throw error;
    }
    return data as HoldRow;
}

/**
 * Grant credits. Pass idempotencyKey (a stable UUID for this logical grant) to make a retry a
 * no-op — without it the grant is non-idempotent and a timeout-retry would double-credit (063).
 */
export async function grantCredits(
    tenantId: string,
    amount: number,
    reason = 'grant',
    idempotencyKey?: string
): Promise<number> {
    const { data, error } = await researchSupabaseAdmin.rpc('research_grant_credits', {
        p_tenant: tenantId,
        p_amount: amount,
        p_reason: reason,
        p_ref_type: idempotencyKey ? 'grant' : null,
        p_ref_id: idempotencyKey ?? null,
    });
    if (error) {
        log.error({ err: error }, 'grantCredits failed');
        throw error;
    }
    return (data as number) ?? 0;
}
