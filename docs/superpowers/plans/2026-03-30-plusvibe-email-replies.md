# PlusVibe Email Replies Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive PlusVibe email campaign replies via webhook, match them to companies/contacts, and display them in a dedicated Email Replies page with filtering, detail view, manual assignment, and stage updates.

**Architecture:** New `email_replies` table in Supabase with RLS. Public webhook endpoint (`/api/webhooks/plusvibe`) validates via secret header and matches sender email to contacts/companies using `supabaseAdmin`. Protected CRUD routes under `/api/email-replies` serve a new React page with stats, filters, table, and detail modal.

**Tech Stack:** Express.js routes, Supabase PostgreSQL + RLS, Zod validation, React 19 + Mantine UI + TanStack React Query, i18next (TR/EN)

**Spec:** `docs/superpowers/specs/2026-03-29-plusvibe-email-replies-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `supabase/migrations/019_email_replies.sql` | Table, indexes, RLS, constraints, trigger |
| `server/src/routes/webhooks.ts` | Webhook endpoint — secret validation, payload parsing, email matching, insert |
| `server/src/routes/email-replies.ts` | Protected CRUD — list, stats, campaigns, read toggle, assign |
| `server/src/lib/emailMatcher.ts` | Email matching logic — contacts → companies → unmatched |
| `client/src/types/emailReply.ts` | TypeScript interfaces for email replies |
| `client/src/pages/EmailRepliesPage.tsx` | Main page — stats cards, filters, table, pagination |
| `client/src/components/email/ReplyDetailModal.tsx` | Detail modal — reply content, stage update, read toggle |
| `client/src/components/email/AssignCompanyForm.tsx` | Company/contact assignment for unmatched replies |

### Modified Files
| File | Change |
|------|--------|
| `server/src/index.ts` | Register webhook route (before auth) + email-replies route (after auth) |
| `server/src/lib/validation.ts` | Add Zod schemas: `webhookPayloadSchema`, `assignReplySchema`, `emailRepliesQuerySchema` |
| `client/src/App.tsx` | Add `/email-replies` route |
| `client/src/components/Layout.tsx` | Add nav menu item for Email Replies |
| `client/src/locales/en.json` | Add `emailReplies` + `nav.emailReplies` translation keys |
| `client/src/locales/tr.json` | Add `emailReplies` + `nav.emailReplies` translation keys |

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/019_email_replies.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- ==========================================
-- Email Replies table (PlusVibe webhook data)
-- ==========================================

CREATE TABLE email_replies (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_name        TEXT,
  campaign_id          TEXT,
  sender_email         TEXT NOT NULL,
  reply_body           TEXT,
  replied_at           TIMESTAMPTZ,
  company_id           UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id           UUID REFERENCES contacts(id) ON DELETE SET NULL,
  match_status         TEXT NOT NULL DEFAULT 'unmatched'
                         CHECK (match_status IN ('matched', 'unmatched')),
  read_status          TEXT NOT NULL DEFAULT 'unread'
                         CHECK (read_status IN ('unread', 'read')),
  category             TEXT CHECK (category IN (
                         'positive', 'negative', 'meeting_request',
                         'waiting_response', 'not_interested', 'other'
                       )),
  category_confidence  REAL,
  raw_payload          JSONB,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

-- Deduplication: prevent same reply event from being inserted twice
-- Use partial unique index (WHERE campaign_id IS NOT NULL) because NULL != NULL in PG unique constraints
CREATE UNIQUE INDEX idx_email_replies_dedup
  ON email_replies(campaign_id, sender_email, replied_at)
  WHERE campaign_id IS NOT NULL;

ALTER TABLE email_replies ENABLE ROW LEVEL SECURITY;

-- ==========================================
-- INDEXES (composite, tenant-scoped)
-- ==========================================

CREATE INDEX idx_email_replies_tenant_replied
  ON email_replies(tenant_id, replied_at DESC);
CREATE INDEX idx_email_replies_tenant_match
  ON email_replies(tenant_id, match_status);
CREATE INDEX idx_email_replies_tenant_read
  ON email_replies(tenant_id, read_status);
CREATE INDEX idx_email_replies_tenant_company
  ON email_replies(tenant_id, company_id);
CREATE INDEX idx_email_replies_sender
  ON email_replies(sender_email);

-- ==========================================
-- RLS POLICIES (with superadmin override)
-- ==========================================

CREATE POLICY "email_replies_select" ON email_replies
  FOR SELECT USING (
    tenant_id = get_user_tenant_id() OR is_superadmin()
  );

CREATE POLICY "email_replies_insert" ON email_replies
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id() OR is_superadmin()
  );

CREATE POLICY "email_replies_update" ON email_replies
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id() OR is_superadmin()
  );

CREATE POLICY "email_replies_delete" ON email_replies
  FOR DELETE USING (
    tenant_id = get_user_tenant_id() OR is_superadmin()
  );

-- ==========================================
-- TRIGGER: auto-update updated_at
-- ==========================================

CREATE TRIGGER set_email_replies_updated_at
  BEFORE UPDATE ON email_replies
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
```

