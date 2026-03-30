import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { clearAuthCacheForUser } from '../middleware/auth.js';
import {
    validateBody,
    createUserSchema, updateUserSchema,
    createTenantSchema, updateTenantSchema,
    createMembershipSchema, updateMembershipSchema,
    VALID_ROLES, VALID_TIERS,
} from '../lib/validation.js';

const log = createLogger('route:admin');
const router = Router();

export async function logAuditAction(
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    details?: object
) {
    try {
        await supabaseAdmin.from('admin_audit_log').insert({
            actor_id: actorId,
            action,
            target_type: targetType,
            target_id: targetId,
            details: details || {},
        });
    } catch (err) {
        log.error({ err }, 'Failed to write audit log');
    }
}

// =====================
// USERS ENDPOINTS
// =====================

// GET /api/admin/users — List all users with their memberships
router.get('/users', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
        const search = (req.query.search as string || '').trim().toLowerCase();
        const roleFilter = req.query.role as string || '';

        // Fetch users from Supabase Auth (single page, capped at 1000)
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.listUsers({
            page: 1,
            perPage: 1000,
        });
        if (authError) {
            log.error({ err: authError }, 'Failed to list users');
            throw new AppError('Failed to fetch users', 500);
        }
        const allUsers = authData.users || [];
        if (allUsers.length >= 1000) {
            log.warn('User listing capped at 1000 — some users may be missing');
        }

        // Fetch all memberships for fetched users
        const userIds = allUsers.map(u => u.id);
        const { data: memberships } = await supabaseAdmin
            .from('memberships')
            .select('id, user_id, tenant_id, role, is_active, tenants(id, name, slug, tier)')
            .in('user_id', userIds.length > 0 ? userIds : ['__none__']);

        // Build membership map
        const membershipMap = new Map<string, any[]>();
        for (const m of memberships || []) {
            const list = membershipMap.get(m.user_id) || [];
            list.push({
                id: m.id,
                tenant_id: m.tenant_id,
                tenant_name: (m as any).tenants?.name || '',
                tenant_slug: (m as any).tenants?.slug || '',
                tenant_tier: (m as any).tenants?.tier || 'basic',
                role: m.role,
                is_active: m.is_active,
            });
            membershipMap.set(m.user_id, list);
        }

        // Enrich users
        let enrichedUsers = allUsers.map(u => ({
            id: u.id,
            email: u.email || '',
            created_at: u.created_at,
            last_sign_in_at: u.last_sign_in_at,
            memberships: membershipMap.get(u.id) || [],
        }));

        // Apply search filter
        if (search) {
            enrichedUsers = enrichedUsers.filter(u =>
                u.email.toLowerCase().includes(search)
            );
        }

        // Apply role filter
        if (roleFilter && VALID_ROLES.includes(roleFilter as any)) {
            enrichedUsers = enrichedUsers.filter(u =>
                u.memberships.some((m: any) => m.role === roleFilter)
            );
        }

        // Paginate filtered results
        const total = enrichedUsers.length;
        const totalPages = Math.ceil(total / limit);
        const paged = enrichedUsers.slice((page - 1) * limit, page * limit);

        res.json({
            data: paged,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'List users error');
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// GET /api/admin/users/:id — Single user detail
router.get('/users/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const id = req.params.id as string;

        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.getUserById(id);

        if (authError || !authData.user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        const user = authData.user;

        const { data: memberships } = await supabaseAdmin
            .from('memberships')
            .select('id, user_id, tenant_id, role, is_active, tenants(id, name, slug, tier)')
            .eq('user_id', id);

        res.json({
            data: {
                id: user.id,
                email: user.email || '',
                created_at: user.created_at,
                last_sign_in_at: user.last_sign_in_at,
                memberships: (memberships || []).map(m => ({
                    id: m.id,
                    tenant_id: m.tenant_id,
                    tenant_name: (m as any).tenants?.name || '',
                    tenant_slug: (m as any).tenants?.slug || '',
                    tenant_tier: (m as any).tenants?.tier || 'basic',
                    role: m.role,
                    is_active: m.is_active,
                })),
            },
        });
    } catch (err) {
        log.error({ err }, 'Get user error');
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// POST /api/admin/users — Create new user
router.post('/users', validateBody(createUserSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { email, password, tenantId, role } = req.body;

        // Create user in Supabase Auth
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
        });

        if (authError) {
            log.error({ err: authError }, 'Create user auth error');
            if (authError.message?.includes('already')) {
                res.status(409).json({ error: 'A user with this email already exists' });
                return;
            }
            throw new AppError('Failed to create user', 500);
        }

        const newUser = authData.user;
        let membership = null;

        // If tenant and role provided, create membership
        if (tenantId && role) {
            const { data: tenantExists } = await supabaseAdmin
                .from('tenants')
                .select('id')
                .eq('id', tenantId)
                .single();

            if (!tenantExists) {
                res.status(400).json({ error: 'Tenant not found' });
                return;
            }

            const { data: membershipData, error: membershipError } = await supabaseAdmin
                .from('memberships')
                .insert({
                    user_id: newUser.id,
                    tenant_id: tenantId,
                    role,
                    is_active: true,
                })
                .select()
                .single();

            if (membershipError) {
                log.error({ err: membershipError }, 'Create membership error');
            } else {
                membership = membershipData;
            }

            // Set app_metadata.tenant_id
            await supabaseAdmin.auth.admin.updateUserById(newUser.id, {
                app_metadata: { tenant_id: tenantId },
            });
        }

        await logAuditAction(req.user!.id, 'user.create', 'user', newUser.id, { email, tenantId, role });

        res.status(201).json({
            data: {
                id: newUser.id,
                email: newUser.email,
                created_at: newUser.created_at,
                membership,
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Create user error');
        res.status(500).json({ error: 'Failed to create user' });
    }
});

// PUT /api/admin/users/:id — Update user
router.put('/users/:id', validateBody(updateUserSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const id = req.params.id as string;
        const { email, password } = req.body;

        const updateData: Record<string, unknown> = {};
        if (email) updateData.email = email;
        if (password) updateData.password = password;

        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.updateUserById(id, updateData);

        if (authError) {
            log.error({ err: authError }, 'Update user error');
            throw new AppError('Failed to update user', 500);
        }

        await logAuditAction(req.user!.id, 'user.update', 'user', id, { email: !!email, passwordChanged: !!password });

        res.json({
            data: {
                id: authData.user.id,
                email: authData.user.email,
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Update user error');
        res.status(500).json({ error: 'Failed to update user' });
    }
});

// DELETE /api/admin/users/:id — Deactivate or delete user
router.delete('/users/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const id = req.params.id as string;
        const hard = req.query.hard === 'true';

        if (id === req.user!.id) {
            res.status(400).json({ error: 'Cannot delete yourself' });
            return;
        }

        if (hard) {
            const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
            if (error) {
                log.error({ err: error }, 'Delete user error');
                throw new AppError('Failed to delete user', 500);
            }
            clearAuthCacheForUser(id);
            await logAuditAction(req.user!.id, 'user.hard_delete', 'user', id);
        } else {
            // Soft delete: deactivate all memberships
            const { error } = await supabaseAdmin
                .from('memberships')
                .update({ is_active: false })
                .eq('user_id', id);

            if (error) {
                log.error({ err: error }, 'Deactivate memberships error');
                throw new AppError('Failed to deactivate user', 500);
            }
            clearAuthCacheForUser(id);
            await logAuditAction(req.user!.id, 'user.deactivate', 'user', id);
        }

        res.status(204).send();
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Delete user error');
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// =====================
// TENANTS ENDPOINTS
// =====================

// GET /api/admin/tenants — List all tenants
router.get('/tenants', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
        const offset = (page - 1) * limit;
        const search = (req.query.search as string || '').trim();
        const tierFilter = req.query.tier as string || '';
        const activeFilter = req.query.is_active as string;

        // Count query
        let countQuery = supabaseAdmin
            .from('tenants')
            .select('*', { count: 'exact', head: true });

        // Data query
        let dataQuery = supabaseAdmin
            .from('tenants')
            .select('id, name, slug, tier, is_active, settings, created_at, updated_at, memberships(count)');

        // Apply search
        if (search) {
            const pattern = `%${search}%`;
            countQuery = countQuery.ilike('name', pattern);
            dataQuery = dataQuery.ilike('name', pattern);
        }

        // Apply tier filter
        if (tierFilter && VALID_TIERS.includes(tierFilter as any)) {
            countQuery = countQuery.eq('tier', tierFilter);
            dataQuery = dataQuery.eq('tier', tierFilter);
        }

        // Apply active filter
        if (activeFilter === 'true' || activeFilter === 'false') {
            const isActive = activeFilter === 'true';
            countQuery = countQuery.eq('is_active', isActive);
            dataQuery = dataQuery.eq('is_active', isActive);
        }

        const { count, error: countError } = await countQuery;
        if (countError) throw new AppError('Failed to count tenants', 500);

        const { data, error } = await dataQuery
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw new AppError('Failed to fetch tenants', 500);

        const totalPages = Math.ceil((count || 0) / limit);

        const tenants = (data || []).map((t: any) => ({
            ...t,
            member_count: (t.memberships?.[0]?.count ?? 0) as number,
            memberships: undefined,
        }));

        res.json({
            data: tenants,
            pagination: {
                page,
                limit,
                total: count || 0,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'List tenants error');
        res.status(500).json({ error: 'Failed to fetch tenants' });
    }
});

// GET /api/admin/tenants/:id — Single tenant with members
router.get('/tenants/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const id = req.params.id as string;

        const { data: tenant, error } = await supabaseAdmin
            .from('tenants')
            .select('*')
            .eq('id', id)
            .single();

        if (error || !tenant) {
            res.status(404).json({ error: 'Tenant not found' });
            return;
        }

        // Fetch memberships
        const { data: memberships } = await supabaseAdmin
            .from('memberships')
            .select('id, user_id, role, is_active')
            .eq('tenant_id', id);

        // Enrich with user emails — batch fetch in parallel
        const members = await Promise.all(
            (memberships || []).map(async (m) => {
                const { data: userData } = await supabaseAdmin.auth.admin.getUserById(m.user_id);
                return {
                    membership_id: m.id,
                    user_id: m.user_id,
                    email: userData?.user?.email || '',
                    role: m.role,
                    is_active: m.is_active,
                };
            })
        );

        res.json({
            data: { ...tenant, members },
        });
    } catch (err) {
        log.error({ err }, 'Get tenant error');
        res.status(500).json({ error: 'Failed to fetch tenant' });
    }
});

// POST /api/admin/tenants — Create tenant
router.post('/tenants', validateBody(createTenantSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { name, slug, tier, is_active } = req.body;

        // Check slug uniqueness
        const { data: existing } = await supabaseAdmin
            .from('tenants')
            .select('id')
            .eq('slug', slug)
            .single();

        if (existing) {
            res.status(409).json({ error: 'A workspace with this identifier already exists' });
            return;
        }

        const { data, error } = await supabaseAdmin
            .from('tenants')
            .insert({
                name: name.trim(),
                slug,
                tier: tier || 'basic',
                is_active: is_active !== false,
                settings: {},
            })
            .select()
            .single();

        if (error) {
            log.error({ err: error }, 'Create tenant error');
            throw new AppError('Failed to create tenant', 500);
        }

        // Seed default pipeline stages for new tenant
        const { ensureDefaultStages } = await import('./settings.js');
        await ensureDefaultStages(data.id);

        await logAuditAction(req.user!.id, 'tenant.create', 'tenant', data.id, { name, slug, tier });

        res.status(201).json({ data });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Create tenant error');
        res.status(500).json({ error: 'Failed to create tenant' });
    }
});

// PUT /api/admin/tenants/:id — Update tenant
router.put('/tenants/:id', validateBody(updateTenantSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const id = req.params.id as string;
        const { name, slug, tier, is_active, settings } = req.body;

        const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (name !== undefined) updateData.name = name.trim();
        if (slug !== undefined) updateData.slug = slug;
        if (tier !== undefined) updateData.tier = tier;
        if (is_active !== undefined) updateData.is_active = is_active;
        if (settings !== undefined) updateData.settings = settings;

        const { data, error } = await supabaseAdmin
            .from('tenants')
            .update(updateData)
            .eq('id', id)
            .select()
            .single();

        if (error) {
            log.error({ err: error }, 'Update tenant error');
            throw new AppError('Failed to update tenant', 500);
        }

        await logAuditAction(req.user!.id, 'tenant.update', 'tenant', id, updateData);

        res.json({ data });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Update tenant error');
        res.status(500).json({ error: 'Failed to update tenant' });
    }
});

// DELETE /api/admin/tenants/:id — Delete tenant
router.delete('/tenants/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const id = req.params.id as string;

        if (req.query.confirm !== 'true') {
            res.status(400).json({ error: 'Please confirm the deletion to proceed' });
            return;
        }

        // Before deleting the tenant, find all users whose app_metadata.tenant_id
        // points to this tenant — they would get 403 on every request after deletion.
        // Clear their tenant pointer and evict them from the auth cache.
        const { data: memberships } = await supabaseAdmin
            .from('memberships')
            .select('user_id')
            .eq('tenant_id', id);

        if (memberships && memberships.length > 0) {
            await Promise.all(
                memberships.map(async ({ user_id }) => {
                    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(user_id);
                    if (userData?.user?.app_metadata?.tenant_id === id) {
                        await supabaseAdmin.auth.admin.updateUserById(user_id, {
                            app_metadata: { tenant_id: null },
                        });
                    }
                    clearAuthCacheForUser(user_id);
                })
            );
        }

        const { error } = await supabaseAdmin
            .from('tenants')
            .delete()
            .eq('id', id);

        if (error) {
            log.error({ err: error }, 'Delete tenant error');
            throw new AppError('Failed to delete tenant', 500);
        }

        await logAuditAction(req.user!.id, 'tenant.delete', 'tenant', id);

        res.status(204).send();
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Delete tenant error');
        res.status(500).json({ error: 'Failed to delete tenant' });
    }
});

// =====================
// MEMBERSHIPS ENDPOINTS
// =====================

// GET /api/admin/memberships — List memberships
router.get('/memberships', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
        const offset = (page - 1) * limit;
        const tenantFilter = req.query.tenant_id as string || '';
        const roleFilter = req.query.role as string || '';
        const activeFilter = req.query.is_active as string;

        let countQuery = supabaseAdmin
            .from('memberships')
            .select('*', { count: 'exact', head: true });

        let dataQuery = supabaseAdmin
            .from('memberships')
            .select('id, user_id, tenant_id, role, is_active, created_at, tenants(id, name, slug, tier)');

        if (tenantFilter) {
            countQuery = countQuery.eq('tenant_id', tenantFilter);
            dataQuery = dataQuery.eq('tenant_id', tenantFilter);
        }
        if (roleFilter && VALID_ROLES.includes(roleFilter as any)) {
            countQuery = countQuery.eq('role', roleFilter);
            dataQuery = dataQuery.eq('role', roleFilter);
        }
        if (activeFilter === 'true' || activeFilter === 'false') {
            const isActive = activeFilter === 'true';
            countQuery = countQuery.eq('is_active', isActive);
            dataQuery = dataQuery.eq('is_active', isActive);
        }

        const { count, error: countError } = await countQuery;
        if (countError) throw new AppError('Failed to count memberships', 500);

        const { data, error } = await dataQuery
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw new AppError('Failed to fetch memberships', 500);

        // Enrich with user emails — batch fetch in parallel
        const enriched = await Promise.all(
            (data || []).map(async (m) => {
                const { data: userData } = await supabaseAdmin.auth.admin.getUserById(m.user_id);
                return {
                    id: m.id,
                    user_id: m.user_id,
                    user_email: userData?.user?.email || '',
                    tenant_id: m.tenant_id,
                    tenant_name: (m as any).tenants?.name || '',
                    tenant_slug: (m as any).tenants?.slug || '',
                    role: m.role,
                    is_active: m.is_active,
                    created_at: m.created_at,
                };
            })
        );

        const totalPages = Math.ceil((count || 0) / limit);

        res.json({
            data: enriched,
            pagination: {
                page,
                limit,
                total: count || 0,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'List memberships error');
        res.status(500).json({ error: 'Failed to fetch memberships' });
    }
});

// POST /api/admin/memberships — Assign user to tenant
router.post('/memberships', validateBody(createMembershipSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { user_id, tenant_id, role } = req.body;

        // Verify user exists
        const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(user_id);
        if (userError || !userData.user) {
            res.status(400).json({ error: 'User not found' });
            return;
        }

        // Verify tenant exists
        const { data: tenantExists } = await supabaseAdmin
            .from('tenants')
            .select('id')
            .eq('id', tenant_id)
            .single();

        if (!tenantExists) {
            res.status(400).json({ error: 'Tenant not found' });
            return;
        }

        const { data, error } = await supabaseAdmin
            .from('memberships')
            .insert({
                user_id,
                tenant_id,
                role,
                is_active: true,
            })
            .select()
            .single();

        if (error) {
            if (error.code === '23505') {
                res.status(409).json({ error: 'This user is already a member of this workspace' });
                return;
            }
            log.error({ err: error }, 'Create membership error');
            throw new AppError('Failed to create membership', 500);
        }

        // If user has no app_metadata.tenant_id, set it
        if (!userData.user.app_metadata?.tenant_id) {
            await supabaseAdmin.auth.admin.updateUserById(user_id, {
                app_metadata: { tenant_id },
            });
        }

        await logAuditAction(req.user!.id, 'membership.create', 'membership', data.id, { user_id, tenant_id, role });

        res.status(201).json({ data });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Create membership error');
        res.status(500).json({ error: 'Failed to create membership' });
    }
});

