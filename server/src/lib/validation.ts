import { z } from 'zod/v4';
import { Request, Response, NextFunction } from 'express';

/** Lenient UUID validator — accepts any 8-4-4-4-12 hex format (matches Postgres UUID type) */
export const uuidField = (message = 'Invalid UUID') =>
    z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, message);

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

/** Strip placeholder/junk email values (-, n/a, none, yok) to null */
export function sanitizeEmail(value: unknown): string | null {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || /^[-–—_.\/\\()\s]+$/.test(trimmed) || /^n\/?a$/i.test(trimmed) || /^none$/i.test(trimmed) || /^yok$/i.test(trimmed)) return null;
    return trimmed;
}

/** Email field that coerces empty/junk strings to null before validation */
const emailField = (maxLen = 255) =>
    z.preprocess(
        (val) => sanitizeEmail(val),
        z.string().email().max(maxLen).optional().nullable()
    );

// ── Auth schemas ──

export const loginSchema = z.object({
    email: z.string().email('Invalid email format').max(255),
    password: z.string().min(1, 'Password is required').max(128),
});

// ── Contact schemas ──

export const createContactSchema = z.object({
    company_id: uuidField('Invalid company_id'),
    first_name: z.string().min(1, 'First name is required').max(255),
    last_name: z.string().max(255).optional().nullable(),
    title: z.string().max(500).optional().nullable(),
    email: emailField(),
    phone_e164: z.string().max(30).optional().nullable(),
    linkedin: urlField(500),
    country: z.string().max(100).optional().nullable(),
    seniority: z.string().max(100).optional().nullable(),
    department: z.string().max(255).optional().nullable(),
    is_primary: z.boolean().optional().default(false),
});

export const updateContactSchema = z.object({
    company_id: uuidField('Invalid company_id').optional(),
    first_name: z.string().min(1).max(255).optional(),
    last_name: z.string().max(255).optional().nullable(),
    title: z.string().max(500).optional().nullable(),
    email: emailField(),
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
    company_email: emailField(),
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
    contact_email: emailField(),
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
    tenantId: uuidField().optional(),
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
    user_id: uuidField('Invalid user_id'),
    tenant_id: uuidField('Invalid tenant_id'),
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
// KASITLI AYRIŞMA: client/src/types/activity.ts 5 tip tanımlar (render için gerekli).
// Kullanıcı sadece aşağıdaki 3 tipi submit edebilir. DB CHECK constraint 5'e izin verir.
// 'sonlandirma_raporu' closing-report endpoint'i tarafından, 'status_change' aşama geçişlerinde üretilir.
export const ALLOWED_ACTIVITY_TYPES = ['not', 'meeting', 'follow_up'] as const;
export type ActivityType = typeof ALLOWED_ACTIVITY_TYPES[number];

// DB CHECK: visibility = ANY (ARRAY['internal', 'client'])
export const ALLOWED_VISIBILITY = ['internal', 'client'] as const;


export const createActivitySchema = z.object({
    company_id: uuidField('Invalid company_id'),
    contact_id: uuidField('Invalid contact_id').optional().nullable(),
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
    company_id: uuidField('Invalid company_id'),
    outcome: z.string().min(1, 'Outcome is required'),
    summary: z.string().min(1, 'Summary is required').max(1000).trim(),
    detail: z.string().max(5000).optional().nullable(),
    visibility: z.enum(ALLOWED_VISIBILITY).default('client'),
    occurred_at: z.string().datetime({ message: 'occurred_at must be a valid ISO datetime' }).optional(),
});

// ── Email Reply query filter schema ──

export const emailRepliesQuerySchema = z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    campaign_id: z.string().max(500).optional(),
    match_status: z.enum(['matched', 'unmatched']).optional(),
    read_status: z.enum(['unread', 'read']).optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    search: z.string().max(255).optional(),
    label: z.string().max(100).optional(),
    sentiment: z.string().max(50).optional(),
});

export const readStatusBodySchema = z.object({
    read_status: z.enum(['read', 'unread']),
});

// ── Email Reply webhook + assign schemas ──

