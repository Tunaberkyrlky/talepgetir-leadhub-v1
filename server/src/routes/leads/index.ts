/**
 * Lead Inbox + form/source management (v3 WP1, protected).
 * Mirrors routes/tasks.ts: supabaseAdmin + explicit req.tenantId! filter,
 * writeRoles guard, Zod validation. RLS is defense-in-depth on top.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { resolveUsers } from '../../lib/userResolver.js';
import { emitEvent } from '../../lib/automation/outbox.js';
import {
    validateBody,
    createLeadFormSchema,
    createLeadSourceSchema,
    enqueueEnrichmentSchema,
    resolveQualificationSchema,
    reviewQuerySchema,
    LEAD_SOURCE_TYPES,
    LEAD_LIFECYCLE_STATUSES,
} from '../../lib/validation.js';
import { qualifyLead, type QualificationFormFields, type QualificationRecipe } from '../../lib/leads/qualification.js';
import { gatherWebsiteEvidence, enrichmentMode } from '../../lib/leads/enrichmentAdapter.js';

const router = Router();
const log = createLogger('route:leads');
const writeRoles = requireRole('superadmin', 'ops_agent', 'client_admin');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public form slug: a server-generated OPAQUE token — never derived from the
 *  form name and never client-supplied. 18 random bytes → 24 base64url chars
 *  (144-bit), so the unauthenticated intake slug cannot be guessed/enumerated. */
function generateSlug(): string {
    return randomBytes(18).toString('base64url');
}

interface LeadRelations {
    owner_id?: string | null;
    companies?: { name?: string } | null;
    contacts?: { first_name?: string; last_name?: string | null } | null;
    lead_sources?: { display_name?: string } | null;
    [key: string]: unknown;
}

async function mapLeadRelations(rows: LeadRelations[]) {
    const users = await resolveUsers(rows.map((r) => r.owner_id || '').filter(Boolean));
    return rows.map((row) => {
        const contactName = row.contacts
            ? [row.contacts.first_name, row.contacts.last_name].filter(Boolean).join(' ') || null
            : null;
        const { companies, contacts, lead_sources, ...lead } = row;
        return {
            ...lead,
            company_name: companies?.name || null,
            contact_name: contactName,
            source_name: lead_sources?.display_name || null,
            owner: row.owner_id ? users.get(row.owner_id) || null : null,
        };
    });
}

// Map a qualification verdict → the leads.qualification_status enum (which uses
// 'needs_review' for the ambiguous case). This ONLY writes qualification_status +
// score; it deliberately never touches lifecycle_status (identity/deliverability
// review is a DISTINCT queue from qualification review).
const VERDICT_TO_QUAL: Record<string, string> = {
    qualified: 'qualified',
    disqualified: 'disqualified',
    review: 'needs_review',
};

/** Build the qualification form-field view from a submission's normalized snapshot. */
function formFieldsFromNormalized(normalized: Record<string, unknown> | null): QualificationFormFields {
    const n = (normalized || {}) as Record<string, unknown>;
    const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
    return {
        email: s(n.email),
        companyName: s(n.companyName),
        website: s(n.website),
        domain: s(n.domain),
        country: s(n.country),
        fullName: s(n.fullName) || s(n.firstName),
        phone: s(n.phone),
        title: s(n.title),
    };
}

interface EnrichLeadRow {
    id: string;
    company_id: string | null;
    owner_id: string | null;
    source_id: string | null;
    raw_submission_id: string | null;
}

/**
 * Run one enrichment+qualification pass for a queued run (fire-and-forget; the
 * long-lived process makes background work after the response safe — CLAUDE.md).
 * READ-ONLY adapter, DRY-RUN by default. On completion it writes the run result
 * and syncs the lead's qualification_status + score. Low-confidence ⇒ verdict
 * 'review' ⇒ it stays in the human review queue and NEVER triggers outbound.
 */
