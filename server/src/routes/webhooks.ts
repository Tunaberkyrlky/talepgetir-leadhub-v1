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