- [ ] **Step 2: Apply the migration**

Run: `cd /Users/homefolder/01_dev/01-workspace/talepgetir-leadhub-v1 && npx supabase db push` or apply via Supabase dashboard.

Verify: Table `email_replies` exists with all columns, indexes, RLS policies, and trigger.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/019_email_replies.sql
git commit -m "feat: add email_replies table migration with RLS and indexes"
```

---

## Task 2: Zod Validation Schemas

**Files:**
- Modify: `server/src/lib/validation.ts`

- [ ] **Step 1: Add email reply validation schemas**

Append to the end of `server/src/lib/validation.ts`:

```typescript
// ── Email Reply schemas ──

export const webhookPayloadSchema = z.object({
    event: z.literal('replied'),
    campaign_id: z.string().max(500).optional().nullable(),
    campaign_name: z.string().max(500).optional().nullable(),
    recipient_email: z.string().email('Invalid recipient email'),
    reply_body: z.string().optional().nullable(),
    replied_at: z.string().datetime({ message: 'replied_at must be a valid ISO datetime' }).optional().nullable(),
});

export const assignReplySchema = z.object({
    company_id: uuidField('Invalid company_id'),
    contact_id: uuidField('Invalid contact_id').optional(),
});

```

**Note:** The `uuidField` helper is already defined at the top of the file. GET query parameter validation is handled inline in the route handler (manual parsing with defaults), consistent with the existing `activities.ts` pattern.

- [ ] **Step 2: Verify the server still compiles**

Run: `cd /Users/homefolder/01_dev/01-workspace/talepgetir-leadhub-v1 && npx tsc --noEmit -p server/tsconfig.json`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/lib/validation.ts
git commit -m "feat: add Zod schemas for webhook payload, assign reply, and email replies query"
```

---

## Task 3: Email Matcher Library

**Files:**
- Create: `server/src/lib/emailMatcher.ts`

- [ ] **Step 1: Implement email matching logic**

```typescript
import { supabaseAdmin } from './supabase.js';
import { createLogger } from './logger.js';

const log = createLogger('emailMatcher');

export interface MatchResult {
    tenant_id: string;
    company_id: string | null;
    contact_id: string | null;
    match_status: 'matched' | 'unmatched';
}

/**
 * Match a sender email to a contact or company across all tenants.
 *
 * Priority:
 * 1. contacts.email → prefer is_primary, then updated_at DESC → returns contact + company
 * 2. companies.company_email → updated_at DESC → returns company only
 * 3. No match → uses defaultTenantId
 */
export async function matchSenderEmail(
    senderEmail: string,
    defaultTenantId: string
): Promise<MatchResult> {
    const email = senderEmail.toLowerCase().trim();

    // Step 1: Search contacts
    const { data: contacts, error: contactErr } = await supabaseAdmin
        .from('contacts')
        .select('id, company_id, tenant_id, is_primary, updated_at')
        .eq('email', email)
        .order('is_primary', { ascending: false })
        .order('updated_at', { ascending: false })
        .limit(1);

    if (contactErr) {
        log.error({ err: contactErr, email }, 'Contact lookup failed');
    }

    if (contacts && contacts.length > 0) {
        const contact = contacts[0];
        log.info({ email, contact_id: contact.id, company_id: contact.company_id }, 'Matched via contact');
        return {
            tenant_id: contact.tenant_id,
            company_id: contact.company_id,
            contact_id: contact.id,
            match_status: 'matched',
        };
    }

    // Step 2: Search companies
    const { data: companies, error: companyErr } = await supabaseAdmin
        .from('companies')
        .select('id, tenant_id, updated_at')
        .eq('company_email', email)
        .order('updated_at', { ascending: false })
        .limit(1);

    if (companyErr) {
        log.error({ err: companyErr, email }, 'Company lookup failed');
    }

    if (companies && companies.length > 0) {
        const company = companies[0];
        log.info({ email, company_id: company.id }, 'Matched via company email');
        return {
            tenant_id: company.tenant_id,
            company_id: company.id,
            contact_id: null,
            match_status: 'matched',
        };
    }

    // Step 3: No match
    log.info({ email }, 'No match found, using default tenant');
    return {
        tenant_id: defaultTenantId,
        company_id: null,
        contact_id: null,
        match_status: 'unmatched',
    };
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/homefolder/01_dev/01-workspace/talepgetir-leadhub-v1 && npx tsc --noEmit -p server/tsconfig.json`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/lib/emailMatcher.ts
git commit -m "feat: add email matcher library for webhook contact/company lookup"
```

---

## Task 4: Webhook Route

**Files:**
- Create: `server/src/routes/webhooks.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Implement webhook endpoint**

