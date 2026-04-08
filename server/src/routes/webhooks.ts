import { timingSafeEqual, createHmac } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { validateBody, webhookPayloadSchema } from '../lib/validation.js';
import { matchSenderEmail, advanceCompanyStageOnMatch } from '../lib/emailMatcher.js';

const log = createLogger('route:webhooks');
const router = Router();

const WEBHOOK_SECRET = process.env.PLUSVIBE_WEBHOOK_SECRET;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Trim raw_payload to prevent storing oversized bodies */
const MAX_RAW_PAYLOAD_SIZE = 10_000; // characters
function sanitizePayload(body: unknown): unknown {
    const json = JSON.stringify(body);
    if (json.length > MAX_RAW_PAYLOAD_SIZE) {
        return { _truncated: true, _size: json.length };
    }
    return body;
}

// POST /api/webhooks/plusvibe/:tenantId — receive PlusVibe reply events
// Each tenant configures their own webhook URL with their tenant UUID in the path.
router.post(
    '/plusvibe/:tenantId',
    verifyWebhookSecret,
    (req: Request, _res: Response, next: NextFunction) => {
        log.info({ body: sanitizePayload(req.body), headers: { contentType: req.headers['content-type'] } }, 'Webhook raw payload received');
        next();
    },
    validateBody(webhookPayloadSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.params.tenantId as string;

            if (!UUID_RE.test(tenantId)) {
                res.status(400).json({
                    error: 'Invalid tenant ID',
                    code: 'INVALID_TENANT_ID',
                    hint: 'The tenantId URL segment must be a valid UUID.',
                });
                return;
            }

            // PlusVibe field names: from_email, camp_id, campaign_name, text_body, replied_date
            const { from_email, camp_id, campaign_name, text_body, replied_date } = req.body;

            // Match sender email to contact/company within this tenant
            let match;
            try {
                match = await matchSenderEmail(from_email, tenantId);
            } catch (matchErr) {
                log.error({ err: matchErr, from_email }, 'Email matching failed — database may be unavailable');
                res.status(503).json({
                    error: 'Email matching service unavailable',
                    code: 'EMAIL_MATCH_FAILED',
                    hint: 'Database lookup failed. Retry the webhook later.',
                });
                return;
            }

            // Insert email reply
            // Deduplication: partial unique index on (campaign_id, sender_email, replied_at) WHERE campaign_id IS NOT NULL
            const row = {
                tenant_id: match.tenant_id,
                campaign_id: camp_id || null,
                campaign_name: campaign_name || null,
                sender_email: from_email.toLowerCase().trim(),
                reply_body: text_body || null,
                replied_at: replied_date || new Date().toISOString(),
                company_id: match.company_id,
                contact_id: match.contact_id,
                match_status: match.match_status,
                read_status: 'unread',
                raw_payload: sanitizePayload(req.body),
            };

            const { error } = await supabaseAdmin
                .from('email_replies')
                .insert(row);

            if (error) {
                // Partial unique index handles dedup — treat unique violation as success
                if (error.code === '23505') {
                    log.info({ camp_id, sender: from_email }, 'Duplicate webhook ignored');
                    res.status(200).json({ ok: true, duplicate: true });
                    return;
                }
                log.error({ err: error, camp_id, sender: from_email }, 'Failed to insert email reply into database');
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

            log.info({ camp_id, sender: from_email, match_status: match.match_status }, 'Webhook processed successfully');
            res.status(200).json({ ok: true });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Unexpected webhook processing error');
            res.status(500).json({
                error: 'Unexpected error processing webhook',
                code: 'WEBHOOK_UNEXPECTED_ERROR',
                hint: 'An unexpected server error occurred. Check server logs for details.',
            });
        }
    }
);

export default router;
