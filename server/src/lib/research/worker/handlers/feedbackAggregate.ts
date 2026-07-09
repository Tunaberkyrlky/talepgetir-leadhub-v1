/**
 * feedback:aggregate (WP5) — pull campaign OUTCOMES back onto the research side.
 *
 * For every research company this tenant EXPORTED (crm_company_id set), read the TG-Core
 * campaign signals — email_replies (direction/label/category) and campaign_enrollments
 * (status) — and aggregate them into research_outcome_stats per (ICP × geo × angle) cell
 * plus an all-angles rollup. K8 one-way boundary: the CRM is READ ONLY and DEFENSIVELY
 * (a missing table/column on an older CRM deploy degrades that signal to zeros — the job
 * never fails on CRM shape); writes land exclusively in research-owned tables.
 *
 * Opt-out sync: a CRM opt-out signal (enrollment 'unsubscribed' or reply 'not_interested')
 * on an exported company suppresses the research company via the existing fenced
 * research_suppress_company RPC (source 'opt_out') — suppression > dedup, so the firm
 * drops out of every future harvest/export path.
 *
 * Deterministic + idempotent (full per-tenant recompute, upsert on the unique cell; the
 * suppress RPC is conflict-safe) — the daily tick re-runs it freely. No LLM, no billing.
 */
import type { HandlerContext, JobHandler } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:feedback-aggregate');

type CrmClient = typeof import('../../../supabase.js').supabaseAdmin;

// lib/supabase throws at import when SUPABASE_* is unset — and the Railway worker
// intentionally carries no prod creds (prod isolation). Resolved lazily so a keyless
// worker still boots; a missing client degrades every CRM signal to zero (counted in
// crm_read_errors), the same contract as a missing table/column.
let crmClient: CrmClient | null | undefined;
async function getCrmClient(jobId: string): Promise<CrmClient | null> {
    if (crmClient !== undefined) return crmClient;
    try {
        crmClient = (await import('../../../supabase.js')).supabaseAdmin;
    } catch (err) {
        crmClient = null;
        log.warn(
            { err: err instanceof Error ? err.message : err, jobId },
            'CRM client unavailable (SUPABASE_* unset on this process) — CRM signals degrade to zero'
        );
    }
    return crmClient;
}

const CHUNK = 200;

interface ExportedCompany {
    id: string;
    crm_company_id: string;
    canonical_key: string;
    icp_id: string | null;
    geo_id: string | null;
    suppressed: boolean;
}

interface OutcomeCounts { sent: number; replies: number; positive: number; optout: boolean }

function emptyCounts(): OutcomeCounts {
    return { sent: 0, replies: 0, positive: 0, optout: false };
}

