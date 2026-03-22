import { z } from 'zod/v4';
import { Request, Response, NextFunction } from 'express';

/** Express middleware that validates req.body against a Zod schema */
export function validateBody(schema: z.ZodType) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            res.status(400).json({ error: 'Validation failed', details: errors });
            return;
        }
        req.body = result.data;
        next();
    };
}

// ── Auth schemas ──

export const loginSchema = z.object({
    email: z.string().email('Invalid email format').max(255),
    password: z.string().min(1, 'Password is required').max(128),
});

// ── Contact schemas ──

export const createContactSchema = z.object({
    company_id: z.string().uuid('Invalid company_id'),
    first_name: z.string().min(1, 'First name is required').max(255),
    last_name: z.string().max(255).optional().nullable(),
    title: z.string().max(500).optional().nullable(),
    email: z.string().email().max(255).optional().nullable(),
    phone_e164: z.string().max(30).optional().nullable(),
    linkedin: z.string().max(500).optional().nullable(),
    country: z.string().max(100).optional().nullable(),
    seniority: z.string().max(100).optional().nullable(),
    department: z.string().max(255).optional().nullable(),
    is_primary: z.boolean().optional().default(false),
    notes: z.string().max(5000).optional().nullable(),
});

export const updateContactSchema = z.object({
    first_name: z.string().min(1).max(255).optional(),
    last_name: z.string().max(255).optional().nullable(),
    title: z.string().max(500).optional().nullable(),
    email: z.string().email().max(255).optional().nullable(),
    phone_e164: z.string().max(30).optional().nullable(),
    linkedin: z.string().max(500).optional().nullable(),
    country: z.string().max(100).optional().nullable(),
    seniority: z.string().max(100).optional().nullable(),
    department: z.string().max(255).optional().nullable(),
    is_primary: z.boolean().optional(),
});

export const contactNoteSchema = z.object({
    text: z.string().min(1, 'Note text is required').max(5000),
});

// ── Company schemas ──

export const createCompanySchema = z.object({
    name: z.string().min(1, 'Company name is required').max(500),
    website: z.string().max(500).optional().nullable(),
    email: z.string().email().max(255).optional().nullable(),
    phone: z.string().max(50).optional().nullable(),
    industry: z.string().max(255).optional().nullable(),
    location: z.string().max(500).optional().nullable(),
    stage: z.string().max(100).optional().nullable(),
    employee_count: z.number().int().min(0).optional().nullable(),
    product_services: z.string().max(2000).optional().nullable(),
    notes: z.string().max(10000).optional().nullable(),
    custom_fields: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const updateCompanySchema = createCompanySchema.partial();

// ── Admin schemas ──

export const VALID_ROLES = ['superadmin', 'ops_agent', 'client_admin', 'client_viewer'] as const;
export const VALID_TIERS = ['basic', 'pro'] as const;

export const createUserSchema = z.object({
    email: z.string().email('Invalid email format').max(255),
    password: z.string().min(8, 'Password must be at least 8 characters').max(128),
    tenantId: z.string().uuid().optional(),
    role: z.enum(VALID_ROLES).optional(),
}).refine(
    (data) => (!data.tenantId && !data.role) || (data.tenantId && data.role),
    { message: 'Both tenantId and role must be provided together, or neither' }
);

export const updateUserSchema = z.object({
    email: z.string().email().max(255).optional(),
    password: z.string().min(8).max(128).optional(),
}).refine((data) => data.email || data.password, {
    message: 'At least one field (email or password) must be provided',
});

export const createTenantSchema = z.object({
    name: z.string().min(1, 'Name is required').max(255),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Slug must be lowercase alphanumeric with hyphens, cannot start/end with hyphen'),
    tier: z.enum(VALID_TIERS).optional().default('basic'),
    is_active: z.boolean().optional().default(true),
});

export const updateTenantSchema = z.object({
    name: z.string().min(1).max(255).optional(),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/).optional(),
    tier: z.enum(VALID_TIERS).optional(),
    is_active: z.boolean().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
});

export const createMembershipSchema = z.object({
    user_id: z.string().uuid('Invalid user_id'),
    tenant_id: z.string().uuid('Invalid tenant_id'),
    role: z.enum(VALID_ROLES),
});

export const updateMembershipSchema = z.object({
    role: z.enum(VALID_ROLES).optional(),
    is_active: z.boolean().optional(),
}).refine((data) => data.role !== undefined || data.is_active !== undefined, {
    message: 'At least one field (role or is_active) must be provided',
});
