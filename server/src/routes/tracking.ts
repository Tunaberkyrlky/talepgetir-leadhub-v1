/**
 * Tracking Routes — Open pixel, click redirect, unsubscribe
 * Auth-free public endpoints. Register BEFORE auth middleware in index.ts.
 */

import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { verifyTrackingToken } from '../lib/campaignEngine.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('tracking');
const router = Router();

// 1x1 transparent GIF
const TRANSPARENT_GIF = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64',
);

// ── GET /api/t/o/:token — Open tracking pixel ─────────────────────────────

router.get('/o/:token', async (req: Request<{ token: string }>, res: Response): Promise<void> => {
    res.set({
        'Content-Type': 'image/gif',
        'Content-Length': String(TRANSPARENT_GIF.length),
        'Cache-Control': 'no-store, no-cache, must-revalidate',
    });

    try {
        const activityId = verifyTrackingToken(req.params.token);
        if (activityId) {
            await supabaseAdmin.from('campaign_email_events').insert({
                activity_id: activityId,
                event_type: 'open',
                event_data: { ip: req.ip, ua: req.get('User-Agent')?.slice(0, 200) },
            });
        }
    } catch (err) {
        log.warn({ err }, 'Open tracking error');
    }

    res.end(TRANSPARENT_GIF);
});

// ── GET /api/t/c/:token — Click tracking redirect ─────────────────────────

router.get('/c/:token', async (req: Request<{ token: string }>, res: Response): Promise<void> => {
    const targetUrl = String(req.query.url || '');
    if (!targetUrl || !isSafeUrl(targetUrl)) { res.redirect('/'); return; }

    try {
        const activityId = verifyTrackingToken(req.params.token);
        if (!activityId) { res.status(400).send('Invalid tracking link'); return; }

        await supabaseAdmin.from('campaign_email_events').insert({
            activity_id: activityId,
            event_type: 'click',
            event_data: { url: targetUrl.slice(0, 2000), ip: req.ip },
        });
    } catch (err) {
        log.warn({ err }, 'Click tracking error');
        res.status(400).send('Invalid tracking link'); return;
    }

    res.redirect(302, targetUrl);
});

// ── GET /api/unsubscribe/:token ────────────────────────────────────────────

router.get('/:token', async (req: Request<{ token: string }>, res: Response): Promise<void> => {
    const html = (msg: string) => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Unsubscribe</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8fafc;">
<div style="text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);max-width:400px;">
<p style="font-size:16px;color:#334155;">${msg}</p></div></body></html>`;

    try {
        const enrollmentId = verifyTrackingToken(req.params.token);
        if (!enrollmentId) { res.status(400).send(html('Invalid or expired link.')); return; }

        const { data: enrollment } = await supabaseAdmin
            .from('campaign_enrollments')
            .select('id, status')
            .eq('id', enrollmentId)
            .single();

        if (!enrollment) { res.status(404).send(html('Subscription not found.')); return; }

        if (enrollment.status !== 'active') {
            res.send(html('You are already unsubscribed.')); return;
        }

        await supabaseAdmin
            .from('campaign_enrollments')
            .update({ status: 'unsubscribed', next_scheduled_at: null })
            .eq('id', enrollmentId);

        log.info({ enrollmentId }, 'Unsubscribed');
        res.send(html('You have been unsubscribed successfully.'));
    } catch (err) {
        log.error({ err }, 'Unsubscribe error');
        res.status(500).send(html('Something went wrong.'));
    }
});

function isSafeUrl(url: string): boolean {
    try { const p = new URL(url); return p.protocol === 'http:' || p.protocol === 'https:'; }
    catch { return false; }
}

export default router;
