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
    // Stored as text[]. Accept a list from the UI, or a raw string (legacy / API)
    // that the route normalizes via parseList() into a clean array.
    product_services: z.union([z.array(z.string().max(500)).max(100), z.string().max(5000)]).optional().nullable(),
    product_portfolio: z.union([z.array(z.string().max(500)).max(100), z.string().max(5000)]).optional().nullable(),
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
    settings: z.object({
        cc_addresses: z.array(z.object({ email: z.string().max(255), label: z.string().max(100) })).max(50).optional(),
        custom_field_1_label: z.string().max(100).optional(),
        custom_field_2_label: z.string().max(100).optional(),
        custom_field_3_label: z.string().max(100).optional(),
        daily_digest_enabled: z.boolean().optional(),
        digest_days: z.array(z.number().int().min(0).max(6)).max(7).optional(), // 0=Pazar … 6=Cumartesi; varsayılan [1,4]
        digest_hour: z.number().int().min(0).max(23).optional(), // gönderim saati (TR), varsayılan 8
    }).passthrough().optional(),
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

// Optional parseable date string (shared by reply-list + tracking-stats filters).
const optionalDate = z.string().refine(v => !v || !isNaN(Date.parse(v)), { message: 'Invalid date format' }).optional();

export const emailRepliesQuerySchema = z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    campaign_id: z.string().max(500).optional(),
    match_status: z.enum(['matched', 'unmatched']).optional(),
    read_status: z.enum(['unread', 'read']).optional(),
    date_from: optionalDate,
    date_to: optionalDate,
    search: z.string().max(255).optional(),
    label: z.string().max(100).optional(),
    sentiment: z.string().max(50).optional(),
    awaiting: z.literal('true').optional(),
});

export const readStatusBodySchema = z.object({
    read_status: z.enum(['read', 'unread']),
});

export const trackingStatsQuerySchema = z.object({
    date_from: optionalDate,
    date_to: optionalDate,
});

// ── Email Reply webhook + assign schemas ──

// PlusVibe webhook payload — core fields validated, rest passed through to raw_payload
export const webhookPayloadSchema = z.object({
    // Only reply events (ALL_EMAIL_REPLIES) carry from_email. Other delivery events
    // (EMAIL_SENT/OPENED/CLICKED…) hit the same URL without it, so this is optional;
    // the handler acks & skips any event lacking from_email.
    from_email: z.string().email('Invalid from_email').optional().nullable(),
    webhook_event: z.string().max(100).optional().nullable(),
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

// Prefix rule: a campaign-name prefix mapped to a tenant. Assignment is fully
// prefix-driven (no per-campaign manual assign).
export const prefixRuleSchema = z.object({
    tenant_id: uuidField('Invalid tenant_id'),
    prefix: z.string().trim()
        .min(1, 'Prefix required')
        .max(50, 'Prefix too long')
        .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/, 'Prefix must start alphanumeric (letters, digits, space . _ - allowed)'),
});

export const campaignStatsQuerySchema = z.object({
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    campaign_id: z.string().max(500).optional(),
});

export const sendReplyBodySchema = z.object({
    body: z.string().min(1, 'Reply body is required').max(50000),
    attachmentIds: z.array(z.string().uuid()).max(10).optional(),
    cc: z.string().max(1000).optional().refine(
        (val) => !val || val.split(',').every((e) => e.trim().match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
        { message: 'Invalid CC email address' },
    ),
});

export const forwardEmailBodySchema = z.object({
    to: z.string().email('Invalid recipient email').max(255),
    note: z.string().min(1, 'Note is required').max(50000),
    attachmentIds: z.array(z.string().uuid()).max(10).optional(),
    cc: z.string().max(1000).optional().refine(
        (val) => !val || val.split(',').every((e) => e.trim().match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
        { message: 'Invalid CC email address' },
    ),
});

export const composeEmailBodySchema = z.object({
    to: z.string().email('Invalid recipient email').max(255),
    subject: z.string().min(1, 'Subject is required').max(500),
    body: z.string().min(1, 'Body is required').max(50000),
    attachmentIds: z.array(z.string().uuid()).max(10).optional(),
    cc: z.string().max(1000).optional().refine(
        (val) => !val || val.split(',').every((e) => e.trim().match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
        { message: 'Invalid CC email address' },
    ),
    accountEmail: z.string().email('Invalid sender email').max(255).optional(),
    companyId: uuidField('Invalid company_id').optional().nullable(),
    contactId: uuidField('Invalid contact_id').optional().nullable(),
});

export const threadHistoryQuerySchema = z.object({
    sender_email: z.string().email('Invalid sender_email').max(255),
    campaign_id: z.string().max(500).optional(),
    exclude_id: uuidField('Invalid exclude_id').optional(),
});

export const smtpConnectionSchema = z.object({
    email_address: z.string().email('Invalid email address').max(255),
    smtp_host: z.string().min(1, 'SMTP host required').max(255),
    smtp_port: z.number().int().min(1).max(65535),
    smtp_secure: z.boolean().optional().default(false),
    imap_host: z.string().max(255).optional().nullable(),
    imap_port: z.number().int().min(1).max(65535).optional().nullable(),
    imap_secure: z.boolean().optional().default(true),
    username: z.string().min(1, 'Username required').max(255),
    password: z.string().min(1, 'Password required').max(500),
    is_default: z.boolean().optional().default(false),
    allow_invalid_cert: z.boolean().optional().default(false),
});

// ── Campaign schemas ──────────────────────────────────────────────────────

const campaignSettingsSchema = z.object({
    daily_limit: z.number().int().min(1).max(500).optional(),
    // Kutu-başı günlük limit: her gönderen kutusunun günde en fazla kaç mail atacağı.
    per_inbox_limit: z.number().int().min(1).max(500).optional(),
    // İnsansı gönderim: her gönderime 0..N dk arası rastgele gecikme eklenir.
    jitter_minutes: z.number().int().min(0).max(120).optional(),
    timezone: z.string().max(50).optional(),
    sending_window: z.object({
        days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
        start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    }).optional(),
    // Inbox rotasyonu: kampanyanın kullanacağı gönderen mailbox adresleri (boşsa varsayılan kutu).
    sending_accounts: z.array(z.string().email()).max(50).optional(),
    // Kampanya seviyesi CC adresleri (her gönderime eklenir).
    cc: z.array(z.string().email()).max(20).optional(),
    // Açılma/tıklama takip toggle'ları (tanımsızsa ikisi de açık).
    tracking: z.object({
        open: z.boolean().optional(),
        click: z.boolean().optional(),
    }).optional(),
});

export const createCampaignSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    from_name: z.string().max(100).optional(),
    settings: campaignSettingsSchema.optional(),
});

export const updateCampaignSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    from_name: z.string().max(100).optional(),
    settings: campaignSettingsSchema.optional(),
});

