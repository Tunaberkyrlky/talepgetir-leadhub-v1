import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import {
    validateBody,
    savedViewCreateSchema,
    savedViewUpdateSchema,
    favoriteToggleSchema,
    recentVisitSchema,
    VIEW_ENTITY_TYPES,
} from '../lib/validation.js';

const router = Router();
const log = createLogger('route:views');
// Creating/editing/deleting SAVED VIEWS is a write action gated to write roles.
// Favorites and recents are personal and open to any authenticated member
// (viewers included) — they carry no requireRole guard.
const writeRoles = requireRole('superadmin', 'ops_agent', 'client_admin');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECENTS_CAP = 20;

// Resolve the requested entity_type from a query string, defaulting to 'companies'.
function resolveEntityType(raw: unknown): string {
    const v = typeof raw === 'string' ? raw : '';
    return (VIEW_ENTITY_TYPES as readonly string[]).includes(v) ? v : 'companies';
}

// Guard against cross-tenant favoriting/visiting: the referenced company must
// live in the caller's tenant. Only 'companies' is enrichable today.
async function assertEntityInTenant(tenantId: string, entityType: string, entityId: string): Promise<void> {
    if (entityType !== 'companies') return;
    const { data, error } = await supabaseAdmin
        .from('companies')
        .select('id')
        .eq('id', entityId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (error) throw new AppError('Failed to validate entity', 500);
    if (!data) throw new AppError('Company not found', 404);
}

// Attach display fields (name, stage) to a set of company entity rows. Rows whose
// company was since deleted keep entity_id but get null name/stage.
async function enrichCompanies<T extends { entity_id: string }>(
    tenantId: string,
    entityType: string,
    rows: T[],
): Promise<(T & { name: string | null; stage: string | null })[]> {
    if (entityType !== 'companies' || rows.length === 0) {
        return rows.map((r) => ({ ...r, name: null, stage: null }));
    }
    const ids = rows.map((r) => r.entity_id);
    const { data, error } = await supabaseAdmin
        .from('companies')
        .select('id, name, stage')
        .eq('tenant_id', tenantId)
        .in('id', ids);
    if (error) {
        log.error({ err: error }, 'Enrich favorites/recents companies failed');
        throw new AppError('Failed to load entities', 500);
    }
    const byId = new Map((data || []).map((c) => [c.id, c]));
    return rows.map((r) => {
        const c = byId.get(r.entity_id);
        return { ...r, name: c?.name ?? null, stage: c?.stage ?? null };
    });
}

// ─── Saved views ─────────────────────────────────────────────────────────────

// List the caller's own views plus any views SHARED within their tenant.
router.get('/saved', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const userId = req.user!.id;
        const entityType = resolveEntityType(req.query.entity_type);

        const { data, error } = await supabaseAdmin
            .from('saved_views')
            .select('id, name, entity_type, filters, columns, is_shared, user_id, created_at, updated_at')
            .eq('tenant_id', tenantId)
            .eq('entity_type', entityType)
            .or(`user_id.eq.${userId},is_shared.eq.true`)
            .order('name', { ascending: true });

        if (error) {
            log.error({ err: error }, 'List saved views failed');
            throw new AppError('Failed to fetch saved views', 500);
        }

        // Flag ownership so the client can show share/edit affordances only on own views.
        const mapped = (data || []).map((v) => ({ ...v, is_owner: v.user_id === userId }));
        res.json({ data: mapped });
    } catch (err) {
        next(err);
    }
});

router.post('/saved', writeRoles, validateBody(savedViewCreateSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { data, error } = await supabaseAdmin
            .from('saved_views')
            .insert({
                tenant_id: tenantId,
                user_id: req.user!.id,
                name: req.body.name,
                entity_type: req.body.entity_type,
                filters: req.body.filters,
                columns: req.body.columns,
                is_shared: req.body.is_shared,
            })
            .select('id, name, entity_type, filters, columns, is_shared, user_id, created_at, updated_at')
            .single();

        if (error) {
            log.error({ err: error }, 'Create saved view failed');
            throw new AppError('Failed to create saved view', 500);
        }
        res.status(201).json({ data: { ...data, is_owner: true } });
    } catch (err) {
        next(err);
    }
});

// Update — owner only. A shared view owned by someone else cannot be edited here.
router.put('/saved/:id', writeRoles, validateBody(savedViewUpdateSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid view id', 400);
        const tenantId = req.tenantId!;
        const userId = req.user!.id;

        const { data: existing, error: existingError } = await supabaseAdmin
            .from('saved_views')
            .select('id, user_id')
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (existingError) throw new AppError('Failed to fetch saved view', 500);
        if (!existing) throw new AppError('Saved view not found', 404);
        if (existing.user_id !== userId) throw new AppError('Only the owner can edit this view', 403);

        const update: Record<string, unknown> = {};
        if (req.body.name !== undefined) update.name = req.body.name;
        if (req.body.filters !== undefined) update.filters = req.body.filters;
        if (req.body.columns !== undefined) update.columns = req.body.columns;
        if (req.body.is_shared !== undefined) update.is_shared = req.body.is_shared;

        const { data, error } = await supabaseAdmin
            .from('saved_views')
            .update(update)
            .eq('id', req.params.id)
            .eq('tenant_id', tenantId)
            .eq('user_id', userId)
            .select('id, name, entity_type, filters, columns, is_shared, user_id, created_at, updated_at')
            .maybeSingle();

        if (error) {
            log.error({ err: error }, 'Update saved view failed');
            throw new AppError('Failed to update saved view', 500);
        }
        if (!data) throw new AppError('Saved view not found', 404);
        res.json({ data: { ...data, is_owner: true } });
    } catch (err) {
        next(err);
    }
});