Create `server/src/routes/webhooks.ts`:

```typescript
import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { validateBody, webhookPayloadSchema } from '../lib/validation.js';
import { matchSenderEmail } from '../lib/emailMatcher.js';

const log = createLogger('route:webhooks');
const router = Router();

const WEBHOOK_SECRET = process.env.PLUSVIBE_WEBHOOK_SECRET;
const DEFAULT_TENANT_ID = process.env.PLUSVIBE_DEFAULT_TENANT_ID;

/** Middleware: validate webhook secret before anything else */
function verifyWebhookSecret(req: Request, res: Response, next: NextFunction): void {
    const secret = req.headers['x-webhook-secret'] as string;
    if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
        log.warn('Invalid webhook secret');
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    next();
}

// POST /api/webhooks/plusvibe — receive PlusVibe reply events
router.post(
    '/plusvibe',
    verifyWebhookSecret,
    validateBody(webhookPayloadSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {

            if (!DEFAULT_TENANT_ID) {
                log.error('PLUSVIBE_DEFAULT_TENANT_ID is not configured');
                throw new AppError('Webhook not configured', 500);
            }

            const { campaign_id, campaign_name, recipient_email, reply_body, replied_at } = req.body;

            // Match sender email to contact/company
            const match = await matchSenderEmail(recipient_email, DEFAULT_TENANT_ID);

            // Insert email reply
            // Deduplication: partial unique index on (campaign_id, sender_email, replied_at) WHERE campaign_id IS NOT NULL
            // For inserts with campaign_id, use upsert with ignoreDuplicates.
            // For inserts without campaign_id, always insert (no dedup possible).
            const row = {
                tenant_id: match.tenant_id,
                campaign_id: campaign_id || null,
                campaign_name: campaign_name || null,
                sender_email: recipient_email.toLowerCase().trim(),
                reply_body: reply_body || null,
                replied_at: replied_at || new Date().toISOString(),
                company_id: match.company_id,
                contact_id: match.contact_id,
                match_status: match.match_status,
                read_status: 'unread',
                raw_payload: req.body,
            };

            let error;
            if (campaign_id) {
                ({ error } = await supabaseAdmin
                    .from('email_replies')
                    .upsert(row, { onConflict: 'campaign_id,sender_email,replied_at', ignoreDuplicates: true }));
            } else {
                ({ error } = await supabaseAdmin
                    .from('email_replies')
                    .insert(row));
            }

            if (error) {
                log.error({ err: error }, 'Failed to insert email reply');
                throw new AppError('Failed to process webhook', 500);
            }

            log.info({ campaign_id, sender: recipient_email, match_status: match.match_status }, 'Webhook processed');
            res.status(200).json({ ok: true });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Webhook processing error');
            res.status(500).json({ error: 'Internal server error' });
        }
    }
);

export default router;
```

- [ ] **Step 2: Register webhook route in index.ts (before auth middleware)**

In `server/src/index.ts`, add the import at the top with other route imports:

```typescript
import webhooksRoutes from './routes/webhooks.js';
```

Add the route registration **after** the auth routes but **before** the `authMiddleware` protected routes block (line ~101, after `app.use('/api/auth', authRoutes);`):

```typescript
// Webhook routes — public, validated by their own secret, with dedicated rate limiter
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many webhook requests' },
});
app.use('/api/webhooks', webhookLimiter, webhooksRoutes);
```

**Note:** The `webhookLimiter` is defined inline here for clarity, but in the actual implementation, define it alongside the existing `authLimiter`, `importLimiter`, and `generalLimiter` definitions (lines ~66-88).

The final order should be:
1. `app.use('/api/auth', authRoutes);` (existing)
2. `app.use('/api/webhooks', webhooksRoutes);` (NEW)
3. `app.use('/api/companies', authMiddleware, ...` (existing protected routes)

