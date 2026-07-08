import { timingSafeEqual, createHmac } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { validateBody, webhookPayloadSchema } from '../lib/validation.js';
import { matchSenderEmail, advanceCompanyStageOnMatch } from '../lib/emailMatcher.js';
import { enrichCompanyFromWebhook, enrichContactFromWebhook } from '../lib/webhookEnricher.js';
import { cancelEnrollmentOnReply } from '../lib/campaignEngine.js';
import { parseWebhookInbound } from '../lib/mail/plusvibeAdapter.js';
import { canonicalToReplyRow, splitEmailBody } from '../lib/mail/types.js';
import {
    resolveCampaignTenant,
    hydrateThreadCampaignSends,
    syncCampaignsDebounced,
} from '../lib/mail/replyImport.js';

const log = createLogger('route:webhooks');
const router = Router();

const WEBHOOK_SECRET = process.env.PLUSVIBE_WEBHOOK_SECRET;

/** Middleware: validate PlusVibe HMAC-SHA256 signature before anything else */
function verifyWebhookSecret(req: Request, res: Response, next: NextFunction): void {
    if (!WEBHOOK_SECRET) {
        log.error('PLUSVIBE_WEBHOOK_SECRET env var is not set — all webhook requests will be rejected');
        res.status(503).json({
            error: 'Webhook endpoint not configured',
            code: 'WEBHOOK_SECRET_MISSING',
            hint: 'Set PLUSVIBE_WEBHOOK_SECRET in the server environment and restart.',
        });
        return;
    }

    const signature = req.headers['signature'] as string | undefined;
    if (!signature) {
        log.warn({ ip: req.ip }, 'Missing signature header');
        res.status(401).json({ error: 'Missing signature header', code: 'MISSING_SIGNATURE' });
        return;
    }

    // PlusVibe signs the raw request body with HMAC-SHA256
    const rawBody: Buffer = (req as any).rawBody ?? Buffer.alloc(0);
    const expectedHex = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

    // Accept both plain hex and "sha256=<hex>" formats
    const receivedHex = signature.startsWith('sha256=') ? signature.slice(7) : signature;

    let valid = false;
    try {
        const a = Buffer.from(receivedHex, 'hex');
        const b = Buffer.from(expectedHex, 'hex');
        valid = a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
    } catch {
        valid = false;
    }

    if (!valid) {
        log.warn({ ip: req.ip }, 'Invalid webhook signature');
        res.status(401).json({ error: 'Invalid webhook signature', code: 'INVALID_SIGNATURE' });
        return;
    }
    next();
}

/**
 * Trim raw_payload to avoid storing oversized bodies — WITHOUT losing the
 * canonical fields (those are now in dedicated columns, populated before this).
 * Strategy: if the body is large, drop only the bulky content fields
 * (body/text_body/html); keep all metadata. Only if still huge, keep essentials.
 */
const MAX_RAW_PAYLOAD_SIZE = 20_000; // characters
function sanitizePayload(body: Record<string, unknown>): unknown {
    if (JSON.stringify(body).length <= MAX_RAW_PAYLOAD_SIZE) return body;

    const { body: _b, text_body: _t, html: _h, snippet: _s, ...rest } = body;
    const trimmed = { ...rest, _body_trimmed: true };
    if (JSON.stringify(trimmed).length <= MAX_RAW_PAYLOAD_SIZE) return trimmed;

    return {
        _truncated: true,
        _size: JSON.stringify(body).length,
        source: body.source ?? null,
        thread_id: body.thread_id ?? null,
        message_id: body.message_id ?? null,
    };
}

/**
 * Core PlusVibe inbound processing for the single multi-tenant webhook. The tenant
 * is already resolved by the caller (from camp_id). Sends its own HTTP response.
 */
