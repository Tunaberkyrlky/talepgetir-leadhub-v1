import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import {
    validateBody,
    createTagSchema,
    updateTagSchema,
    linkCompanyTagSchema,
} from '../lib/validation.js';

// Tenant-scoped tags + company⇄tag links (v2 Phase 6, slice E4). Adopts the shared
// staging `tags` / `company_tags` tables (migration 139). Reads use supabaseAdmin
// scoped by an explicit tenant_id (same posture as deals.ts / tasks.ts); writes are
// role-gated on top of the DB RLS + tenant-consistency fence.
const router = Router();
const log = createLogger('route:tags');
const writeRoles = requireRole('superadmin', 'ops_agent', 'client_admin');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The joined tag columns returned when listing a company's links.
const LINKED_TAG_SELECT = 'id, tag_id, created_at, tags(id, name, color)';

async function assertCompanyInTenant(tenantId: string, companyId: string) {
    const { data, error } = await supabaseAdmin
        .from('companies')
        .select('id')
        .eq('id', companyId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (error) throw new AppError('Failed to validate company', 500);
    if (!data) throw new AppError('Company not found', 404);
}

// ── Tenant tag catalogue ────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { data, error } = await supabaseAdmin
            .from('tags')
            .select('id, name, color, created_at, updated_at')
            .eq('tenant_id', req.tenantId!)
            .order('name', { ascending: true });

        if (error) {
            log.error({ err: error }, 'List tags failed');
            throw new AppError('Failed to fetch tags', 500);
        }
        res.json({ data: data || [] });
    } catch (err) {
        next(err);
    }
});

router.post('/', writeRoles, validateBody(createTagSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { data, error } = await supabaseAdmin
            .from('tags')
            .insert({ tenant_id: req.tenantId!, name: req.body.name, color: req.body.color })
            .select('id, name, color, created_at, updated_at')
            .single();

        if (error) {
            if (error.code === '23505') throw new AppError('A tag with this name already exists', 409);
            log.error({ err: error }, 'Create tag failed');
            throw new AppError('Failed to create tag', 500);
        }
        res.status(201).json({ data });
    } catch (err) {
        next(err);
    }
});

router.put('/:id', writeRoles, validateBody(updateTagSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid tag id', 400);
        const updates: Record<string, unknown> = {};
        if (req.body.name !== undefined) updates.name = req.body.name;
        if (req.body.color !== undefined) updates.color = req.body.color;

        const { data, error } = await supabaseAdmin
            .from('tags')
            .update(updates)
            .eq('id', req.params.id)
            .eq('tenant_id', req.tenantId!)
            .select('id, name, color, created_at, updated_at')
            .maybeSingle();

        if (error) {
            if (error.code === '23505') throw new AppError('A tag with this name already exists', 409);
            log.error({ err: error }, 'Update tag failed');
            throw new AppError('Failed to update tag', 500);
        }
        if (!data) throw new AppError('Tag not found', 404);
        res.json({ data });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', writeRoles, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid tag id', 400);
        // company_tags rows CASCADE with the tag (migration 139).
        const { data, error } = await supabaseAdmin
            .from('tags')
            .delete()
            .eq('id', req.params.id)
            .eq('tenant_id', req.tenantId!)
            .select('id')
            .maybeSingle();

        if (error) throw new AppError('Failed to delete tag', 500);
        if (!data) throw new AppError('Tag not found', 404);
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

// ── Company ⇄ tag links ─────────────────────────────────────────────────────

router.get('/companies/:companyId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.companyId as string)) throw new AppError('Invalid company id', 400);
        const tenantId = req.tenantId!;

        const { data, error } = await supabaseAdmin
            .from('company_tags')
            .select(LINKED_TAG_SELECT)
            .eq('tenant_id', tenantId)
            .eq('company_id', req.params.companyId)
            .order('created_at', { ascending: true });

        if (error) {
            log.error({ err: error }, 'List company tags failed');
            throw new AppError('Failed to fetch company tags', 500);
        }

        // Flatten { id, tag_id, tags: { name, color } } -> { id, tag_id, name, color }.
        const rows = (data || []).map((row) => {
            const tag = row.tags as { id?: string; name?: string; color?: string } | null;
            return {
                id: row.id,
                tag_id: row.tag_id,
                name: tag?.name || null,
                color: tag?.color || null,
                created_at: row.created_at,
            };
        });
        res.json({ data: rows });
    } catch (err) {
        next(err);
    }
});

router.post('/companies/:companyId', writeRoles, validateBody(linkCompanyTagSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.companyId as string)) throw new AppError('Invalid company id', 400);
        const tenantId = req.tenantId!;
        await assertCompanyInTenant(tenantId, req.params.companyId as string);

        // The tag must belong to this tenant (the DB fence enforces it too).
        const { data: tag, error: tagError } = await supabaseAdmin
            .from('tags')
            .select('id')
            .eq('id', req.body.tag_id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (tagError) throw new AppError('Failed to validate tag', 500);
        if (!tag) throw new AppError('Tag not found in this workspace', 422);

        const { data, error } = await supabaseAdmin
            .from('company_tags')
            .insert({
                tenant_id: tenantId,
                company_id: req.params.companyId,
                tag_id: req.body.tag_id,
                created_by: req.user!.id,
            })
            .select(LINKED_TAG_SELECT)
            .single();

        if (error) {
            if (error.code === '23505') throw new AppError('Tag is already linked to this company', 409);
            log.error({ err: error }, 'Link company tag failed');
            throw new AppError('Failed to link tag', 500);
        }

        const tagRow = data.tags as { name?: string; color?: string } | null;
        res.status(201).json({
            data: { id: data.id, tag_id: data.tag_id, name: tagRow?.name || null, color: tagRow?.color || null, created_at: data.created_at },
        });
    } catch (err) {
        next(err);
    }
});

router.delete('/companies/:companyId/:tagId', writeRoles, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.companyId as string)) throw new AppError('Invalid company id', 400);
        if (!UUID_RE.test(req.params.tagId as string)) throw new AppError('Invalid tag id', 400);

        const { data, error } = await supabaseAdmin
            .from('company_tags')
            .delete()
            .eq('tenant_id', req.tenantId!)
            .eq('company_id', req.params.companyId)
            .eq('tag_id', req.params.tagId)
            .select('id')
            .maybeSingle();

        if (error) throw new AppError('Failed to unlink tag', 500);
        if (!data) throw new AppError('Company tag link not found', 404);
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

export default router;
