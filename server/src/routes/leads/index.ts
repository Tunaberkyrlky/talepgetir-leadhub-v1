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
import {
    validateBody,
    createLeadFormSchema,
    createLeadSourceSchema,
    LEAD_SOURCE_TYPES,
    LEAD_LIFECYCLE_STATUSES,
} from '../../lib/validation.js';

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

export default router;
