/**
 * Asset Studio (v3 WP3, protected). Recipes + generated assets + telemetry skeleton.
 * Mirrors routes/leads/index.ts: supabaseAdmin + explicit req.tenantId! filter,
 * writeRoles guard, Zod validation. RLS is defense-in-depth on top.
 *
 * GUARDRAIL: generation is DRY-RUN by default (generator.assetLlmMode) — no LLM call
 * unattended (COGS $0). R2 upload is env-gated inert (rendered_html kept inline).
 * Approve → publish is manual: an asset can NOT publish until it is approved.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import {
    validateBody,
    generateAssetSchema,
    approveAssetSchema,
    publishAssetSchema,
    assetEventSchema,
} from '../../lib/validation.js';
import {
    gatherAssetEvidence,
    generateStructuredContent,
    assetLlmMode,
    type AssetRecipeInput,
    type AssetTarget,
} from '../../lib/assets/generator.js';
import { renderHtml, type RenderTheme } from '../../lib/assets/renderer.js';
import { uploadRenderedHtml } from '../../lib/assets/storage.js';

const router = Router();
const log = createLogger('route:assets');
const writeRoles = requireRole('superadmin', 'ops_agent', 'client_admin');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque, server-generated access slug (18 random bytes → 24 base64url chars). */
function generateSlug(): string {
    return randomBytes(18).toString('base64url');
}

interface RecipeRow {
    id: string;
    key: string;
    name: string;
    description: string | null;
    prompt_template: string | null;
    schema_version: number;
    template: string;
    theme: RenderTheme | null;
    cta_config: { label?: string; url?: string | null; booking_url?: string | null } | null;
    output_kind: string;
    approval_policy: string;
    status: string;
}

/**
 * Run one generation pass for a queued asset (fire-and-forget; the long-lived
 * process makes background work after the response safe — CLAUDE.md). DRY-RUN by
 * default (deterministic structured JSON, no LLM). Writes structured_content + the
 * rendered HTML (inline when R2 is inert) + the immutable source_evidence_snapshot.
 */