- [ ] **Step 3: Add env variables to `.env.example`**

Add to both root `.env.example` (if it exists) and document in spec:

```
PLUSVIBE_WEBHOOK_SECRET=your-webhook-secret-here
PLUSVIBE_DEFAULT_TENANT_ID=your-default-tenant-uuid
```

- [ ] **Step 4: Verify compilation**

Run: `cd /Users/homefolder/01_dev/01-workspace/talepgetir-leadhub-v1 && npx tsc --noEmit -p server/tsconfig.json`

Expected: No errors.

- [ ] **Step 5: Test webhook manually with curl**

```bash
curl -X POST http://localhost:3001/api/webhooks/plusvibe \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: YOUR_SECRET" \
  -d '{
    "event": "replied",
    "campaign_id": "test_001",
    "campaign_name": "Test Campaign",
    "recipient_email": "test@example.com",
    "reply_body": "We are interested in your product.",
    "replied_at": "2026-03-30T10:00:00Z"
  }'
```

Expected: `{"ok": true}` with 200 status.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/webhooks.ts server/src/index.ts
git commit -m "feat: add PlusVibe webhook endpoint with email matching"
```

---

## Task 5: Email Replies API Routes

**Files:**
- Create: `server/src/routes/email-replies.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Implement the email replies CRUD routes**

Create `server/src/routes/email-replies.ts`:

```typescript
import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin, createUserClient } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import { validateBody, assignReplySchema } from '../lib/validation.js';
import { isInternalRole } from '../lib/roles.js';

const log = createLogger('route:email-replies');
const router = Router();

function dbClient(req: Request) {
    if (isInternalRole(req.user!.role)) return supabaseAdmin;
    return createUserClient(req.accessToken!);
}

// GET /api/email-replies — paginated list with filters
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
        const offset = (page - 1) * limit;
        const { campaign_id, match_status, read_status, date_from, date_to, search } = req.query;

        const db = dbClient(req);
        let query = db
            .from('email_replies')
            .select('*', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .order('replied_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (campaign_id) query = query.eq('campaign_id', campaign_id as string);
        if (match_status) query = query.eq('match_status', match_status as string);
        if (read_status) query = query.eq('read_status', read_status as string);
        if (date_from) query = query.gte('replied_at', date_from as string);
        if (date_to) query = query.lte('replied_at', date_to as string);
        if (search) {
            const term = (search as string).replace(/%/g, '\\%').replace(/_/g, '\\_');
            query = query.or(`reply_body.ilike.%${term}%,sender_email.ilike.%${term}%`);
        }

        const { data, count, error } = await query;

        if (error) {
            log.error({ err: error }, 'List email replies error');
            throw new AppError('Failed to fetch email replies', 500);
        }

        // Resolve company names and contact names via JOINs
        const rows = data || [];
        const companyIds = [...new Set(rows.map((r: any) => r.company_id).filter(Boolean))];
        const contactIds = [...new Set(rows.map((r: any) => r.contact_id).filter(Boolean))];

        const companyMap: Record<string, string> = {};
        const contactMap: Record<string, string> = {};

        if (companyIds.length > 0) {
            const { data: companies } = await db
                .from('companies')
                .select('id, name')
                .in('id', companyIds);
            for (const c of companies || []) {
                companyMap[c.id] = c.name;
            }
        }

        if (contactIds.length > 0) {
            const { data: contacts } = await db
                .from('contacts')
                .select('id, first_name, last_name')
                .in('id', contactIds);
            for (const c of contacts || []) {
                contactMap[c.id] = [c.first_name, c.last_name].filter(Boolean).join(' ');
            }
        }

        // Resolve names for display
        const mapped = rows.map((r: any) => ({
            ...r,
            company_name: r.company_id ? (companyMap[r.company_id] || null) : null,
            contact_name: r.contact_id ? (contactMap[r.contact_id] || null) : null,
        }));
        // Note: search operates on reply_body + sender_email at DB level.
        // Company name search is not included to avoid pagination inconsistencies.
        // A future RPC/view could enable cross-table search if needed.

        const total = count || 0;
        res.json({
            data: mapped,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasNext: page < Math.ceil(total / limit),
                hasPrev: page > 1,
            },
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'List email replies error');
        res.status(500).json({ error: 'Failed to fetch email replies' });
    }
});

// GET /api/email-replies/stats — summary statistics
router.get('/stats', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const db = dbClient(req);

        // Use separate count queries for efficiency (avoids fetching all rows)
        const [totalRes, unreadRes, matchedRes, unmatchedRes] = await Promise.all([
            db.from('email_replies').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
            db.from('email_replies').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('read_status', 'unread'),
            db.from('email_replies').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('match_status', 'matched'),
            db.from('email_replies').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('match_status', 'unmatched'),
        ]);

        const error = totalRes.error || unreadRes.error || matchedRes.error || unmatchedRes.error;
        if (error) {
            log.error({ err: error }, 'Email replies stats error');
            throw new AppError('Failed to fetch stats', 500);
        }

        res.json({
            total: totalRes.count || 0,
            unread: unreadRes.count || 0,
            matched: matchedRes.count || 0,
            unmatched: unmatchedRes.count || 0,
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Email replies stats error');
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// GET /api/email-replies/campaigns — distinct campaign list for filter dropdown
router.get('/campaigns', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const db = dbClient(req);

        const { data, error } = await db
            .from('email_replies')
            .select('campaign_id, campaign_name')
            .eq('tenant_id', tenantId)
            .not('campaign_id', 'is', null);

        if (error) {
            log.error({ err: error }, 'Email replies campaigns error');
            throw new AppError('Failed to fetch campaigns', 500);
        }

        // Deduplicate by campaign_id
        const seen = new Set<string>();
        const campaigns = (data || []).filter((r: any) => {
            if (seen.has(r.campaign_id)) return false;
            seen.add(r.campaign_id);
            return true;
        });

        res.json(campaigns);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Email replies campaigns error');
        res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
});

// PATCH /api/email-replies/:id/read — toggle read status
router.patch(
    '/:id/read',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const db = dbClient(req);
            const { id } = req.params;

            const tenantId = req.tenantId!;

            // Fetch current read_status
            const { data: existing, error: fetchErr } = await db
                .from('email_replies')
                .select('id, read_status')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (fetchErr || !existing) {
                throw new AppError('Email reply not found', 404);
            }

            const newStatus = existing.read_status === 'unread' ? 'read' : 'unread';

            const { error: updateErr } = await db
                .from('email_replies')
                .update({ read_status: newStatus })
                .eq('id', id)
                .eq('tenant_id', tenantId);

            if (updateErr) {
                log.error({ err: updateErr }, 'Toggle read status error');
                throw new AppError('Failed to update read status', 500);
            }

            res.json({ id, read_status: newStatus });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Toggle read status error');
            res.status(500).json({ error: 'Failed to update read status' });
        }
    }
);

// PATCH /api/email-replies/:id/assign — manually assign company/contact
router.patch(
    '/:id/assign',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(assignReplySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const db = dbClient(req);
            const tenantId = req.tenantId!;
            const { id } = req.params;
            const { company_id, contact_id } = req.body;

            const { data, error } = await db
                .from('email_replies')
                .update({
                    company_id,
                    contact_id: contact_id || null,
                    match_status: 'matched',
                })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select('id, company_id, contact_id, match_status')
                .single();

            if (error) {
                log.error({ err: error }, 'Assign company error');
                throw new AppError('Failed to assign company', 500);
            }

            if (!data) {
                throw new AppError('Email reply not found', 404);
            }

            res.json(data);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Assign company error');
            res.status(500).json({ error: 'Failed to assign company' });
        }
    }
);

export default router;
```

- [ ] **Step 2: Register email-replies route in index.ts**

In `server/src/index.ts`, add the import:

```typescript
import emailRepliesRoutes from './routes/email-replies.js';
```

Add the route registration in the protected routes block (after activities):

```typescript
app.use('/api/email-replies', authMiddleware, emailRepliesRoutes);
```

- [ ] **Step 3: Verify compilation**

Run: `cd /Users/homefolder/01_dev/01-workspace/talepgetir-leadhub-v1 && npx tsc --noEmit -p server/tsconfig.json`

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/email-replies.ts server/src/index.ts
git commit -m "feat: add email replies CRUD API routes with filtering and pagination"
```

---

## Task 6: TypeScript Types (Client)

**Files:**
- Create: `client/src/types/emailReply.ts`

- [ ] **Step 1: Define email reply types**

```typescript
export type MatchStatus = 'matched' | 'unmatched';
export type ReadStatus = 'read' | 'unread';
export type EmailCategory =
    | 'positive'
    | 'negative'
    | 'meeting_request'
    | 'waiting_response'
    | 'not_interested'
    | 'other';

