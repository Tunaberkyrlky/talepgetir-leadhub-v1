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

/**
 * Ensures a URL string uses http: or https: only.
 * Rejects javascript:, data:, and other dangerous schemes.
 */
function safeHttpUrl(url: string): boolean {
    try {
        const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

const urlField = (maxLen = 500) =>
    z.preprocess(
        // Coerce empty strings (cleared form fields) to null
        (val) => (val === '' ? null : val),
        z.string()
            .max(maxLen)
            .refine(safeHttpUrl, { message: 'Must be a valid http/https URL' })
            .optional()
            .nullable()
    );

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
    linkedin: urlField(500),
    country: z.string().max(100).optional().nullable(),
    seniority: z.string().max(100).optional().nullable(),
    department: z.string().max(255).optional().nullable(),
    is_primary: z.boolean().optional().default(false),
});

export const updateContactSchema = z.object({
    first_name: z.string().min(1).max(255).optional(),
    last_name: z.string().max(255).optional().nullable(),
    title: z.string().max(500).optional().nullable(),
    email: z.string().email().max(255).optional().nullable(),
    phone_e164: z.string().max(30).optional().nullable(),
    linkedin: urlField(500),
    country: z.string().max(100).optional().nullable(),
    seniority: z.string().max(100).optional().nullable(),
    department: z.string().max(255).optional().nullable(),
    is_primary: z.boolean().optional(),
});

// ── Company schemas ──

export const createCompanySchema = z.object({
    name: z.string().min(1, 'Company name is required').max(500),
    website: urlField(500),
    linkedin: urlField(500),
    company_phone: z.string().max(50).optional().nullable(),
    company_email: z.string().email().max(255).optional().nullable(),
    email_status: z.enum(['valid', 'uncertain', 'invalid']).optional().nullable(),
    location: z.string().max(500).optional().nullable(),
    industry: z.string().max(255).optional().nullable(),
    employee_size: z.string().max(100).optional().nullable(),
    stage: z.string().max(100).optional().nullable(),
    company_summary: z.string().max(5000).optional().nullable(),
    internal_notes: z.string().max(10000).optional().nullable(),
    next_step: z.string().max(2000).optional().nullable(),
    product_services: z.string().max(5000).optional().nullable(),
    product_portfolio: z.string().max(5000).optional().nullable(),
    fit_score: z.string().max(50).optional().nullable(),
    custom_field_1: z.string().max(2000).optional().nullable(),
    custom_field_2: z.string().max(2000).optional().nullable(),
    custom_field_3: z.string().max(2000).optional().nullable(),
    custom_fields: z.record(z.string(), z.unknown()).optional().nullable(),
    // Inline contact creation (used when creating company + contact in one call)
    contact_first_name: z.string().max(255).optional().nullable(),
    contact_last_name: z.string().max(255).optional().nullable(),
    contact_title: z.string().max(500).optional().nullable(),
    contact_email: z.string().email().max(255).optional().nullable(),
    contact_phone_e164: z.string().max(30).optional().nullable(),
});

export const updateCompanySchema = createCompanySchema
    .omit({ contact_first_name: true, contact_last_name: true, contact_title: true, contact_email: true, contact_phone_e164: true })
    .partial();


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

// ── Activity schemas ──

// DB CHECK: type = ANY (ARRAY['not', 'meeting', 'follow_up', 'sonlandirma_raporu', 'status_change'])
// 'not' and 'sonlandirma_raporu' / 'status_change' are system-generated; users may only submit these three:
export const ALLOWED_ACTIVITY_TYPES = ['not', 'meeting', 'follow_up'] as const;
export type ActivityType = typeof ALLOWED_ACTIVITY_TYPES[number];

// DB CHECK: visibility = ANY (ARRAY['internal', 'client'])
export const ALLOWED_VISIBILITY = ['internal', 'client'] as const;

// DB CHECK: stage / outcome = ANY (ARRAY['won', 'lost', 'on_hold', 'cancelled'])
export const TERMINAL_STAGES = ['won', 'lost', 'on_hold', 'cancelled'] as const;
export type TerminalStage = typeof TERMINAL_STAGES[number];

export const createActivitySchema = z.object({
    company_id: z.string().uuid('Invalid company_id'),
    contact_id: z.string().uuid('Invalid contact_id').optional().nullable(),
    type: z.enum(ALLOWED_ACTIVITY_TYPES),
    summary: z.string().min(1, 'Summary is required').max(1000).trim(),
    detail: z.string().max(5000).optional().nullable(),
    outcome: z.string().max(100).optional().nullable(),
    visibility: z.enum(ALLOWED_VISIBILITY).default('client'),
    occurred_at: z.string().datetime({ message: 'occurred_at must be a valid ISO datetime' }).optional(),
});

export const updateActivitySchema = z.object({
    summary: z.string().min(1).max(1000).trim().optional(),
    detail: z.string().max(5000).optional().nullable(),
    outcome: z.string().max(100).optional().nullable(),
    visibility: z.enum(ALLOWED_VISIBILITY).optional(),
    occurred_at: z.string().datetime({ message: 'occurred_at must be a valid ISO datetime' }).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' });

export const closingReportSchema = z.object({
    company_id: z.string().uuid('Invalid company_id'),
    outcome: z.enum(TERMINAL_STAGES, { message: `Must be one of: ${TERMINAL_STAGES.join(', ')}` }),
    summary: z.string().min(1, 'Summary is required').max(1000).trim(),
    detail: z.string().max(5000).optional().nullable(),
    visibility: z.enum(ALLOWED_VISIBILITY).default('client'),
    occurred_at: z.string().datetime({ message: 'occurred_at must be a valid ISO datetime' }).optional(),
});