async function runAssetGeneration(
    tenantId: string,
    assetId: string,
    recipe: RecipeRow,
    target: AssetTarget,
): Promise<void> {
    try {
        const { error: genErr } = await supabaseAdmin.from('generated_assets')
            .update({ status: 'generating' })
            .eq('id', assetId).eq('tenant_id', tenantId);
        if (genErr) throw new Error(`mark generating failed: ${genErr.message}`);

        const { evidence, snapshot } = await gatherAssetEvidence(tenantId, target);
        const recipeInput: AssetRecipeInput = {
            key: recipe.key,
            name: recipe.name,
            description: recipe.description,
            prompt_template: recipe.prompt_template,
            cta_config: recipe.cta_config,
        };
        const { content } = await generateStructuredContent(recipeInput, evidence);
        const html = renderHtml(content, recipe.theme || {});

        // R2 is env-gated inert: key is null ⇒ keep the HTML inline in the DB.
        const key = await uploadRenderedHtml(tenantId, assetId, html);

        // source_evidence_snapshot is written ONCE here (write-once/immutable) so a
        // given recipe+version stays auditable; approve/publish never touch it.
        const { error: doneErr } = await supabaseAdmin.from('generated_assets').update({
            status: 'generated',
            structured_content: content,
            rendered_html: key ? null : html,
            rendered_html_key: key,
            source_evidence_snapshot: snapshot,
        }).eq('id', assetId).eq('tenant_id', tenantId);
        if (doneErr) throw new Error(`write asset result failed: ${doneErr.message}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'asset generation failed';
        log.error({ err, assetId }, 'asset generation run failed');
        const { error: failErr } = await supabaseAdmin.from('generated_assets')
            .update({ status: 'failed', error_reason: message })
            .eq('id', assetId).eq('tenant_id', tenantId);
        if (failErr) log.error({ err: failErr, assetId }, 'failed to mark asset generation failed');
    }
}

// ── GET /recipes — recipe catalog for the tenant ──────────────────────────────
// Literal path registered before '/:id'.
router.get('/recipes', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { data, error } = await supabaseAdmin
            .from('asset_recipes')
            .select('id, key, name, description, output_kind, approval_policy, status, created_at')
            .eq('tenant_id', req.tenantId!)
            .order('created_at', { ascending: false });
        if (error) throw new AppError('Failed to fetch asset recipes', 500);
        res.json({ data: data || [] });
    } catch (err) {
        next(err);
    }
});

// ── GET / — generated asset list (metadata; rendered_html fetched per-detail) ──
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
        const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '25'), 10) || 25));
        const offset = (page - 1) * limit;

        const { data, count, error } = await supabaseAdmin
            .from('generated_assets')
            .select(
                'id, recipe_id, recipe_version, status, delivery_mode, published_at, approved_at, ' +
                'created_at, error_reason, lead_id, company_id, contact_id, ' +
                'asset_recipes(name), companies(name), contacts(first_name, last_name)',
                { count: 'exact' },
            )
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) {
            log.error({ err: error }, 'List generated assets failed');
            throw new AppError('Failed to fetch generated assets', 500);
        }

        const mapped = ((data || []) as unknown as Record<string, unknown>[]).map((row) => {
            const recipe = (row.asset_recipes || null) as { name?: string } | null;
            const company = (row.companies || null) as { name?: string } | null;
            const contact = (row.contacts || null) as { first_name?: string; last_name?: string | null } | null;
            const contactName = contact
                ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || null
                : null;
            return {
                id: row.id as string,
                recipe_id: row.recipe_id as string,
                recipe_name: recipe?.name ?? null,
                recipe_version: (row.recipe_version as number) ?? 1,
                status: row.status as string,
                delivery_mode: row.delivery_mode as string,
                published_at: (row.published_at as string | null) ?? null,
                approved_at: (row.approved_at as string | null) ?? null,
                created_at: row.created_at as string,
                error_reason: (row.error_reason as string | null) ?? null,
                lead_id: (row.lead_id as string | null) ?? null,
                company_id: (row.company_id as string | null) ?? null,
                contact_id: (row.contact_id as string | null) ?? null,
                company_name: company?.name ?? null,
                contact_name: contactName,
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

// ── POST /generate — enqueue a generation run (async, dry-run) ────────────────
// Validates the recipe + any target links belong to the tenant, inserts a queued
// asset, and processes it fire-and-forget in-process (202). Mode is server-gated.
router.post('/generate', writeRoles, validateBody(generateAssetSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { recipe_id, lead_id, company_id, contact_id, delivery_mode } = req.body as {
            recipe_id: string; lead_id?: string | null; company_id?: string | null;
            contact_id?: string | null; delivery_mode: 'public' | 'gated';
        };

        const { data: recipeData, error: recipeErr } = await supabaseAdmin
            .from('asset_recipes')
            .select('id, key, name, description, prompt_template, schema_version, template, theme, cta_config, output_kind, approval_policy, status')
            .eq('id', recipe_id).eq('tenant_id', tenantId).maybeSingle();
        if (recipeErr) throw new AppError('Failed to load recipe', 500);
        if (!recipeData) throw new AppError('Recipe not found', 404);
        const recipe = recipeData as RecipeRow;
        if (recipe.status !== 'active') throw new AppError('Recipe is not active', 422);

        // Existence (per-tenant) first — the DB trigger also fences cross-tenant links.
        let leadRow: { company_id: string | null; contact_id: string | null } | null = null;
        let contactRow: { company_id: string | null } | null = null;
        if (lead_id) {
            const { data } = await supabaseAdmin.from('leads')
                .select('company_id, contact_id').eq('id', lead_id).eq('tenant_id', tenantId).maybeSingle();
            if (!data) throw new AppError('Linked leads record not found', 422);
            leadRow = data as { company_id: string | null; contact_id: string | null };
        }
        if (contact_id) {
            const { data } = await supabaseAdmin.from('contacts')
                .select('company_id').eq('id', contact_id).eq('tenant_id', tenantId).maybeSingle();
            if (!data) throw new AppError('Linked contacts record not found', 422);
            contactRow = data as { company_id: string | null };
        }
        if (company_id) {
            const { data } = await supabaseAdmin.from('companies')
                .select('id').eq('id', company_id).eq('tenant_id', tenantId).maybeSingle();
            if (!data) throw new AppError('Linked companies record not found', 422);
        }

        // Relationship consistency (same-tenant is not enough): a Company B evidence
        // row must not be stapled onto a Lead A / Contact from Company C. Reject any
        // target graph whose links disagree (400) — evidence must be self-consistent.
        if (leadRow && company_id && leadRow.company_id && leadRow.company_id !== company_id)
            throw new AppError('lead_id and company_id belong to different companies', 400);
        if (leadRow && contact_id && leadRow.contact_id && leadRow.contact_id !== contact_id)
            throw new AppError('lead_id is linked to a different contact_id', 400);
        if (contactRow && company_id && contactRow.company_id && contactRow.company_id !== company_id)
            throw new AppError('contact_id belongs to a different company_id', 400);
        if (leadRow && contactRow && leadRow.company_id && contactRow.company_id
            && leadRow.company_id !== contactRow.company_id)
            throw new AppError('lead_id and contact_id belong to different companies', 400);

        const cta = recipe.cta_config || {};
        const { data: asset, error: insErr } = await supabaseAdmin
            .from('generated_assets')
            .insert({
                tenant_id: tenantId,
                recipe_id: recipe.id,
                recipe_version: recipe.schema_version,
                lead_id: lead_id || null,
                company_id: company_id || null,
                contact_id: contact_id || null,
                status: 'queued',
                delivery_mode,
                access_slug: generateSlug(),
                cta_url: cta.url ?? null,
                booking_url: cta.booking_url ?? null,
            })
            .select('id, status, delivery_mode, created_at')
            .single();
        if (insErr) {
            log.error({ err: insErr }, 'Enqueue asset generation failed');
            throw new AppError('Failed to enqueue asset generation', 500);
        }

        // Fire-and-forget: the response returns while the run processes in-process.
        void runAssetGeneration(tenantId, (asset as { id: string }).id, recipe, {
            leadId: lead_id || null, companyId: company_id || null, contactId: contact_id || null,
        });

        res.status(202).json({ data: { ...asset, mode: assetLlmMode() } });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id — generated asset detail (read model, includes rendered HTML) ────
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid asset id', 400);
        const tenantId = req.tenantId!;
        const { data, error } = await supabaseAdmin
            .from('generated_assets')
            .select('*, asset_recipes(name), companies(name), contacts(first_name, last_name)')
            .eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle();
        if (error) throw new AppError('Failed to fetch asset', 500);
        if (!data) throw new AppError('Asset not found', 404);

        const row = data as Record<string, unknown>;
        const recipe = (row.asset_recipes || null) as { name?: string } | null;
        const company = (row.companies || null) as { name?: string } | null;
        const contact = (row.contacts || null) as { first_name?: string; last_name?: string | null } | null;
        const { asset_recipes, companies, contacts, ...asset } = row;
        res.json({
            data: {
                ...asset,
                recipe_name: recipe?.name ?? null,
                company_name: company?.name ?? null,
                contact_name: contact
                    ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || null
                    : null,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/approve — manual approval (approve → publish gate) ──────────────
router.post('/:id/approve', writeRoles, validateBody(approveAssetSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid asset id', 400);
        const tenantId = req.tenantId!;

        // Only a 'generated' (not failed/queued) and not-yet-approved asset is approvable.
        const { data, error } = await supabaseAdmin
            .from('generated_assets')
            .update({ approved_by: req.user?.id ?? null, approved_at: new Date().toISOString() })
            .eq('id', req.params.id).eq('tenant_id', tenantId)
            .eq('status', 'generated').is('approved_at', null)
            .select('id, approved_at, approved_by')
            .maybeSingle();
        if (error) throw new AppError('Failed to approve asset', 500);
        if (!data) throw new AppError('Asset is not approvable (not generated, or already approved)', 409, 'asset_conflict');
        res.json({ data });
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/publish — publish an APPROVED asset ─────────────────────────────
// Manual-approval MVP: publish is rejected unless approved_at is set. published_at
// stamps the go-live; it never triggers outbound (no email/send here).
router.post('/:id/publish', writeRoles, validateBody(publishAssetSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid asset id', 400);
        const tenantId = req.tenantId!;

        const { data, error } = await supabaseAdmin
            .from('generated_assets')
            .update({ published_at: new Date().toISOString() })
            .eq('id', req.params.id).eq('tenant_id', tenantId)
            .eq('status', 'generated')
            .not('approved_at', 'is', null)     // approve → publish gate
            .is('published_at', null)
            .select('id, published_at')
            .maybeSingle();
        if (error) throw new AppError('Failed to publish asset', 500);
        if (!data) throw new AppError('Asset is not publishable (must be approved and not already published)', 409, 'asset_conflict');
        res.json({ data });
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/events — telemetry ingest skeleton (tenant-scoped, writer-gated) ─
// Guarded by writeRoles so a plain tenant viewer can NOT forge telemetry through the
// authenticated API. This is the internal seam only; PUBLIC telemetry ingest (a real
// delivery surface authenticating an unauthenticated visitor via access_slug + a
// separate unauthenticated path) is a FUTURE WP, not this one. No real traffic here.
router.post('/:id/events', writeRoles, validateBody(assetEventSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid asset id', 400);
        const tenantId = req.tenantId!;

        const { data: asset } = await supabaseAdmin
            .from('generated_assets').select('id')
            .eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle();
        if (!asset) throw new AppError('Asset not found', 404);

        const { data, error } = await supabaseAdmin
            .from('asset_events')
            .insert({
                tenant_id: tenantId,
                generated_asset_id: req.params.id,
                event_type: req.body.event_type,
                meta: req.body.meta || {},
            })
            .select('id, event_type, occurred_at')
            .single();
        if (error) {
            log.error({ err: error }, 'Ingest asset event failed');
            throw new AppError('Failed to record asset event', 500);
        }
        res.status(201).json({ data });
    } catch (err) {
        next(err);
    }
});

export default router;