export interface EmailReply {
    id: string;
    tenant_id: string;
    campaign_name: string | null;
    campaign_id: string | null;
    sender_email: string;
    reply_body: string | null;
    replied_at: string;
    company_id: string | null;
    company_name: string | null;
    contact_id: string | null;
    contact_name: string | null;
    match_status: MatchStatus;
    read_status: ReadStatus;
    category: EmailCategory | null;
    category_confidence: number | null;
    created_at: string;
}

export interface EmailReplyStats {
    total: number;
    unread: number;
    matched: number;
    unmatched: number;
}

export interface Campaign {
    campaign_id: string;
    campaign_name: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/types/emailReply.ts
git commit -m "feat: add TypeScript types for email replies"
```

---

## Task 7: i18n Translations

**Files:**
- Modify: `client/src/locales/en.json`
- Modify: `client/src/locales/tr.json`

- [ ] **Step 1: Add English translations**

Add to `client/src/locales/en.json`:

In the `"nav"` section, add:
```json
"emailReplies": "Email Replies"
```

Add a new top-level `"emailReplies"` section:
```json
"emailReplies": {
    "pageTitle": "Email Replies",
    "stats": {
        "total": "Total Replies",
        "unread": "Unread",
        "matched": "Matched",
        "unmatched": "Unmatched"
    },
    "filters": {
        "search": "Search replies, email, or company...",
        "campaign": "Campaign",
        "allCampaigns": "All Campaigns",
        "matchStatus": "Match Status",
        "allMatchStatuses": "All Statuses",
        "readStatus": "Read Status",
        "allReadStatuses": "Read / Unread",
        "dateRange": "Date Range"
    },
    "table": {
        "campaign": "Campaign",
        "sender": "Sender",
        "company": "Company",
        "contact": "Contact",
        "preview": "Reply Preview",
        "date": "Date"
    },
    "status": {
        "matched": "Matched",
        "unmatched": "Unmatched",
        "read": "Read",
        "unread": "Unread"
    },
    "detail": {
        "title": "Email Reply Detail",
        "campaign": "Campaign",
        "date": "Date",
        "sender": "Sender",
        "company": "Company",
        "contact": "Contact",
        "replyBody": "Reply Content",
        "actions": "Actions"
    },
    "actions": {
        "updateStage": "Update Stage",
        "update": "Update",
        "markRead": "Mark as Read",
        "markUnread": "Mark as Unread",
        "currentStage": "Current"
    },
    "assign": {
        "title": "Assign to Company",
        "warning": "This reply has not been matched to any company yet. Please assign manually.",
        "searchCompany": "Search company...",
        "searchContact": "Search contact (optional)...",
        "assignButton": "Assign"
    },
    "aiCategory": {
        "title": "AI Category",
        "comingSoon": "Coming Soon — automatic segmentation"
    },
    "noData": "No email replies yet",
    "noDataDescription": "Replies from PlusVibe campaigns will appear here.",
    "loadMore": "Load More",
    "assigned": "Reply assigned successfully",
    "stageUpdated": "Stage updated successfully",
    "readStatusUpdated": "Read status updated"
}
```

- [ ] **Step 2: Add Turkish translations**

Add to `client/src/locales/tr.json`:

In the `"nav"` section, add:
```json
"emailReplies": "Email Yanıtları"
```

Add a new top-level `"emailReplies"` section:
```json
"emailReplies": {
    "pageTitle": "Email Yanıtları",
    "stats": {
        "total": "Toplam Yanıt",
        "unread": "Okunmamış",
        "matched": "Eşleşmiş",
        "unmatched": "Eşleşmemiş"
    },
    "filters": {
        "search": "Yanıt, email veya şirket ara...",
        "campaign": "Kampanya",
        "allCampaigns": "Tüm Kampanyalar",
        "matchStatus": "Eşleşme Durumu",
        "allMatchStatuses": "Tüm Durumlar",
        "readStatus": "Okunma Durumu",
        "allReadStatuses": "Okundu / Okunmadı",
        "dateRange": "Tarih Aralığı"
    },
    "table": {
        "campaign": "Kampanya",
        "sender": "Gönderen",
        "company": "Şirket",
        "contact": "Kişi",
        "preview": "Yanıt Önizleme",
        "date": "Tarih"
    },
    "status": {
        "matched": "Eşleşmiş",
        "unmatched": "Eşleşmemiş",
        "read": "Okunmuş",
        "unread": "Okunmamış"
    },
    "detail": {
        "title": "Email Yanıt Detayı",
        "campaign": "Kampanya",
        "date": "Tarih",
        "sender": "Gönderen",
        "company": "Şirket",
        "contact": "Kişi",
        "replyBody": "Yanıt İçeriği",
        "actions": "Aksiyonlar"
    },
    "actions": {
        "updateStage": "Stage Güncelle",
        "update": "Güncelle",
        "markRead": "Okundu İşaretle",
        "markUnread": "Okunmadı İşaretle",
        "currentStage": "Mevcut"
    },
    "assign": {
        "title": "Şirkete Ata",
        "warning": "Bu yanıt henüz bir şirketle eşleşmedi. Lütfen manuel olarak atayın.",
        "searchCompany": "Şirket ara...",
        "searchContact": "Kişi ara (opsiyonel)...",
        "assignButton": "Ata"
    },
    "aiCategory": {
        "title": "AI Kategori",
        "comingSoon": "Yakında — otomatik segmentasyon"
    },
    "noData": "Henüz email yanıtı yok",
    "noDataDescription": "PlusVibe kampanyalarından gelen yanıtlar burada görünecek.",
    "loadMore": "Daha Fazla",
    "assigned": "Yanıt başarıyla atandı",
    "stageUpdated": "Stage başarıyla güncellendi",
    "readStatusUpdated": "Okunma durumu güncellendi"
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/locales/en.json client/src/locales/tr.json
git commit -m "feat: add email replies i18n translations (TR + EN)"
```

---

## Task 8: Email Replies Page

**Files:**
- Create: `client/src/pages/EmailRepliesPage.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/components/Layout.tsx`

This is the largest task. It builds the main page with stats cards, filter bar, and data table.

**Reference patterns:**
- Stats cards + filter bar: follow `ActivitiesPage.tsx` patterns
- Pagination: load-more pattern from `ActivitiesPage.tsx`
- React Query hooks: `useQuery` for data fetching, `useMutation` for updates
- API calls: use `api.get()` / `api.patch()` from `client/src/lib/api.ts`
- Mantine components: `Paper`, `Group`, `Text`, `Table`, `Select`, `TextInput`, `Badge`, `ActionIcon`, `Pagination`

- [ ] **Step 1: Create EmailRepliesPage.tsx**

Create `client/src/pages/EmailRepliesPage.tsx` with:

1. **State:** page, filters (campaign, matchStatus, readStatus, search, dateRange), selectedReply (for modal)
2. **Queries:**
   - `useQuery(['email-replies', filters], ...)` → `GET /email-replies?...`
   - `useQuery(['email-replies-stats'], ...)` → `GET /email-replies/stats`
   - `useQuery(['email-replies-campaigns'], ...)` → `GET /email-replies/campaigns`
3. **Layout:**
   - 4 stat cards in a `SimpleGrid` (total, unread, matched, unmatched) — use `Paper` with colored `Text` for numbers
   - Filter bar: `TextInput` (search), `Select` (campaign, match_status, read_status), `DatePickerInput` (date range)
   - `Table` with columns: unread indicator, campaign badge, sender, company (link), contact, preview (truncated), date
   - Rows: unread rows have light blue bg, unmatched show red Badge in company column
   - Click row → open `ReplyDetailModal`
   - Load more button at bottom
4. **Mutations:**
   - `readToggle` → `PATCH /email-replies/:id/read` with query invalidation

Implementation should follow the existing `ActivitiesPage.tsx` patterns for query setup, filter handling, and Mantine component usage. Use `useTranslation()` for all text, `dayjs` or `new Date().toLocaleDateString()` for date formatting.

The page component should be ~250-350 lines. Use Mantine's `Table`, `Paper`, `SimpleGrid`, `TextInput`, `Select`, `Badge`, `Group`, `Stack`, `Text`, `Button`, `Tooltip` components.

- [ ] **Step 2: Add route to App.tsx**

In `client/src/App.tsx`:

Add lazy import:
```typescript
const EmailRepliesPage = lazy(() => import('./pages/EmailRepliesPage'));
```

Add route inside the `<Route element={<Layout />}>` block, after the activities route:
```tsx
<Route path="/email-replies" element={<EmailRepliesPage />} />
```

- [ ] **Step 3: Add nav menu item to Layout.tsx**

In `client/src/components/Layout.tsx`:

Add icon import:
```typescript
import { IconMail } from '@tabler/icons-react';
```

Add nav item in the `navItems` array (after the activities entry):
```typescript
{ path: '/email-replies', label: t('nav.emailReplies'), icon: <IconMail size={20} /> },
```

- [ ] **Step 4: Verify the dev server runs**

Run: `cd /Users/homefolder/01_dev/01-workspace/talepgetir-leadhub-v1 && npm run dev:client`

Expected: No compilation errors. Navigate to `/email-replies` — page renders with stats (0s if no data), filter bar, and empty table.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/EmailRepliesPage.tsx client/src/App.tsx client/src/components/Layout.tsx
git commit -m "feat: add Email Replies page with stats, filters, and table"
```

---

## Task 9: Reply Detail Modal

**Files:**
- Create: `client/src/components/email/ReplyDetailModal.tsx`
- Modify: `client/src/pages/EmailRepliesPage.tsx` (wire up modal)

- [ ] **Step 1: Create ReplyDetailModal.tsx**

Create `client/src/components/email/ReplyDetailModal.tsx`:

The modal receives an `EmailReply` object and renders:

1. **Header:** Campaign badge + date
2. **Info grid:** Sender email | Company (link to `/companies/:id`) | Contact name
3. **Reply body:** Full text in a styled `Paper` with left border (blue for matched, orange for unmatched)
4. **Actions section:**
   - **Stage Update** (only if company_id exists): `Select` with pipeline stages from `StagesContext` + "Update" button. On update: `PUT /api/companies/:companyId` with new stage → invalidate queries → show success notification.
   - **Read/Unread toggle** button
   - **AI Category** placeholder (disabled, "Coming Soon" text)
5. **If unmatched:** Show `AssignCompanyForm` instead of stage update

Props:
```typescript
interface ReplyDetailModalProps {
    reply: EmailReply | null;
    opened: boolean;
    onClose: () => void;
}
```

Use `Modal` from Mantine. Size `lg`. Reference `StagesContext` for pipeline stages dropdown.

- [ ] **Step 2: Create AssignCompanyForm.tsx**

Create `client/src/components/email/AssignCompanyForm.tsx`:

A form that:
1. Shows a yellow `Alert` with warning message
2. Company search: `Select` with search enabled — queries `GET /api/companies?search=...` on type (debounced)
3. Contact search (optional): `Select` with search — queries `GET /api/contacts?company_id=...` when company is selected
4. "Assign" button → `PATCH /api/email-replies/:id/assign` → invalidate queries → show success notification

Props:
```typescript
interface AssignCompanyFormProps {
    replyId: string;
    onAssigned: () => void;
}
```

- [ ] **Step 3: Wire modal into EmailRepliesPage**

In `EmailRepliesPage.tsx`:
- Import `ReplyDetailModal`
- Add state: `const [selectedReply, setSelectedReply] = useState<EmailReply | null>(null);`
- On table row click: `setSelectedReply(reply)`
- Render `<ReplyDetailModal reply={selectedReply} opened={!!selectedReply} onClose={() => setSelectedReply(null)} />`

- [ ] **Step 4: Test end-to-end**

1. Send a test webhook (curl from Task 4 Step 5)
2. Navigate to `/email-replies` — reply should appear in table
3. Click the row — modal opens with reply details
4. Toggle read status — row background changes
5. If matched: test stage update via dropdown
6. If unmatched: test company assignment via search

- [ ] **Step 5: Commit**

```bash
git add client/src/components/email/ReplyDetailModal.tsx client/src/components/email/AssignCompanyForm.tsx client/src/pages/EmailRepliesPage.tsx
git commit -m "feat: add reply detail modal with stage update and company assignment"
```

---

## Task 10: Final Verification & Lint

- [ ] **Step 1: Run the linter**

```bash
cd /Users/homefolder/01_dev/01-workspace/talepgetir-leadhub-v1/client && npm run lint
```

Fix any errors.

- [ ] **Step 2: Run the full build**

```bash
cd /Users/homefolder/01_dev/01-workspace/talepgetir-leadhub-v1 && npm run build
```

Expected: Both server and client build without errors.

- [ ] **Step 3: End-to-end smoke test**

1. Start dev servers: `npm run dev`
2. Verify webhook receives and stores a reply (curl test)
3. Verify Email Replies page loads with data
4. Verify filters work (campaign, match status, read status, search, date)
5. Verify detail modal opens
6. Verify read toggle works
7. Verify stage update works (for matched replies)
8. Verify company assignment works (for unmatched replies)
9. Verify nav menu item appears correctly
10. Verify both TR and EN translations render

- [ ] **Step 4: Commit any remaining fixes**

Stage only the files you modified during lint/build fixes — avoid `git add -A`:

```bash
git add <specific-files-that-were-fixed>
git commit -m "fix: lint and build fixes for email replies feature"
```