/** Defensive CRM read: any error (missing table/column on an older CRM) → empty + warn. */
async function readCrmSignals(
    tenantId: string,
    crmIds: string[],
    jobId: string
): Promise<{ byCompany: Map<string, OutcomeCounts>; readErrors: number }> {
    const byCompany = new Map<string, OutcomeCounts>();
    let readErrors = 0;
    const crm = await getCrmClient(jobId);
    if (!crm) return { byCompany, readErrors: 1 };
    const get = (id: string): OutcomeCounts => {
        let c = byCompany.get(id);
        if (!c) { c = emptyCounts(); byCompany.set(id, c); }
        return c;
    };

    // A shared crm_company_id must be read ONCE (codex P1: the same id landing in two chunks
    // would double the same reply rows into one counter).
    const uniqueIds = [...new Set(crmIds)];

    // Row-paginate every chunk read to exhaustion (codex P1: PostgREST caps response rows —
    // a 200-company chunk with multi-step sends/replies can exceed it, silently undercounting
    // and possibly missing unsubscribed opt-outs).
    const PAGE = 1000;
    const pagedRead = async (table: string, columns: string, chunk: string[]): Promise<Record<string, unknown>[] | null> => {
        const rows: Record<string, unknown>[] = [];
        for (let start = 0; ; start += PAGE) {
            const { data, error } = await crm
                .from(table)
                .select(columns)
                .eq('tenant_id', tenantId)
                .in('company_id', chunk)
                .order('id', { ascending: true })
                .range(start, start + PAGE - 1);
            if (error) {
                readErrors++;
                log.warn({ err: error, jobId, table }, `${table} read failed — counting that signal as zero (defensive)`);
                return null;
            }
            const page = (data ?? []) as unknown as Record<string, unknown>[];
            rows.push(...page);
            if (page.length < PAGE) return rows;
        }
    };

    for (let i = 0; i < uniqueIds.length; i += CHUNK) {
        const chunk = uniqueIds.slice(i, i + CHUNK);

        const replies = await pagedRead('email_replies', 'id, company_id, direction, label, category', chunk);
        if (replies) {
            for (const r of replies as Array<{ company_id: string | null; direction: string | null; label: string | null; category: string | null }>) {
                if (!r.company_id) continue;
                const c = get(r.company_id);
                if (r.direction === 'OUT') { c.sent++; continue; }
                // Only INBOUND rows carry outcome semantics (an OUT row inheriting a label
                // must never self-flag). Both the label channel and the categorizer count —
                // symmetric trust for positives AND opt-outs (review P3).
                c.replies++;
                if (r.label === 'INTERESTED' || r.category === 'positive' || r.category === 'meeting_request') c.positive++;
                if (r.category === 'not_interested' || r.label === 'NOT_INTERESTED') c.optout = true;
            }
        }

        const enrollments = await pagedRead('campaign_enrollments', 'id, company_id, status', chunk);
        if (enrollments) {
            for (const e of enrollments as Array<{ company_id: string | null; status: string | null }>) {
                if (!e.company_id) continue;
                if (e.status === 'unsubscribed') get(e.company_id).optout = true;
            }
        }
    }
    return { byCompany, readErrors };
}