// PUT /api/admin/memberships/:id — Update membership
router.put('/memberships/:id', validateBody(updateMembershipSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const id = req.params.id as string;
        const { role, is_active } = req.body;

        const updateData: Record<string, unknown> = {};
        if (role !== undefined) updateData.role = role;
        if (is_active !== undefined) updateData.is_active = is_active;

        const { data, error } = await supabaseAdmin
            .from('memberships')
            .update(updateData)
            .eq('id', id)
            .select()
            .single();

        if (error) {
            log.error({ err: error }, 'Update membership error');
            throw new AppError('Failed to update membership', 500);
        }

        await logAuditAction(req.user!.id, 'membership.update', 'membership', id, updateData);

        res.json({ data });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Update membership error');
        res.status(500).json({ error: 'Failed to update membership' });
    }
});

// DELETE /api/admin/memberships/:id — Remove membership
router.delete('/memberships/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const id = req.params.id as string;

        const { error } = await supabaseAdmin
            .from('memberships')
            .delete()
            .eq('id', id);

        if (error) {
            log.error({ err: error }, 'Delete membership error');
            throw new AppError('Failed to delete membership', 500);
        }

        await logAuditAction(req.user!.id, 'membership.delete', 'membership', id);

        res.status(204).send();
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Delete membership error');
        res.status(500).json({ error: 'Failed to delete membership' });
    }
});

export default router;
