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
    // Free-text geography OR an approved sub-ICP cell (geo_id, WP2) — at least one is required
    // (handler-checked); with geo_id the geography defaults to the cell's country.
    geography: z.string().min(1).max(120).optional(),
    geo_id: uuidField('Invalid geography ID').optional(),
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
        const { icp_id, geography, geo_id, source, caps: rawCaps } = req.body as z.infer<typeof runSchema>;
        const jobType = source === 'maps' ? RESEARCH_JOB_TYPES.MAPS_HARVEST : RESEARCH_JOB_TYPES.HARVEST_RUN;
        if (!geography && !geo_id) {
            res.status(400).json({ error: 'geography or geo_id required' });
            return;
        }
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

        // WP2: an approved sub-ICP cell may scope the run. Its spec affects DISCOVERY only
        // (query building + validation context in the worker) — verdicts/billing stay keyed to
        // (icp, ruleset_version), so geo state gates admission here, never money.
        let effectiveGeography = geography;
        if (geo_id) {
            const { data: geo, error: geoErr } = await researchSupabaseAdmin
                .from('research_geographies')
                .select('id, icp_id, status, country')
                .eq('id', geo_id)
                .eq('tenant_id', tenantId)
                .maybeSingle();
            if (geoErr) {
                log.error({ err: geoErr }, 'harvest geo lookup failed');
                throw new AppError('Failed to start harvest', 500);
            }
            const cell = geo as { icp_id: string | null; status: string; country: string } | null;
            if (!cell || cell.icp_id !== icp_id || cell.status !== 'approved') {
                res.status(409).json({ error: 'Geography must be an approved cell of this ICP' });
                return;
            }
            // The cell's country IS the run's geography (review P3): a mismatching free-text
            // value would pair one country's queries with another's local terms. Ignore it.
            effectiveGeography = cell.country;
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
                RESEARCH_JOB_TYPES.CHANNELS_HARVEST,
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
            payload: { icp_id, geography: effectiveGeography, source: source ?? 'web', ...(geo_id ? { geo_id } : {}), ...(caps ? { caps } : {}) },
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
                .select('company_id, verdict, score, evidence, elimination_reason, model, created_at, hooks, angle_suggestion', { count: 'exact' })
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
                hooks: string[] | null; angle_suggestion: string | null;
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
                        // WP4 personalization (096) — written by the same validation pass.
                        hooks: v.hooks ?? null,
                        angle_suggestion: v.angle_suggestion ?? null,
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
            // WP4 enrichment (096 RPC): ICP name + personalization hooks + the suggested angle
            // (with the APPROVED offer's value_prop when one matches the code).
            icp_name: string | null; hooks: string[] | null;
            angle_suggestion: string | null; angle_value_prop: string | null;
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
                        // WP4: angle map + per-firm hooks travel with the lead so TG-Core
                        // campaigns can personalize without touching research tables.
                        // 'Research Hooks' is UNTRUSTED-DERIVED text (model output from the
                        // firm's own website, hygienized at write: fences/URLs/emails/pipes
                        // neutralized) — any TG-Core prompt that interpolates it MUST still
                        // fence it as data.
                        ...(r.icp_name ? { 'Research ICP': r.icp_name } : {}),
                        ...(r.angle_suggestion
                            ? { 'Research Angle': r.angle_value_prop ? `${r.angle_suggestion} — ${r.angle_value_prop}` : r.angle_suggestion }
                            : {}),
                        ...(Array.isArray(r.hooks) && r.hooks.length > 0 ? { 'Research Hooks': r.hooks.join(' | ') } : {}),
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

        // ── Enriched contacts ride the export (SELF-HEALING SWEEP) ──────────────────
        // Sources ALL of this tenant's enrichment contacts whose research company is
        // CRM-linked — not just this run's links (codex P2: an exported company drops out
        // of research_exportable_companies, so a failed contact copy would otherwise never
        // be retried). Email-dedup makes every sweep idempotent. DEFENSIVE: a contact-copy
        // failure never fails the company export (already marked) — the NEXT export heals it.
        let contactsExported = 0;
        try {
            type RContact = {
                company_id: string; name: string | null; email: string; title: string | null;
                seniority: string | null; department: string | null; priority: number | null;
            };
            // Keyset-paginate the tenant's enrichment contacts to exhaustion (they only grow
            // by explicit paid runs — bounded in practice).
            const rcontacts: RContact[] = [];
            {
                const PAGE = 1000;
                let lastId: string | null = null;
                for (;;) {
                    let q = researchSupabaseAdmin
                        .from('research_contacts')
                        .select('id, company_id, name, email, title, seniority, department, priority')
                        .eq('tenant_id', tenantId)
                        .eq('suppressed', false)
                        .not('email', 'is', null)
                        .order('id', { ascending: true })
                        .limit(PAGE);
                    if (lastId) q = q.gt('id', lastId);
                    const { data, error } = await q;
                    if (error) throw error;
                    const pageRows = (data ?? []) as Array<RContact & { id: string }>;
                    rcontacts.push(...pageRows);
                    if (pageRows.length < PAGE) break;
                    lastId = pageRows[pageRows.length - 1].id;
                }
                // Bucket priority decides is_primary below — keep the stored order.
                rcontacts.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
            }
            {
                // CRM link map for every contact-bearing research company (chunked).
                const contactCompanyIds = [...new Set(rcontacts.map((c) => c.company_id))];
                const crmIdByResearch = new Map<string, string>();
                for (let i = 0; i < contactCompanyIds.length; i += 50) {
                    const { data, error } = await researchSupabaseAdmin
                        .from('research_companies')
                        .select('id, crm_company_id')
                        .eq('tenant_id', tenantId)
                        .not('crm_company_id', 'is', null)
                        .in('id', contactCompanyIds.slice(i, i + 50));
                    if (error) throw error;
                    for (const r of (data ?? []) as Array<{ id: string; crm_company_id: string }>) {
                        crmIdByResearch.set(r.id, r.crm_company_id);
                    }
                }
                if (rcontacts.length > 0) {
                    // Existing CRM contacts: email keys dedup re-runs; the any-contact set decides
                    // is_primary (only the first contact of a previously contactless company).
                    const crmIds = [...new Set(rcontacts.map((c) => crmIdByResearch.get(c.company_id)).filter(Boolean))] as string[];
                    const existingEmailKeys = new Set<string>();
                    const hasAnyContact = new Set<string>();
                    for (let i = 0; i < crmIds.length; i += 50) {
                        const { data, error } = await supabaseAdmin
                            .from('contacts')
                            .select('company_id, email')
                            .eq('tenant_id', tenantId)
                            .in('company_id', crmIds.slice(i, i + 50));
                        if (error) throw error;
                        for (const row of (data ?? []) as Array<{ company_id: string; email: string | null }>) {
                            hasAnyContact.add(row.company_id);
                            if (row.email) existingEmailKeys.add(`${row.company_id}:${row.email.toLowerCase()}`);
                        }
                    }
                    const rows: Record<string, unknown>[] = [];
                    for (const c of rcontacts) {
                        const crmId = crmIdByResearch.get(c.company_id);
                        if (!crmId) continue;
                        const key = `${crmId}:${c.email.toLowerCase()}`;
                        if (existingEmailKeys.has(key)) continue;
                        existingEmailKeys.add(key); // in-batch dedup too
                        const nameParts = (c.name ?? '').trim().split(/\s+/).filter(Boolean);
                        rows.push({
                            tenant_id: tenantId,
                            company_id: crmId,
                            first_name: nameParts[0] ?? c.email.split('@')[0],
                            last_name: nameParts.slice(1).join(' ') || null,
                            title: c.title,
                            email: c.email,
                            seniority: c.seniority,
                            department: c.department,
                            is_primary: !hasAnyContact.has(crmId),
                        });
                        hasAnyContact.add(crmId);
                    }
                    for (let i = 0; i < rows.length; i += 200) {
                        const chunk = rows.slice(i, i + 200);
                        const { error } = await supabaseAdmin.from('contacts').insert(chunk);
                        if (error) throw error;
                        contactsExported += chunk.length;
                    }
                }
            }
        } catch (contactErr) {
            log.warn({ err: contactErr, tenantId }, 'contact export failed (companies exported fine — re-running the export copies the contacts)');
        }

        const linkedMarked = links.filter((l) => markedIds.has(l.company_id) && !insertedByRef.has(l.company_id)).length;
        log.info({ tenantId, icpId: icp_id, exported, linkedExisting: linkedMarked, contactsExported, batch: pending.length }, 'research → CRM export done');
        res.json({
            total_matches: totalMatches ?? 0,
            exported,
            linked_existing: linkedMarked,
            contacts_exported: contactsExported,
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