router.delete('/saved/:id', writeRoles, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!UUID_RE.test(req.params.id as string)) throw new AppError('Invalid view id', 400);
        const { data, error } = await supabaseAdmin
            .from('saved_views')
            .delete()
            .eq('id', req.params.id)
            .eq('tenant_id', req.tenantId!)
            .eq('user_id', req.user!.id)
            .select('id')
            .maybeSingle();

        if (error) throw new AppError('Failed to delete saved view', 500);
        if (!data) throw new AppError('Saved view not found', 404);
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

// ─── Favorites (personal, any authenticated member) ──────────────────────────

router.get('/favorites', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const entityType = resolveEntityType(req.query.entity_type);

        const { data, error } = await supabaseAdmin
            .from('crm_favorites')
            .select('entity_id, created_at')
            .eq('tenant_id', tenantId)
            .eq('user_id', req.user!.id)
            .eq('entity_type', entityType)
            .order('created_at', { ascending: false });

        if (error) {
            log.error({ err: error }, 'List favorites failed');
            throw new AppError('Failed to fetch favorites', 500);
        }
        const enriched = await enrichCompanies(tenantId, entityType, data || []);
        res.json({ data: enriched });
    } catch (err) {
        next(err);
    }
});

// Toggle: insert if absent, delete if present. Returns the resulting state.
router.post('/favorites/toggle', validateBody(favoriteToggleSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const userId = req.user!.id;
        const { entity_type: entityType, entity_id: entityId } = req.body;
        await assertEntityInTenant(tenantId, entityType, entityId);

        const { data: existing, error: existingError } = await supabaseAdmin
            .from('crm_favorites')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('user_id', userId)
            .eq('entity_type', entityType)
            .eq('entity_id', entityId)
            .maybeSingle();
        if (existingError) throw new AppError('Failed to read favorite', 500);

        if (existing) {
            const { error } = await supabaseAdmin.from('crm_favorites').delete().eq('id', existing.id);
            if (error) throw new AppError('Failed to remove favorite', 500);
            res.json({ data: { favorited: false } });
            return;
        }

        const { error } = await supabaseAdmin.from('crm_favorites').insert({
            tenant_id: tenantId,
            user_id: userId,
            entity_type: entityType,
            entity_id: entityId,
        });
        // A concurrent toggle may have inserted the same row (unique violation) — treat as favorited.
        if (error && error.code !== '23505') {
            log.error({ err: error }, 'Add favorite failed');
            throw new AppError('Failed to add favorite', 500);
        }
        res.json({ data: { favorited: true } });
    } catch (err) {
        next(err);
    }
});

// ─── Recents (personal, capped to the last N per user) ───────────────────────

router.get('/recents', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const entityType = resolveEntityType(req.query.entity_type);

        const { data, error } = await supabaseAdmin
            .from('crm_recents')
            .select('entity_id, last_visited_at')
            .eq('tenant_id', tenantId)
            .eq('user_id', req.user!.id)
            .eq('entity_type', entityType)
            .order('last_visited_at', { ascending: false })
            .limit(RECENTS_CAP);

        if (error) {
            log.error({ err: error }, 'List recents failed');
            throw new AppError('Failed to fetch recents', 500);
        }
        const enriched = await enrichCompanies(tenantId, entityType, data || []);
        res.json({ data: enriched });
    } catch (err) {
        next(err);
    }
});

// Record a visit (upsert last_visited_at), then trim to the most recent N rows.
router.post('/recents', validateBody(recentVisitSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const userId = req.user!.id;
        const { entity_type: entityType, entity_id: entityId } = req.body;
        await assertEntityInTenant(tenantId, entityType, entityId);

        // Preferred path: one advisory-locked RPC does upsert + trim atomically, so
        // two concurrent visits can't race the cap open (migration 138). If the
        // function isn't present yet (migration not applied on this env), fall back
        // to the legacy two-step path below.
        const { error: rpcError } = await supabaseAdmin.rpc('crm_recents_record', {
            p_tenant_id: tenantId,
            p_user_id: userId,
            p_entity_type: entityType,
            p_entity_id: entityId,
            p_cap: RECENTS_CAP,
        });
        if (!rpcError) {
            res.status(204).send();
            return;
        }
        // PGRST202 = function not found in schema cache; 42883 = undefined_function.
        const rpcMissing = rpcError.code === 'PGRST202' || rpcError.code === '42883';
        if (!rpcMissing) {
            log.error({ err: rpcError }, 'crm_recents_record RPC failed');
            throw new AppError('Failed to record visit', 500);
        }
        log.warn({ err: rpcError }, 'crm_recents_record RPC missing — using two-step fallback');

        const { error: upsertError } = await supabaseAdmin
            .from('crm_recents')
            .upsert({
                tenant_id: tenantId,
                user_id: userId,
                entity_type: entityType,
                entity_id: entityId,
                last_visited_at: new Date().toISOString(),
            }, { onConflict: 'tenant_id,user_id,entity_type,entity_id' });
        if (upsertError) {
            log.error({ err: upsertError }, 'Upsert recent failed');
            throw new AppError('Failed to record visit', 500);
        }

        // Trim: keep the most recent RECENTS_CAP, delete the overflow.
        const { data: all, error: listError } = await supabaseAdmin
            .from('crm_recents')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('user_id', userId)
            .eq('entity_type', entityType)
            .order('last_visited_at', { ascending: false });
        if (listError) throw new AppError('Failed to trim recents', 500);
        const overflow = (all || []).slice(RECENTS_CAP).map((r) => r.id);
        if (overflow.length > 0) {
            const { error: delError } = await supabaseAdmin.from('crm_recents').delete().in('id', overflow);
            if (delError) log.warn({ err: delError }, 'Failed to trim recents overflow');
        }
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

export default router;