async function processPlusvibeInbound(req: Request, res: Response, tenantId: string): Promise<void> {
    const { from_email, step, webhook_event } = req.body;

    // We only ingest reply events — they carry the replying lead's from_email.
    // PlusVibe delivers other events (EMAIL_SENT/OPENED/CLICKED…) to the same URL;
    // outbound sends are already captured via campaign sync, so ack & skip the rest
    // (200, not 400 — otherwise PlusVibe marks delivery failed and retries).
    if (!from_email) {
        log.info({ event: webhook_event ?? null, camp_id: req.body.camp_id ?? null }, 'Non-reply webhook event — acknowledged & skipped');
        res.status(200).json({ ok: true, skipped: `event:${webhook_event ?? 'no_from_email'}` });
        return;
    }

    // Normalize the webhook into a CanonicalMessage (extracts from/to/account
    // into first-class fields BEFORE any body trimming).
    const canonical = parseWebhookInbound(req.body, tenantId);

    // Match sender email to contact/company within this tenant
    let match;
    try {
        match = await matchSenderEmail(canonical.senderEmail, tenantId, {
            company_name: canonical.hints?.companyName,
            company_website: canonical.hints?.companyWebsite,
        });
    } catch (matchErr) {
        log.error({ err: matchErr, from_email }, 'Email matching failed — database may be unavailable');
        res.status(503).json({
            error: 'Email matching service unavailable',
            code: 'EMAIL_MATCH_FAILED',
            hint: 'Database lookup failed. Retry the webhook later.',
        });
        return;
    }

    // matchSenderEmail is fully scoped to `tenantId` (every layer filters by it and
    // the no-match fallback returns it), so match.tenant_id always equals tenantId.
    // No cross-tenant check is possible or needed here.

    // Keep only the fresh reply text (drop quoted history) for the body column.
    canonical.bodyText = canonical.bodyText ? splitEmailBody(canonical.bodyText).fresh : null;
    canonical.bodyHtml = null; // bulky HTML stays out of columns; raw_payload keeps it if small
    canonical.occurredAt = canonical.occurredAt || new Date().toISOString();
    canonical.rawPayload = sanitizePayload(req.body) as Record<string, unknown>;

    // Insert email reply
    // Deduplication: partial unique index on (campaign_id, sender_email, replied_at) WHERE campaign_id IS NOT NULL
    const row = {
        ...canonicalToReplyRow(canonical),
        company_id: match.company_id,
        contact_id: match.contact_id,
        match_status: match.match_status,
        match_method: match.match_method,
        read_status: 'unread',
        step: step ?? null,
    };

    const { error } = await supabaseAdmin
        .from('email_replies')
        .insert(row);

    if (error) {
        // Partial unique index handles dedup — treat unique violation as success
        if (error.code === '23505') {
            log.info({ camp_id: canonical.campaignId, sender: from_email }, 'Duplicate webhook ignored');
            res.status(200).json({ ok: true, duplicate: true });
            return;
        }
        log.error({ err: error, camp_id: canonical.campaignId, sender: from_email }, 'Failed to insert email reply into database');
        res.status(500).json({
            error: 'Failed to store email reply',
            code: 'DB_INSERT_FAILED',
            hint: 'Database write failed. Retry the webhook. If this persists, check Supabase logs.',
        });
        return;
    }

    if (match.company_id && match.match_status === 'matched') {
        await advanceCompanyStageOnMatch(match.company_id);
    }

    // Fire-and-forget enrichment — never fail the webhook due to enrichment errors
    try {
        if (match.company_id) {
            await enrichCompanyFromWebhook(match.company_id, req.body, tenantId);
        }
        if (match.contact_id) {
            await enrichContactFromWebhook(match.contact_id, req.body);
        }
    } catch (enrichErr) {
        log.warn({ err: enrichErr, camp_id: canonical.campaignId, sender: from_email }, 'Enrichment failed (non-critical)');
    }

    // Cancel active campaign enrollments for this sender (drip auto-stop on reply)
    cancelEnrollmentOnReply(from_email, tenantId).catch((cancelErr) =>
        log.warn({ err: cancelErr, from_email }, 'Campaign enrollment cancel check failed'),
    );

    // Hydrate the outbound campaign sends (first-touch + steps) for this thread
    // from PlusVibe so our opening email shows up. Gated + fire-and-forget. Pass the
    // match we already computed so the OUT rows adopt the same company/contact as
    // this reply (and we don't rebuild a matcher).
    if (canonical.campaignId && canonical.senderEmail) {
        // PlusVibe files campaign sends under the LEAD address (campaign target), which
        // isn't always the replier. The webhook carries the lead email (`lead`/`lead_email`)
        // — pass it so a reply from a different address than the target still hydrates the
        // opener. Falls back to the replier when absent (the common replier == lead case).
        const pvLeadEmail =
            typeof req.body.lead === 'string' ? req.body.lead
            : typeof req.body.lead_email === 'string' ? req.body.lead_email
            : undefined;
        hydrateThreadCampaignSends({
            tenantId,
            pvCampaignId: canonical.campaignId,
            campaignName: canonical.campaignName,
            leadEmail: canonical.senderEmail,
            pvLeadEmail,
            match: { company_id: match.company_id, contact_id: match.contact_id, match_status: match.match_status },
        }).catch((hydrateErr) =>
            log.warn({ err: hydrateErr, camp_id: canonical.campaignId, sender: from_email }, 'Thread hydration failed'),
        );
    }

    log.info({ camp_id: canonical.campaignId, sender: from_email, match_status: match.match_status, label: canonical.label }, 'Webhook processed successfully');
    res.status(200).json({ ok: true });
}

function handleWebhookError(err: unknown, res: Response, next: NextFunction): void {
    if (err instanceof AppError) return next(err);
    log.error({ err }, 'Unexpected webhook processing error');
    res.status(500).json({
        error: 'Unexpected error processing webhook',
        code: 'WEBHOOK_UNEXPECTED_ERROR',
        hint: 'An unexpected server error occurred. Check server logs for details.',
    });
}

// POST /api/webhooks/plusvibe — single multi-tenant webhook.
// One global URL for all tenants; each event is routed to the right tenant by its
// campaign id (camp_id → plusvibe_campaigns.tenant_id).
router.post(
    '/plusvibe',
    verifyWebhookSecret,
    validateBody(webhookPayloadSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const campId = (req.body.camp_id ?? null) as string | null;
            const resolved = await resolveCampaignTenant(campId);

            switch (resolved.status) {
                case 'assigned':
                    await processPlusvibeInbound(req, res, resolved.tenantId);
                    return;
                case 'unassigned':
                    // Known campaign with no matching prefix rule yet — skip; the reply is
                    // backfilled when a prefix rule later assigns it (recomputeCampaignAssignments).
                    log.info({ camp_id: campId }, 'Webhook for unassigned campaign — skipped (backfilled on prefix-rule assign)');
                    res.status(200).json({ ok: true, skipped: 'unassigned' });
                    return;
                case 'unknown':
                    // Campaign not in our cache yet — pull it in so an admin can assign it.
                    log.info({ camp_id: campId }, 'Webhook for unknown campaign — triggering campaign sync');
                    syncCampaignsDebounced().catch((e) => log.warn({ err: e }, 'Debounced campaign sync failed'));
                    res.status(200).json({ ok: true, skipped: 'unknown_campaign' });
                    return;
                case 'missing':
                default:
                    log.warn('Webhook missing camp_id — cannot route to a tenant');
                    res.status(200).json({ ok: true, skipped: 'no_camp_id' });
                    return;
            }
        } catch (err) {
            handleWebhookError(err, res, next);
        }
    },
);

export default router;