export const feedbackAggregateHandler: JobHandler = async ({ job, heartbeat }: HandlerContext) => {
    const tenantId = job.tenant_id;
    await heartbeat({ stage: 'loading' });

    // Exported research companies = the only firms whose CRM outcomes belong to research.
    // KEYSET pagination to exhaustion (review P3): a single capped read would silently
    // undercount and skip opt-out suppression past the cap, with a run-to-run-unstable subset.
    const companies: ExportedCompany[] = [];
    {
        const PAGE = 1000;
        let lastId: string | null = null;
        for (;;) {
            let q = researchSupabaseAdmin
                .from('research_companies')
                .select('id, crm_company_id, canonical_key, icp_id, geo_id, suppressed')
                .eq('tenant_id', tenantId)
                .not('crm_company_id', 'is', null)
                .order('id', { ascending: true })
                .limit(PAGE);
            if (lastId) q = q.gt('id', lastId);
            const { data: page, error: pageErr } = await q;
            if (pageErr) throw pageErr;
            const rows = (page ?? []) as ExportedCompany[];
            companies.push(...rows);
            if (rows.length < PAGE) break;
            lastId = rows[rows.length - 1].id;
        }
    }
    if (companies.length === 0) {
        // Prune before returning (codex P2): if every exported row disappeared (hard erase /
        // unlink), the tenant drops out of the daily discovery RPC — stale stats would
        // otherwise stay visible forever.
        const { error: delErr } = await researchSupabaseAdmin
            .from('research_outcome_stats')
            .delete()
            .eq('tenant_id', tenantId)
            .eq('period', 'all');
        if (delErr) log.warn({ err: delErr, jobId: job.id }, 'zero-export prune failed');
        return { companies_checked: 0, stats_upserted: 0, stats_pruned: delErr ? 0 : -1, optouts_suppressed: 0, crm_read_errors: 0 };
    }

    await heartbeat({ stage: 'reading_crm', companies: companies.length });
    const { byCompany, readErrors } = await readCrmSignals(
        tenantId,
        companies.map((c) => c.crm_company_id),
        job.id
    );

    // Angle attribution: the company's MATCH verdict for ITS icp carries angle_suggestion.
    // CHUNKED like the CRM reads (review P1): a full-set .in() rides the URL and hits the
    // gateway limit around a few hundred UUIDs — which would fail the whole job (and with it
    // the opt-out sync) for exactly the biggest tenants.
    // NOTE (documented limitation, review P3): attribution uses the company's CURRENT rollup
    // icp_id — a firm re-discovered under another ICP after export reports there; export-time
    // ICP pinning is a follow-up (needs a column on research_mark_exported).
    // Only the ICP's CURRENT ruleset counts (codex P2): historical verdict rows from older
    // rulesets survive on purpose — letting them overwrite the map would make the angle
    // nondeterministic after an ICP revision.
    const currentRuleset = new Map<string, number>();
    {
        const icpIds = [...new Set(companies.map((c) => c.icp_id).filter((v): v is string => !!v))];
        if (icpIds.length > 0) {
            const { data: icpRows, error: icpErr } = await researchSupabaseAdmin
                .from('research_icps')
                .select('id, ruleset_version')
                .eq('tenant_id', tenantId)
                .in('id', icpIds);
            if (icpErr) throw icpErr;
            for (const r of (icpRows ?? []) as Array<{ id: string; ruleset_version: number }>) {
                currentRuleset.set(r.id, r.ruleset_version);
            }
        }
    }
    const angleByCompanyIcp = new Map<string, string | null>();
    {
        const ids = companies.map((c) => c.id);
        for (let i = 0; i < ids.length; i += CHUNK) {
            const { data: verdictRows, error: vErr } = await researchSupabaseAdmin
                .from('research_company_verdicts')
                .select('company_id, icp_id, ruleset_version, angle_suggestion')
                .eq('tenant_id', tenantId)
                .eq('verdict', 'match')
                .in('company_id', ids.slice(i, i + CHUNK));
            if (vErr) throw vErr;
            for (const v of (verdictRows ?? []) as Array<{ company_id: string; icp_id: string; ruleset_version: number; angle_suggestion: string | null }>) {
                if (currentRuleset.get(v.icp_id) !== v.ruleset_version) continue;
                angleByCompanyIcp.set(`${v.company_id}:${v.icp_id}`, v.angle_suggestion);
            }
        }
    }

    // ── Aggregate per (icp, geo, angle) + the all-angles rollup (angle NULL) ──
    interface CellAgg { exported: number; sent: number; replies: number; positive: number; optouts: number }
    const cells = new Map<string, { icp: string | null; geo: string | null; angle: string | null; agg: CellAgg }>();
    const bump = (icp: string | null, geo: string | null, angle: string | null, c: OutcomeCounts) => {
        const key = `${icp ?? ''}|${geo ?? ''}|${angle ?? ''}`;
        let cell = cells.get(key);
        if (!cell) {
            cell = { icp, geo, angle, agg: { exported: 0, sent: 0, replies: 0, positive: 0, optouts: 0 } };
            cells.set(key, cell);
        }
        cell.agg.exported++;
        cell.agg.sent += c.sent;
        cell.agg.replies += c.replies;
        cell.agg.positive += c.positive;
        if (c.optout) cell.agg.optouts++;
    };

    // One CRM company can back-link to MULTIPLE research rows (export dedup layers 2/3) —
    // its counts must be attributed exactly ONCE (review P2). Representative selection per
    // crm_company_id PREFERS a row that has an angle verdict for its ICP (that is the row
    // whose export actually drove the campaign copy); ties fall to scan order (id-ordered
    // keyset → deterministic). Non-representative rows only add to `exported` — and still
    // sync opt-outs (each has its own canonical_key; the suppress RPC is conflict-safe).
    const optoutCompanies: ExportedCompany[] = [];
    const angleOf = (comp: ExportedCompany): string | null =>
        comp.icp_id ? angleByCompanyIcp.get(`${comp.id}:${comp.icp_id}`) ?? null : null;
    const byCrm = new Map<string, ExportedCompany[]>();
    for (const comp of companies) {
        const group = byCrm.get(comp.crm_company_id) ?? [];
        group.push(comp);
        byCrm.set(comp.crm_company_id, group);
    }
    for (const [crmId, group] of byCrm) {
        const crmCounts = byCompany.get(crmId) ?? emptyCounts();
        const representative = group.find((c) => angleOf(c) != null) ?? group[0];
        for (const comp of group) {
            const counts = comp === representative ? crmCounts : emptyCounts();
            const angle = angleOf(comp);
            bump(comp.icp_id, comp.geo_id, null, counts);            // all-angles rollup
            if (angle) bump(comp.icp_id, comp.geo_id, angle, counts); // per-angle cell
            if (crmCounts.optout && !comp.suppressed) optoutCompanies.push(comp);
        }
    }

    await heartbeat({ stage: 'writing', cells: cells.size });
    let statsUpserted = 0;
    for (const { icp, geo, angle, agg } of cells.values()) {
        const { error: upErr } = await researchSupabaseAdmin
            .from('research_outcome_stats')
            .upsert(
                {
                    tenant_id: tenantId, icp_id: icp, geo_id: geo, angle_code: angle, period: 'all',
                    exported: agg.exported, sent: agg.sent, replies: agg.replies,
                    positive: agg.positive, optouts: agg.optouts,
                },
                { onConflict: 'tenant_id,icp_id,geo_id,angle_code,period' }
            );
        if (upErr) throw upErr;
        statsUpserted++;
    }

    // Prune cells that disappeared (review P2): a company's icp/geo can migrate (COALESCE
    // rollup) and angles change on re-verdict — an upsert-only recompute would freeze the
    // old cell forever and DOUBLE-count the firm in the endpoint's cross-cell sums (and in
    // the revise-prompt evidence). The recompute is authoritative: stale keys are deleted.
    let statsPruned = 0;
    {
        const { data: existing, error: exErr } = await researchSupabaseAdmin
            .from('research_outcome_stats')
            .select('id, icp_id, geo_id, angle_code')
            .eq('tenant_id', tenantId)
            .eq('period', 'all');
        if (exErr) {
            log.warn({ err: exErr, jobId: job.id }, 'stale-cell scan failed — pruning skipped this run');
        } else {
            const staleIds = ((existing ?? []) as Array<{ id: string; icp_id: string | null; geo_id: string | null; angle_code: string | null }>)
                .filter((r) => !cells.has(`${r.icp_id ?? ''}|${r.geo_id ?? ''}|${r.angle_code ?? ''}`))
                .map((r) => r.id);
            for (let i = 0; i < staleIds.length; i += CHUNK) {
                const { error: delErr } = await researchSupabaseAdmin
                    .from('research_outcome_stats')
                    .delete()
                    .eq('tenant_id', tenantId)
                    .in('id', staleIds.slice(i, i + CHUNK));
                if (delErr) throw delErr;
            }
            statsPruned = staleIds.length;
        }
    }

    // ── Opt-out sync → suppression (fenced RPC; suppression > dedup) ─────────
    let optoutsSuppressed = 0;
    for (const comp of optoutCompanies) {
        const { error: supErr } = await researchSupabaseAdmin.rpc('research_suppress_company', {
            p_tenant: tenantId,
            p_canonical_key: comp.canonical_key,
            p_source: 'opt_out',
            p_hard_erase: false,
        });
        if (supErr) {
            // Best-effort per company (the next daily run retries); never fail the aggregate
            // over one suppression write.
            log.warn({ err: supErr, companyId: comp.id, jobId: job.id }, 'opt-out suppression failed — will retry next run');
            continue;
        }
        optoutsSuppressed++;
    }

    const summary = {
        companies_checked: companies.length,
        stats_upserted: statsUpserted,
        stats_pruned: statsPruned,
        optouts_suppressed: optoutsSuppressed,
        crm_read_errors: readErrors,
    };
    log.info({ jobId: job.id, ...summary }, 'feedback:aggregate complete');
    return summary;
};
