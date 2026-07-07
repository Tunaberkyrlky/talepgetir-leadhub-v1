/**
 * Research harvest (Y1 list-harvest — capped pilot).
 * Enqueue a harvest run for ONE approved ICP × ONE geography, and read back the resulting
 * companies/verdicts. The run itself is async (worker, job type harvest:run); the client polls
 * /api/research/jobs/:id and then lists companies here.
 * Pattern mirrors routes/research/icps.ts (service-role client + manual tenant scope).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { enqueueJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPES } from '../../lib/research/jobTypes.js';
import { availableCredits, creditBalance } from '../../lib/research/engine/ledger.js';
import { isInternalRole } from '../../lib/roles.js';
import { sanitizeJobForRole } from '../../lib/research/sanitize.js';
import { effectiveCostRole } from '../../lib/research/freshRole.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { getDomain } from 'tldts';

const log = createLogger('route:research:harvest');
const router = Router();

const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');
const COMPANY_STATUSES = ['match', 'partial', 'eliminated', 'review'] as const;

// Caps (incl. the USD spend budget) are an OPERATOR knob — dollar-shaped controls never surface
// to customer roles, not even through validation error text (codex P1). The public schema carries
// caps as an opaque unknown (no bounds to echo); the handler parses it with the internal schema
// ONLY for internal roles and silently ignores it otherwise.
const runSchema = z.object({
    icp_id: uuidField('Invalid ICP ID'),
    geography: z.string().min(1).max(120),
    // Discovery source: 'web' (SearXNG/Gemini, default) or 'maps' (Gosom/Google Maps; 2GIS/CIS in M2).
    // Both run the identical capped, hold-fenced, once-ever-billed pipeline — only discovery differs.
    source: z.enum(['web', 'maps']).optional(),
    caps: z.unknown().optional(),
});
const internalCapsSchema = z
    .object({
        maxQueries: z.number().int().min(1).max(33).optional(),
        maxFetches: z.number().int().min(1).max(200).optional(),
        maxCandidates: z.number().int().min(1).max(300).optional(),
        maxSpendUsd: z.number().min(0.01).max(25).optional(),
    })
    .optional();

// ── POST /api/research/harvest/run — enqueue a capped harvest ────────────────
router.post('/run', requireWriter, validateBody(runSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { icp_id, geography, source, caps: rawCaps } = req.body as z.infer<typeof runSchema>;
        const jobType = source === 'maps' ? RESEARCH_JOB_TYPES.MAPS_HARVEST : RESEARCH_JOB_TYPES.HARVEST_RUN;
        // Internal roles may size a sanctioned larger run (resolveCaps clamps to the ceilings);
        // a client-role request silently runs with the defaults.
        let caps: z.infer<typeof internalCapsSchema>;
        if (rawCaps !== undefined && isInternalRole(req.user!.role)) {
            const parsedCaps = internalCapsSchema.safeParse(rawCaps);
            if (!parsedCaps.success) {
                res.status(400).json({ error: 'Invalid caps' });
                return;
            }
            caps = parsedCaps.data;
        }

        // The ICP must exist in this tenant AND be approved — only an approved ICP at its current
        // ruleset can produce billable MATCHes (the bill RPC refuses anything else), so harvesting
        // a draft ICP would burn COGS for nothing.
        const { data: icp, error: icpErr } = await researchSupabaseAdmin
            .from('research_icps')
            .select('id, project_id, status')
            .eq('id', icp_id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (icpErr) {
            log.error({ err: icpErr }, 'harvest icp lookup failed');
            throw new AppError('Failed to start harvest', 500);
        }
        if (!icp) {
            res.status(404).json({ error: 'ICP not found' });
            return;
        }
        if ((icp as { status: string }).status !== 'approved') {
            res.status(409).json({ error: 'ICP must be approved before harvesting' });
            return;
        }

        // Pre-enqueue quota gate (fast-fail UX): refuse to queue a run for a tenant with no spendable
        // credit. This is an advisory snapshot — the worker's research_reserve_hold is the
        // authoritative, race-safe admission decision (it re-checks under the per-tenant lock and
        // ties the reservation to this job). Available = balance − outstanding open reservations.
        const available = await availableCredits(tenantId);
        if (available < 1) {
            res.status(402).json({ error: 'Insufficient research credits', available });
            return;
        }

        // ONE in-flight harvest per ICP across ANY harvest type (advisory guard, Workflow review):
        // two concurrent runs of the SAME ICP — even a web run and a maps run — make the (company,
        // icp, ruleset) verdict a last-writer-wins race between two LIVE attempts (both hold valid
        // leases, so the zombie fences don't apply) — an unbilled match persisted by run A can be
        // overwritten by run B between A's persist and A's bill. The DB invariants stay safe either
        // way (billing follows the final row of record); this guard removes the practical class +
        // double-click enqueues. Different ICPs still run concurrently.
        const { data: inflight, error: infErr } = await researchSupabaseAdmin
            .from('research_jobs')
            .select('id')
            .eq('tenant_id', tenantId)
            .in('type', [
                RESEARCH_JOB_TYPES.HARVEST_RUN,
                RESEARCH_JOB_TYPES.MAPS_HARVEST,
                RESEARCH_JOB_TYPES.TRADE_HARVEST,
            ])
            .in('status', ['queued', 'running'])
            .contains('payload', { icp_id })
            .limit(1)
            .maybeSingle();
        if (infErr) {
            log.error({ err: infErr }, 'harvest in-flight check failed');
            throw new AppError('Failed to start harvest', 500);
        }
        if (inflight) {
            res.status(409).json({
                error: 'A harvest for this ICP is already queued or running',
                job_id: (inflight as { id: string }).id,
            });
            return;
        }

        const job = await enqueueJob({
            tenantId,
            type: jobType,
            payload: { icp_id, geography, source: source ?? 'web', ...(caps ? { caps } : {}) },
            projectId: (icp as { project_id: string }).project_id,
            // A harvest spends real money (search + LLM + fetch) and is not cost-idempotent: an
            // auto-retry would re-discover + re-spend. Run once; on failure an operator re-runs
            // manually (the billing reconciliation pass + idempotent bill RPC make a re-run safe).
            maxAttempts: 1,
            createdBy: req.user?.id ?? null,
        });
        // Role-sanitized echo (068 rule): the raw job would echo payload.caps back.
        res.status(202).json(sanitizeJobForRole(job as unknown as Record<string, unknown>, await effectiveCostRole(req.user, req.tenantId)));
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'harvest run error');
        next(new AppError('Failed to start harvest', 500));
    }
});

// ── GET /api/research/harvest/credits — lead-quota balance + spendable headroom ───
router.get('/credits', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const [balance, available] = await Promise.all([creditBalance(tenantId), availableCredits(tenantId)]);
        // reserved = credits currently held by in-flight runs (balance − available).
        res.json({ balance, available, reserved: Math.max(0, balance - available) });
    } catch (err) {
        log.error({ err }, 'credits read error');
        next(new AppError('Failed to fetch credits', 500));
    }
});

// ── GET /api/research/harvest/companies?project_id=&status=&icp_id= ──────────
// Two read modes:
//   • icp_id present  → PER-ICP verdict view: read research_company_verdicts at the ICP's CURRENT
//     ruleset_version, joined to the company for display. The verdict — not the flat rollup — is the
//     per-ICP source of truth, so a firm re-scored (and billed) under a NEW ICP is visible here even
//     though its research_companies rollup row still points at whichever ICP last upserted it.
//   • no icp_id       → flat rollup list (research_companies), any-ICP.
router.get('/companies', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { project_id, status, icp_id } = req.query;
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
        const offset = (page - 1) * limit;

        if (status && typeof status === 'string' && !COMPANY_STATUSES.includes(status as (typeof COMPANY_STATUSES)[number])) {
            res.status(400).json({ error: 'Invalid status' });
            return;
        }
        if (project_id && typeof project_id === 'string' && !uuidField().safeParse(project_id).success) {
            res.status(400).json({ error: 'Invalid project_id' });
            return;
        }
        if (icp_id && typeof icp_id === 'string' && !uuidField().safeParse(icp_id).success) {
            res.status(400).json({ error: 'Invalid icp_id' });
            return;
        }

        // ── PER-ICP verdict-aware view ───────────────────────────────────────────
        if (icp_id && typeof icp_id === 'string') {
            // Resolve the ICP's current ruleset_version — the verdict rows to show. An unknown/other-tenant
            // ICP yields an empty page (not an error): the caller passed a filter that matches nothing here.
            const { data: icp, error: icpErr } = await researchSupabaseAdmin
                .from('research_icps')
                .select('ruleset_version')
                .eq('id', icp_id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (icpErr) {
                log.error({ err: icpErr }, 'list companies: icp lookup failed');
                throw new AppError('Failed to fetch companies', 500);
            }
            if (!icp) {
                res.json({ data: [], pagination: { total: 0, page, limit, hasNext: false } });
                return;
            }
            const rulesetVersion = (icp as { ruleset_version: number }).ruleset_version;

            let vQuery = researchSupabaseAdmin
                .from('research_company_verdicts')
                .select('company_id, verdict, score, evidence, elimination_reason, model, created_at', { count: 'exact' })
                .eq('tenant_id', tenantId)
                .eq('icp_id', icp_id)
                .eq('ruleset_version', rulesetVersion)
                .order('score', { ascending: false, nullsFirst: false })
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1);
            if (status && typeof status === 'string') vQuery = vQuery.eq('verdict', status);

            const { data: vRows, error: vErr, count } = await vQuery;
            if (vErr) {
                log.error({ err: vErr }, 'list companies: verdict query failed');
                throw new AppError('Failed to fetch companies', 500);
            }
            const verdicts = (vRows ?? []) as Array<{
                company_id: string; verdict: string; score: number | null;
                evidence: string | null; elimination_reason: string | null; model: string | null; created_at: string;
            }>;
            const companyIds = [...new Set(verdicts.map((v) => v.company_id))];

            // Load the display fields for exactly this page's companies (tenant-scoped). NOTE: project_id
            // is intentionally NOT applied here — the ICP already scopes to its project, and filtering on
            // a company's ROLLUP project_id would re-hide a cross-project re-scored match (the very bug
            // this view fixes) and skew the verdict count. So project_id is ignored when icp_id is set.
            const companyById = new Map<string, Record<string, unknown>>();
            if (companyIds.length > 0) {
                const { data: companies, error: cErr } = await researchSupabaseAdmin
                    .from('research_companies')
                    .select('*')
                    .eq('tenant_id', tenantId)
                    .in('id', companyIds);
                if (cErr) {
                    log.error({ err: cErr }, 'list companies: company lookup failed');
                    throw new AppError('Failed to fetch companies', 500);
                }
                for (const c of companies ?? []) companyById.set((c as { id: string }).id, c as Record<string, unknown>);
            }

            // Merge in verdict order; the PER-ICP verdict overrides the rollup status/score/evidence and
            // pins icp_id/ruleset_version. A missing company (deleted mid-page) is dropped defensively.
            const data = verdicts
                .map((v) => {
                    const company = companyById.get(v.company_id);
                    if (!company) return null;
                    return {
                        ...company,
                        icp_id,
                        ruleset_version: rulesetVersion,
                        status: v.verdict,
                        score: v.score,
                        evidence: v.evidence,
                        elimination_reason: v.elimination_reason,
                        verdict_model: v.model,
                        verdict_created_at: v.created_at,
                    };
                })
                .filter((r): r is NonNullable<typeof r> => r !== null);

            res.json({
                data,
                pagination: { total: count || 0, page, limit, hasNext: offset + limit < (count || 0) },
            });
            return;
        }

        // ── Flat rollup view (no icp_id) ─────────────────────────────────────────
        let query = researchSupabaseAdmin
            .from('research_companies')
            .select('*', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .order('score', { ascending: false, nullsFirst: false })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (project_id && typeof project_id === 'string') query = query.eq('project_id', project_id);
        if (status && typeof status === 'string') query = query.eq('status', status);

        const { data, error, count } = await query;
        if (error) {
            log.error({ err: error }, 'list companies failed');
            throw new AppError('Failed to fetch companies', 500);
        }
        res.json({
            data: data || [],
            pagination: { total: count || 0, page, limit, hasNext: offset + limit < (count || 0) },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'list companies error');
        next(new AppError('Failed to fetch companies', 500));
    }
});

// ── POST /api/research/harvest/companies/export — MATCH'leri TG Core CRM'e aktar ──
// The product loop's closing handoff (00 design: research → CRM campaigns): copies this ICP's
// CURRENT-ruleset MATCH companies into the CRM `companies` table (same DB, stage defaults 'cold')
// and links them back (crm_company_id badge). Hardened per codex batch-3:
//   • the read is ONE suppression-safe RPC (rollup flag + registry, unexported-only BEFORE the
//     limit — repeated calls page through lower-scored matches instead of re-reading the top 200);
//   • FOUR dedup layers: already-exported (RPC) → prior half-failed export (CRM rows carrying our
//     'Research Ref' correlation key are LINKED, closing the retry-duplicate path even for
//     domainless rows) → existing CRM rows on the same registrable domain (PRIVATE-suffix aware:
//     a.github.io ≠ b.github.io — eTLD+1-only matching would link the WRONG company) → insert;
//   • research_mark_exported re-checks suppression UNDER the lock and returns what it actually
//     marked; the route DELETES the CRM rows it created for anything not marked (compensation);
//   • one export at a time per TENANT via an in-process mutex (the server is a single
//     long-lived process; a multi-instance deploy would move this to a DB claim).
const exportSchema = z.object({
    icp_id: uuidField('Invalid ICP ID'),
});

const EXPORT_BATCH = 200;

// Registrable domain WITH private suffixes (unlike the billing canonicalizer, which deliberately
// collapses them): for LINKING to an existing CRM row, a.github.io and b.github.io are different
// businesses — collapsing would attach research data to the wrong company.
function exportDomain(input: string | null | undefined): string | null {
    if (!input) return null;
    const v = input.trim().toLowerCase();
    if (!v) return null;
    try {
        const url = new URL(/^https?:\/\//.test(v) ? v : `https://${v}`);
        return getDomain(url.hostname, { allowPrivateDomains: true });
    } catch {
        return null;
    }
}

// One export per TENANT at a time (not per ICP — codex: crm_company_id is tenant-wide, so two
// concurrent exports for DIFFERENT ICPs of the same tenant could ref-link/mark each other's
// freshly inserted CRM rows and mis-trigger compensation). Concurrent runs would also both
// observe crm_company_id IS NULL and double-insert. In-process is sufficient for the single
// long-lived server process; a multi-instance deploy would move this to a DB claim.
const exportInFlight = new Set<string>();

router.post('/companies/export', requireWriter, validateBody(exportSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenantId = req.tenantId!;
    const { icp_id } = req.body as z.infer<typeof exportSchema>;
    const lockKey = tenantId;
    if (exportInFlight.has(lockKey)) {
        res.status(409).json({ error: 'An export for this workspace is already running' });
        return;
    }
    exportInFlight.add(lockKey);
    try {
        // Resolve the ICP → its CURRENT ruleset (the verdict rows that count).
        const { data: icp, error: icpErr } = await researchSupabaseAdmin
            .from('research_icps')
            .select('id, ruleset_version')
            .eq('id', icp_id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (icpErr) {
            log.error({ err: icpErr }, 'export icp lookup failed');
            throw new AppError('Failed to export companies', 500);
        }
        if (!icp) {
            res.status(404).json({ error: 'ICP not found' });
            return;
        }
        const rulesetVersion = (icp as { ruleset_version: number }).ruleset_version;

        // Suppression-safe, unexported-only, current-ruleset MATCH companies (074 RPC).
        const { data: exportable, error: exErr } = await researchSupabaseAdmin.rpc('research_exportable_companies', {
            p_tenant: tenantId,
            p_icp_id: icp_id,
            p_ruleset: rulesetVersion,
            p_limit: EXPORT_BATCH,
        });
        if (exErr) {
            log.error({ err: exErr }, 'exportable read failed');
            throw new AppError('Failed to export companies', 500);
        }
        type ExportRow = {
            company_id: string; name: string; domain: string | null; website: string | null;
            country: string | null; city: string | null; site_summary: string | null;
            score: number | null; evidence: string | null;
        };
        const pending = (exportable ?? []) as ExportRow[];

        // Context counts (informational): total current-ruleset matches + how many already exported.
        const { count: totalMatches } = await researchSupabaseAdmin
            .from('research_company_verdicts')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .eq('icp_id', icp_id)
            .eq('ruleset_version', rulesetVersion)
            .eq('verdict', 'match');

        if (pending.length === 0) {
            res.json({ total_matches: totalMatches ?? 0, exported: 0, linked_existing: 0, has_more: false });
            return;
        }

        const links: Array<{ company_id: string; crm_company_id: string }> = [];
        let linkedExisting = 0;

        // Dedup layer 2 — a prior half-failed export (CRM insert succeeded, back-link failed):
        // CRM rows already carrying our correlation key for these research ids are LINKED, never
        // re-inserted. Closes the retry-duplicate path for domainless rows too.
        const pendingIds = pending.map((r) => r.company_id);
        const refLinked = new Set<string>();
        for (let i = 0; i < pendingIds.length; i += 50) {
            const chunk = pendingIds.slice(i, i + 50);
            const { data: refRows, error: refErr } = await supabaseAdmin
                .from('companies')
                .select('id, custom_fields')
                .eq('tenant_id', tenantId)
                .in('custom_fields->>research_ref', chunk);
            if (refErr) {
                log.error({ err: refErr }, 'export ref-dedup query failed');
                throw new AppError('Failed to export companies', 500);
            }
            for (const c of refRows ?? []) {
                const ref = (c as { custom_fields: Record<string, unknown> | null }).custom_fields?.['research_ref'];
                if (typeof ref === 'string' && !refLinked.has(ref)) {
                    refLinked.add(ref);
                    links.push({ company_id: ref, crm_company_id: (c as { id: string }).id });
                    linkedExisting++;
                }
            }
        }

        // Dedup layer 3 — existing CRM rows on the same registrable domain (private-suffix aware).
        // website first (keeps subdomain specificity), then the stored registrable domain as a
        // FALLBACK when the website is unparsable by this helper (codex: e.g. ftp:// URLs the
        // canonicalizer accepted) — otherwise those rows would silently skip CRM dedup.
        const stillPending = pending.filter((r) => !refLinked.has(r.company_id));
        const domainOf = (r: ExportRow): string | null => exportDomain(r.website) ?? exportDomain(r.domain);
        const pendingDomains = [...new Set(stillPending.map(domainOf).filter((d): d is string => !!d))];
        const crmByDomain = new Map<string, string>();
        for (let i = 0; i < pendingDomains.length; i += 20) {
            const chunk = pendingDomains.slice(i, i + 20);
            const { data: crmRows, error: crmErr } = await supabaseAdmin
                .from('companies')
                .select('id, website')
                .eq('tenant_id', tenantId)
                .or(chunk.map((d) => `website.ilike.%${d}%`).join(','));
            if (crmErr) {
                log.error({ err: crmErr }, 'export CRM dedup query failed');
                throw new AppError('Failed to export companies', 500);
            }
            for (const c of crmRows ?? []) {
                const dom = exportDomain((c as { website: string | null }).website);
                if (dom && !crmByDomain.has(dom)) crmByDomain.set(dom, (c as { id: string }).id);
            }
        }

        const toInsert: Array<{ research: ExportRow; row: Record<string, unknown> }> = [];
        for (const r of stillPending) {
            const dom = domainOf(r);
            const existingCrmId = dom ? crmByDomain.get(dom) : undefined;
            if (existingCrmId) {
                links.push({ company_id: r.company_id, crm_company_id: existingCrmId });
                linkedExisting++;
                continue;
            }
            toInsert.push({
                research: r,
                row: {
                    tenant_id: tenantId,
                    name: r.name,
                    website: r.website ?? (r.domain ? `https://${r.domain}` : null),
                    country: r.country,
                    location: [r.city, r.country].filter(Boolean).join(', ') || null,
                    company_summary: r.site_summary,
                    // fit_score is TEXT in the CRM schema; the research score maps 1:1.
                    fit_score: r.score != null ? String(r.score) : null,
                    custom_fields: {
                        'Research Evidence': r.evidence ?? '',
                        'Research Source': 'TG-Research Y1 harvest',
                        // Correlation key: pairs returned CRM rows to research rows WITHOUT relying
                        // on insert-return ordering, and makes a half-failed export retry-safe.
                        research_ref: r.company_id,
                    },
                    // stage defaults 'cold' in the DB — research leads enter the pipeline cold.
                },
            });
        }

        let exported = 0;
        const insertedByRef = new Map<string, string>(); // research id → CRM id (for compensation)
        if (toInsert.length > 0) {
            const { data: inserted, error: insErr } = await supabaseAdmin
                .from('companies')
                .insert(toInsert.map((t) => t.row))
                .select('id, custom_fields');
            if (insErr) {
                log.error({ err: insErr }, 'export CRM insert failed');
                throw new AppError('Failed to export companies', 500);
            }
            for (const row of (inserted ?? []) as Array<{ id: string; custom_fields: Record<string, unknown> | null }>) {
                const ref = row.custom_fields?.['research_ref'];
                if (typeof ref === 'string') {
                    insertedByRef.set(ref, row.id);
                    links.push({ company_id: ref, crm_company_id: row.id });
                } else {
                    log.error({ crmId: row.id }, 'export: inserted CRM row missing research_ref — not linked');
                }
            }
        }

        // Back-link. The RPC re-checks suppression under the lock and returns what it ACTUALLY
        // marked; anything we inserted that was NOT marked (suppressed mid-export / raced) gets
        // its CRM row deleted again (compensation — suppression > dedup end to end).
        let markedIds = new Set<string>();
        if (links.length > 0) {
            const { data: marked, error: markErr } = await researchSupabaseAdmin.rpc('research_mark_exported', {
                p_tenant: tenantId,
                p_links: links,
            });
            if (markErr) {
                // CRM rows exist but carry the correlation key — a RE-RUN links them instead of
                // duplicating (dedup layer 2), so this is safe to retry after investigating.
                log.error({ err: markErr, links: links.length }, 'research_mark_exported failed AFTER CRM insert (re-run is safe — ref-dedup links the rows)');
                throw new AppError('Companies were sent to the CRM but linking failed — re-running is safe', 500);
            }
            markedIds = new Set(((marked ?? []) as string[]));

            let unmarkedInserted = [...insertedByRef.entries()].filter(([ref]) => !markedIds.has(ref));
            if (unmarkedInserted.length > 0) {
                // BELT before deleting (codex P1): if the research row ALREADY points at the very
                // CRM row we inserted, a parallel actor (another instance — the in-process mutex
                // is per tenant here) confirmed our link first. That is SUCCESS, not a suppression
                // race — deleting would leave the research row referencing a dead CRM id.
                const { data: confirmedRows, error: confErr } = await researchSupabaseAdmin
                    .from('research_companies')
                    .select('id, crm_company_id')
                    .eq('tenant_id', tenantId)
                    .in('id', unmarkedInserted.map(([ref]) => ref));
                if (confErr) {
                    log.error({ err: confErr }, 'export compensation confirm-read failed — NOT deleting (manual check)');
                    unmarkedInserted = [];
                } else {
                    const confirmed = new Set(
                        ((confirmedRows ?? []) as Array<{ id: string; crm_company_id: string | null }>)
                            .filter((r) => r.crm_company_id !== null && r.crm_company_id === insertedByRef.get(r.id))
                            .map((r) => r.id)
                    );
                    for (const ref of confirmed) markedIds.add(ref); // count as exported
                    unmarkedInserted = unmarkedInserted.filter(([ref]) => !confirmed.has(ref));
                }
            }
            exported = [...insertedByRef.keys()].filter((ref) => markedIds.has(ref)).length;

            if (unmarkedInserted.length > 0) {
                // Suppressed (or raced) between the read and the mark — remove the CRM copies.
                const { error: delErr } = await supabaseAdmin
                    .from('companies')
                    .delete()
                    .eq('tenant_id', tenantId)
                    .in('id', unmarkedInserted.map(([, crmId]) => crmId));
                if (delErr) {
                    log.error({ err: delErr, count: unmarkedInserted.length }, 'export compensation delete FAILED — suppressed rows remain in CRM, remove manually');
                } else {
                    log.warn({ count: unmarkedInserted.length }, 'export: compensated (deleted) CRM rows for companies suppressed mid-export');
                }
            }
        }

        const linkedMarked = links.filter((l) => markedIds.has(l.company_id) && !insertedByRef.has(l.company_id)).length;
        log.info({ tenantId, icpId: icp_id, exported, linkedExisting: linkedMarked, batch: pending.length }, 'research → CRM export done');
        res.json({
            total_matches: totalMatches ?? 0,
            exported,
            linked_existing: linkedMarked,
            // A FULL batch means more exportable rows may remain — repeat the action to continue
            // (the RPC filters exported rows before its limit, so the next call pages onward).
            has_more: pending.length === EXPORT_BATCH,
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'export companies error');
        next(new AppError('Failed to export companies', 500));
    } finally {
        exportInFlight.delete(lockKey);
    }
});

export default router;