// PlusVibe webhook payload — core fields validated, rest passed through to raw_payload
export const webhookPayloadSchema = z.object({
    from_email: z.string().email('Invalid from_email'),
    camp_id: z.string().max(500).optional().nullable(),
    campaign_name: z.string().max(500).optional().nullable(),
    text_body: z.string().optional().nullable(),
    replied_date: z.string().datetime({ offset: true, message: 'replied_date must be a valid ISO datetime' }).optional().nullable(),
    // Enrichment: stored on email_replies
    label: z.string().max(100).optional().nullable(),
    sentiment: z.string().max(50).optional().nullable(),
    subject: z.string().max(1000).optional().nullable(),
    lead_id: z.string().max(200).optional().nullable(),
    step: z.number().int().min(0).max(1000).optional().nullable(),
    // Enrichment: used for company/contact fill-blanks
    first_name: z.string().max(200).optional().nullable(),
    last_name: z.string().max(200).optional().nullable(),
    company_name: z.string().max(500).optional().nullable(),
    company_website: z.string().max(500).optional().nullable(),
    linkedin_company_url: z.string().max(500).optional().nullable(),
    linkedin_person_url: z.string().max(500).optional().nullable(),
    industry: z.string().max(200).optional().nullable(),
    job_title: z.string().max(200).optional().nullable(),
    department: z.string().max(200).optional().nullable(),
    phone_number: z.string().max(50).optional().nullable(),
    country: z.string().max(100).optional().nullable(),
    city: z.string().max(200).optional().nullable(),
    state: z.string().max(200).optional().nullable(),
    custom_company_size: z.string().max(100).optional().nullable(),
    custom_revenue: z.string().max(100).optional().nullable(),
}).passthrough();

export const assignReplySchema = z.object({
    company_id: uuidField('Invalid company_id'),
    contact_id: uuidField('Invalid contact_id').optional().nullable(),
});

// ── PlusVibe integration schemas ──

export const plusvibeCredentialSchema = z.object({
    api_key: z.string().min(1, 'API key is required').max(500),
    workspace_id: z.string().min(1, 'Workspace ID is required').max(500),
});

export const assignCampaignSchema = z.object({
    tenant_id: uuidField('Invalid tenant_id'),
});

export const campaignStatsQuerySchema = z.object({
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    campaign_id: z.string().max(500).optional(),
});

export const sendReplyBodySchema = z.object({
    body: z.string().min(1, 'Reply body is required').max(50000),
    attachmentIds: z.array(z.string().uuid()).max(3).optional(),
    cc: z.string().max(1000).optional().refine(
        (val) => !val || val.split(',').every((e) => e.trim().match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
        { message: 'Invalid CC email address' },
    ),
});

export const threadHistoryQuerySchema = z.object({
    sender_email: z.string().email('Invalid sender_email').max(255),
    campaign_id: z.string().max(500).optional(),
    exclude_id: uuidField('Invalid exclude_id').optional(),
});

// ── Campaign schemas ──────────────────────────────────────────────────────

export const createCampaignSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    from_name: z.string().max(100).optional(),
    settings: z.object({
        daily_limit: z.number().int().min(1).max(500).optional(),
        timezone: z.string().max(50).optional(),
    }).optional(),
});

export const updateCampaignSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    from_name: z.string().max(100).optional(),
    settings: z.object({
        daily_limit: z.number().int().min(1).max(500).optional(),
        timezone: z.string().max(50).optional(),
    }).optional(),
});

const emailStepSchema = z.object({
    step_type: z.literal('email'),
    subject: z.string().min(1).max(500),
    body_html: z.string().min(1).max(50000),
    body_text: z.string().max(50000).nullish(),
}).passthrough(); // allow extra fields (delay_days etc.) from client's unified Step type

const delayStepSchema = z.object({
    step_type: z.literal('delay'),
    delay_days: z.number().int().min(0).max(90),
    delay_hours: z.number().int().min(0).max(23),
}).passthrough().refine(
    (d) => d.delay_days > 0 || d.delay_hours > 0,
    { message: 'Delay must be at least 1 hour' },
);

const campaignStepSchema = z.discriminatedUnion('step_type', [emailStepSchema, delayStepSchema]);

export const saveStepsSchema = z.object({
    steps: z.array(campaignStepSchema).min(1).max(20),
});

export const enrollLeadsSchema = z.object({
    contacts: z.array(z.object({
        contact_id: uuidField(),
        company_id: uuidField(),
        email: z.string().email(),
    })).min(1).max(200),
});