const emailStepSchema = z.object({
    step_type: z.literal('email'),
    // Boş bırakılabilir (yarım dizi kaydetme serbest); adım kartında uyarı gösterilir.
    // null kabul edilir: route boş konuyu null saklar, reload + tekrar kaydetme bozulmasın.
    subject: z.string().max(500).nullable(),
    body_html: z.string().max(50000).nullable(),
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

// ── Graf kaydı (Faz 2 — görsel karar ağacı editörü) ─────────────────────────
// Client stabil id'lerle {nodes:[...]} gönderir; route save_campaign_graph RPC'sine
// (upsert + prune) verir. superRefine graf bütünlüğünü doğrular.
const graphNodeSchema = z.object({
    id: uuidField('Invalid node id'),
    step_type: z.enum(['email', 'delay', 'condition']),
    step_kind: z.enum(['email', 'delay', 'condition', 'split', 'action']).optional(),
    subject: z.string().max(500).nullish(),
    body_html: z.string().max(50000).nullish(),
    body_text: z.string().max(50000).nullish(),
    delay_days: z.number().int().min(0).max(90).optional().default(0),
    delay_hours: z.number().int().min(0).max(23).optional().default(0),
    condition_type: z.enum(['opened', 'clicked', 'replied', 'not_opened', 'not_clicked', 'not_replied']).nullish(),
    condition_wait_hours: z.number().int().min(0).max(8760).nullish(),
    next_step_id: uuidField().nullish(),
    condition_true_step_id: uuidField().nullish(),
    condition_false_step_id: uuidField().nullish(),
    is_entry: z.boolean().optional().default(false),
    step_order: z.number().int().min(0).max(1000).optional().default(0),
    config: z.record(z.string(), z.any()).optional().default({}),
}).passthrough();

export const saveGraphSchema = z.object({
    nodes: z.array(graphNodeSchema).min(1).max(100),
}).superRefine((g, ctx) => {
    const ids = new Set<string>();
    for (const n of g.nodes) {
        if (ids.has(n.id)) ctx.addIssue({ code: 'custom', message: `Duplicate node id ${n.id}`, path: ['nodes'] });
        ids.add(n.id);
    }
    const entries = g.nodes.filter((n) => n.is_entry).length;
    if (entries !== 1) ctx.addIssue({ code: 'custom', message: `Graph must have exactly one entry node (found ${entries})`, path: ['nodes'] });
    for (const n of g.nodes) {
        for (const ptr of [n.next_step_id, n.condition_true_step_id, n.condition_false_step_id]) {
            if (ptr && !ids.has(ptr)) ctx.addIssue({ code: 'custom', message: `Edge points to unknown node ${ptr}`, path: ['nodes'] });
        }
        if (n.step_type === 'condition' && !n.condition_type) {
            ctx.addIssue({ code: 'custom', message: 'Condition node requires condition_type', path: ['nodes'] });
        }
    }
});

export const enrollLeadsSchema = z.object({
    contacts: z.array(z.object({
        contact_id: uuidField(),
        company_id: uuidField(),
        email: z.string().email(),
    })).min(1).max(200),
});

// Toplu enrollment aksiyonu — seçili kayıtları duraklat/sürdür/çıkar.
export const bulkEnrollmentActionSchema = z.object({
    action: z.enum(['pause', 'resume', 'remove']),
    ids: z.array(uuidField()).min(1).max(1000),
});

// Test gönderimi — bir adımın konu/gövdesini örnek verilerle bir adrese yolla.
export const testSendSchema = z.object({
    to: z.string().email(),
    subject: z.string().max(500).optional(),
    body_html: z.string().max(50000).optional(),
});

// Audience filtresi — Drip kampanyaya filtreyle kişi seçimi/kaydı.
// stage/industry şirket seviyesi (companies join), country/seniority kişi seviyesi.
export const audienceFilterSchema = z.object({
    search: z.string().max(200).optional(),
    stages: z.array(z.string().max(100)).max(50).optional(),
    industries: z.array(z.string().max(200)).max(100).optional(),
    countries: z.array(z.string().max(100)).max(100).optional(),
    seniorities: z.array(z.string().max(100)).max(50).optional(),
});