async function runEnrichment(tenantId: string, runId: string, lead: EnrichLeadRow): Promise<void> {
    try {
        // NOTE: every .update() below is error-checked and THROWS on failure so the
        // catch marks the run failed — a swallowed write must never look like success.
        const { error: runningErr } = await supabaseAdmin.from('lead_enrichment_runs')
            .update({ status: 'running', started_at: new Date().toISOString() })
            .eq('id', runId).eq('tenant_id', tenantId);
        if (runningErr) throw new Error(`mark running failed: ${runningErr.message}`);

        // Form fields come from the immutable submission's normalized snapshot.
        let normalized: Record<string, unknown> | null = null;
        if (lead.raw_submission_id) {
            const { data: sub } = await supabaseAdmin
                .from('lead_submissions').select('normalized')
                .eq('id', lead.raw_submission_id).eq('tenant_id', tenantId).maybeSingle();
            normalized = (sub as { normalized?: Record<string, unknown> } | null)?.normalized ?? null;
        }
        const formFields = formFieldsFromNormalized(normalized);

        // Recipe: per-source override, else the built-in default (qualification.ts).
        let recipe: QualificationRecipe | null = null;
        let sourceOwnerId: string | null = null;
        if (lead.source_id) {
            const { data: src } = await supabaseAdmin
                .from('lead_sources').select('qualification_recipe, default_owner_id')
                .eq('id', lead.source_id).eq('tenant_id', tenantId).maybeSingle();
            recipe = (src as { qualification_recipe?: QualificationRecipe | null } | null)?.qualification_recipe ?? null;
            sourceOwnerId = (src as { default_owner_id?: string | null } | null)?.default_owner_id ?? null;
        }

        const { websiteEvidence, sourceEvidence } = await gatherWebsiteEvidence(tenantId, lead.company_id, formFields);
        const result = qualifyLead(formFields, websiteEvidence, recipe);

        const { error: doneErr } = await supabaseAdmin.from('lead_enrichment_runs').update({
            status: 'done',
            score: result.score,
            verdict: result.verdict,
            evidence: result.evidence,
            reason_codes: result.reasonCodes,
            source_evidence: sourceEvidence,
            suggested_owner_id: lead.owner_id ?? sourceOwnerId,
            completed_at: new Date().toISOString(),
        }).eq('id', runId).eq('tenant_id', tenantId);
        if (doneErr) throw new Error(`write run result failed: ${doneErr.message}`);

        // Sync the lead's qualification fields ONLY (never lifecycle_status).
        const { error: leadErr } = await supabaseAdmin.from('leads').update({
            qualification_status: VERDICT_TO_QUAL[result.verdict],
            score: result.score,
        }).eq('id', lead.id).eq('tenant_id', tenantId);
        if (leadErr) throw new Error(`sync lead qualification failed: ${leadErr.message}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'enrichment failed';
        log.error({ err, runId, leadId: lead.id }, 'lead enrichment run failed');
        const { error: failErr } = await supabaseAdmin.from('lead_enrichment_runs')
            .update({ status: 'failed', error_reason: message, completed_at: new Date().toISOString() })
            .eq('id', runId).eq('tenant_id', tenantId);
        if (failErr) log.error({ err: failErr, runId }, 'failed to mark enrichment run failed');
    }
}

// ── GET / — Lead Inbox list (queue-filtered) ──────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
        const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '25'), 10) || 25));
        const offset = (page - 1) * limit;

        let query = supabaseAdmin
            .from('leads')
            .select('*, companies(name), contacts(first_name, last_name), lead_sources(display_name)', { count: 'exact' })
            .eq('tenant_id', tenantId);

        // lifecycle: comma-separated queue (e.g. "captured,identity_pending" for the New tab).
        const lifecycle = typeof req.query.lifecycle === 'string' ? req.query.lifecycle : '';
        if (lifecycle) {
            const wanted = lifecycle.split(',').map((s) => s.trim()).filter(Boolean);
            const invalid = wanted.find((s) => !LEAD_LIFECYCLE_STATUSES.includes(s as typeof LEAD_LIFECYCLE_STATUSES[number]));
            if (invalid) throw new AppError('Invalid lifecycle filter', 400);
            query = query.in('lifecycle_status', wanted);
        }

        const sourceType = typeof req.query.source_type === 'string' ? req.query.source_type : '';
        if (sourceType) {
            if (!LEAD_SOURCE_TYPES.includes(sourceType as typeof LEAD_SOURCE_TYPES[number])) throw new AppError('Invalid source_type', 400);
            query = query.eq('source_type', sourceType);
        }

        const { data, count, error } = await query
            .order('captured_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) {
            log.error({ err: error }, 'List leads failed');
            throw new AppError('Failed to fetch leads', 500);
        }

        const mapped = await mapLeadRelations((data || []) as LeadRelations[]);
        const total = count || 0;
        res.json({
            data: mapped,
            pagination: {
                page, limit, total,
                totalPages: Math.ceil(total / limit),
                hasNext: offset + mapped.length < total,
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /spam — spam_suspect submissions (honeypot / Turnstile), no lead ──────
// Registered BEFORE '/:id' so the literal path wins. These rows never became
// leads, so they are invisible in the lead-based queues above; surface them here
// for audit (MEGA §3.6: spam is stored, not silently dropped).
router.get('/spam', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
        const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '25'), 10) || 25));
        const offset = (page - 1) * limit;

        const { data, count, error } = await supabaseAdmin
            .from('lead_submissions')
            .select('id, normalized, dedupe_result, review_reason, submitted_at, lead_forms(name)', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .eq('processing_status', 'spam_suspect')
            .order('submitted_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) {
            log.error({ err: error }, 'List spam submissions failed');
            throw new AppError('Failed to fetch spam submissions', 500);
        }

        const mapped = ((data || []) as Record<string, unknown>[]).map((row) => {
            const norm = (row.normalized || {}) as { email?: string | null; fullName?: string | null };
            const formRel = row.lead_forms as { name?: string } | null;
            return {
                id: row.id as string,
                email: norm.email ?? null,
                name: norm.fullName ?? null,
                form_name: formRel?.name ?? null,
                reason: (row.review_reason as string | null) ?? (row.dedupe_result as string | null) ?? null,
                submitted_at: row.submitted_at as string,
            };
        });
        const total = count || 0;
        res.json({
            data: mapped,
            pagination: {
                page, limit, total,
                totalPages: Math.ceil(total / limit),
                hasNext: offset + mapped.length < total,
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── Sources ───────────────────────────────────────────────────────────────────
router.get('/sources', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { data, error } = await supabaseAdmin
            .from('lead_sources')
            .select('*')
            .eq('tenant_id', req.tenantId!)
            .order('created_at', { ascending: false });
        if (error) throw new AppError('Failed to fetch lead sources', 500);
        res.json({ data: data || [] });
    } catch (err) {
        next(err);
    }
});

router.post('/sources', writeRoles, validateBody(createLeadSourceSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { data, error } = await supabaseAdmin
            .from('lead_sources')
            .insert({
                tenant_id: req.tenantId!,
                provider: req.body.provider,
                source_type: req.body.source_type,
                display_name: req.body.display_name,
                default_owner_id: req.body.default_owner_id || null,
                config: req.body.config || {},
                is_active: req.body.is_active,
            })
            .select('*')
            .single();
        if (error) {
            log.error({ err: error }, 'Create lead source failed');
            throw new AppError('Failed to create lead source', 500);
        }
        res.status(201).json({ data });
    } catch (err) {
        next(err);
    }
});

// ── Forms ──────────────────────────────────────────────────────────────────────
router.get('/forms', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { data, error } = await supabaseAdmin
            .from('lead_forms')
            .select('*')
            .eq('tenant_id', req.tenantId!)
            .order('created_at', { ascending: false });
        if (error) throw new AppError('Failed to fetch lead forms', 500);
        res.json({ data: data || [] });
    } catch (err) {
        next(err);
    }
});

router.post('/forms', writeRoles, validateBody(createLeadFormSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        if (req.body.source_id) {
            const { data: src } = await supabaseAdmin
                .from('lead_sources').select('id').eq('id', req.body.source_id).eq('tenant_id', tenantId).maybeSingle();
            if (!src) throw new AppError('Lead source not found', 422);
        }
        // Slug is ALWAYS server-generated; any client-supplied public_slug is ignored.
        const slug = generateSlug();
        const { data, error } = await supabaseAdmin
            .from('lead_forms')
            .insert({
                tenant_id: tenantId,
                source_id: req.body.source_id || null,
                name: req.body.name,
                public_slug: slug,
                external_form_id: req.body.external_form_id || null,
                field_mapping: req.body.field_mapping || {},
                honeypot_field: req.body.honeypot_field || '_hp',
                consent_version: req.body.consent_version || null,
                consent_copy: req.body.consent_copy || null,
                success_behavior: req.body.success_behavior || { type: 'message' },
                is_active: req.body.is_active,
            })
            .select('*')
            .single();
        if (error) {
            // 23505 ⇒ the (globally unique) slug is taken.
            if (error.code === '23505') throw new AppError('Form slug already in use', 409);
            log.error({ err: error }, 'Create lead form failed');
            throw new AppError('Failed to create lead form', 500);
        }
        res.status(201).json({ data });
    } catch (err) {
        next(err);
    }
});

// ── GET /review — qualification review queue (verdict=review, unresolved) ─────
// Registered BEFORE '/:id' so the literal path wins. This is the QUALIFICATION
// review queue (enrichment verdict), DISTINCT from the identity/deliverability
// 'needs_review' lifecycle queue. Only low-confidence, human-unresolved runs.
router.get('/review', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { page, limit } = reviewQuerySchema.parse(req.query);
        const offset = (page - 1) * limit;

        const { data, count, error } = await supabaseAdmin
            .from('lead_enrichment_runs')
            .select(
                'id, lead_id, verdict, score, reason_codes, evidence, created_at, ' +
                'leads(source_type, captured_at, company_id, contact_id, companies(name), contacts(first_name, last_name), lead_sources(display_name))',
                { count: 'exact' },
            )
            .eq('tenant_id', tenantId)
            .eq('verdict', 'review')
            .is('resolved_verdict', null)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) {
            log.error({ err: error }, 'List review queue failed');
            throw new AppError('Failed to fetch review queue', 500);
        }

        const mapped = ((data || []) as unknown as Record<string, unknown>[]).map((row) => {
            const lead = (row.leads || {}) as {
                source_type?: string; captured_at?: string; company_id?: string | null; contact_id?: string | null;
                companies?: { name?: string } | null;
                contacts?: { first_name?: string; last_name?: string | null } | null;
                lead_sources?: { display_name?: string } | null;
            };
            const contactName = lead.contacts
                ? [lead.contacts.first_name, lead.contacts.last_name].filter(Boolean).join(' ') || null
                : null;
            return {
                id: row.id as string,
                lead_id: row.lead_id as string,
                verdict: row.verdict as string,
                score: (row.score as number | null) ?? null,
                reason_codes: (row.reason_codes as string[] | null) ?? [],
                evidence: (row.evidence as unknown[] | null) ?? [],
                created_at: row.created_at as string,
                source_type: lead.source_type ?? null,
                source_name: lead.lead_sources?.display_name ?? null,
                company_id: lead.company_id ?? null,
                contact_id: lead.contact_id ?? null,
                company_name: lead.companies?.name ?? null,
                contact_name: contactName,
                captured_at: lead.captured_at ?? null,
            };
        });
        const total = count || 0;
        res.json({
            data: mapped,
            pagination: {
                page, limit, total,
                totalPages: Math.ceil(total / limit),
                hasNext: offset + mapped.length < total,
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id — lead detail (submission + touchpoints) ─────────────────────────
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid lead id', 400);
        const tenantId = req.tenantId!;
        const { data: lead, error } = await supabaseAdmin
            .from('leads')
            .select('*, companies(name), contacts(first_name, last_name), lead_sources(display_name)')
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (error) throw new AppError('Failed to fetch lead', 500);
        if (!lead) throw new AppError('Lead not found', 404);

        const [mapped] = await mapLeadRelations([lead as LeadRelations]);

        const { data: submission } = await supabaseAdmin
            .from('lead_submissions')
            .select('id, raw_payload, normalized, utm, external_lead_id, processing_status, dedupe_result, error_reason, review_reason, submitted_at')
            .eq('id', (lead as { raw_submission_id?: string }).raw_submission_id || '')
            .eq('tenant_id', tenantId)
            .maybeSingle();

        const { data: touchpoints } = await supabaseAdmin
            .from('lead_touchpoints')
            .select('*')
            .eq('lead_id', req.params.id)
            .eq('tenant_id', tenantId)
            .order('event_time', { ascending: true });

        res.json({ data: { ...mapped, submission: submission || null, touchpoints: touchpoints || [] } });
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/enrich — enqueue an enrichment run (async, dry-run) ─────────────
// Intake never waits on enrichment; this creates a SEPARATE queued run and returns
// immediately (202). Processing is fire-and-forget in-process. Mode is server-gated.
router.post('/:id/enrich', writeRoles, validateBody(enqueueEnrichmentSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid lead id', 400);
        const tenantId = req.tenantId!;
        const { data: lead, error } = await supabaseAdmin
            .from('leads')
            .select('id, company_id, owner_id, source_id, raw_submission_id')
            .eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle();
        if (error) throw new AppError('Failed to load lead', 500);
        if (!lead) throw new AppError('Lead not found', 404);

        const mode = enrichmentMode();
        const { data: run, error: insErr } = await supabaseAdmin
            .from('lead_enrichment_runs')
            .insert({ tenant_id: tenantId, lead_id: (lead as EnrichLeadRow).id, status: 'queued', mode })
            .select('id, status, mode, created_at')
            .single();
        if (insErr) {
            log.error({ err: insErr }, 'Enqueue enrichment failed');
            throw new AppError('Failed to enqueue enrichment', 500);
        }

        // Fire-and-forget: the response returns while the run processes in-process.
        void runEnrichment(tenantId, (run as { id: string }).id, lead as EnrichLeadRow);

        res.status(202).json({ data: run });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id/enrichment — latest enrichment run for a lead (read model) ───────
router.get('/:id/enrichment', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid lead id', 400);
        const tenantId = req.tenantId!;
        const { data, error } = await supabaseAdmin
            .from('lead_enrichment_runs')
            .select('*')
            .eq('lead_id', req.params.id).eq('tenant_id', tenantId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) throw new AppError('Failed to fetch enrichment run', 500);
        res.json({ data: data || null });
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/resolve — human resolves a qualification verdict ────────────────
// Records the human's call (qualify/disqualify) on ONE specific review run + syncs
// the lead's qualification_status — atomically, in a single DB transaction
// (resolve_lead_enrichment RPC), so the run write and lead write can't race or
// half-apply. The client pins the exact run via run_id. NEVER triggers outbound —
// a resolved lead is simply routed for a later phase's automation, not messaged here.
router.post('/:id/resolve', writeRoles, validateBody(resolveQualificationSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid lead id', 400);
        const tenantId = req.tenantId!;

        const { data, error } = await supabaseAdmin.rpc('resolve_lead_enrichment', {
            p_tenant_id: tenantId,
            p_run_id: req.body.run_id as string,
            p_resolver: req.user?.id ?? null,
            p_verdict: req.body.verdict as string,
            p_note: req.body.note ?? null,
        });
        if (error) {
            log.error({ err: error, runId: req.body.run_id }, 'Resolve qualification failed');
            throw new AppError('Failed to resolve qualification', 500);
        }
        // NULL ⇒ no resolvable run matched (wrong run/tenant, already resolved, or
        // not a review verdict) — a conflict, not a server fault.
        if (!data) {
            throw new AppError(
                'Enrichment run is not resolvable (already resolved or not in review)',
                409,
                'run_conflict',
            );
        }

        // ── Automation runtime event (v3 §10.1, Phase 5). Best-effort append after the
        // atomic resolve, reading the verdict the RPC actually persisted; awaited to
        // narrow the loss window (safe — emitEvent never throws). dedup_key keeps a
        // re-resolve idempotent-on-retry. No consumer runs this round — outbox row only.
        const resolvedVerdict = (data as { resolved_verdict?: string | null }).resolved_verdict;
        if (resolvedVerdict === 'qualified' || resolvedVerdict === 'disqualified') {
            await emitEvent(
                tenantId,
                resolvedVerdict === 'qualified' ? 'lead.qualified' : 'lead.disqualified',
                { aggregate_type: 'lead', aggregate_id: req.params.id as string },
                { run_id: req.body.run_id as string, resolved_by: req.user?.id ?? null },
                { dedupKey: `${req.params.id}:${resolvedVerdict}` },
            );
        }

        res.json({ data });
    } catch (err) {
        next(err);
    }
});

export default router;
