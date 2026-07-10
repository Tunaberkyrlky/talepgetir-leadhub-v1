/**
 * Tracking Routes — Open pixel, click redirect, unsubscribe
 * Auth-free public endpoints. Register BEFORE auth middleware in index.ts.
 */

import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { verifyTrackingToken } from '../lib/mailTracking.js';
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
        const target = verifyTrackingToken(req.params.token);
        if (target) {
            await supabaseAdmin.from('campaign_email_events').insert({
                ...(target.kind === 'reply'
                    ? { email_reply_id: target.id }
                    : { activity_id: target.id }),
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
        const target = verifyTrackingToken(req.params.token);
        if (!target) { res.status(400).send('Invalid tracking link'); return; }

        await supabaseAdmin.from('campaign_email_events').insert({
            ...(target.kind === 'reply'
                ? { email_reply_id: target.id }
                : { activity_id: target.id }),
            event_type: 'click',
            event_data: { url: targetUrl.slice(0, 2000), ip: req.ip },
        });
    } catch (err) {
        log.warn({ err }, 'Click tracking error');
        res.status(400).send('Invalid tracking link'); return;
    }

    res.redirect(302, targetUrl);
});

// ── Unsubscribe (HMAC token'lı, idempotent) ────────────────────────────────
// GET  = tarayıcıdan gelen manuel abonelikten-çıkma (HTML döner).
// POST = RFC 8058 tek-tık (mail istemcisi List-Unsubscribe-Post ile tetikler).
// İkisi de aynı token şemasını doğrular; forge'a karşı HMAC korur.

type UnsubResult = 'ok' | 'already' | 'invalid' | 'notfound' | 'error';

async function unsubscribeByToken(token: string): Promise<UnsubResult> {
    let target: ReturnType<typeof verifyTrackingToken>;
    try {
        target = verifyTrackingToken(token);
    } catch {
        return 'invalid';
    }
    if (!target || target.kind === 'reply') return 'invalid';
    const enrollmentId = target.id;

    try {
        const { data: enrollment } = await supabaseAdmin
            .from('campaign_enrollments')
            .select('id, status')
            .eq('id', enrollmentId)
            .single();

        if (!enrollment) return 'notfound';
        if (enrollment.status !== 'active') return 'already'; // idempotent: tekrar çağrı no-op

        await supabaseAdmin
            .from('campaign_enrollments')
            .update({ status: 'unsubscribed', next_scheduled_at: null })
            .eq('id', enrollmentId);

        log.info({ enrollmentId }, 'Unsubscribed');
        return 'ok';
    } catch (err) {
        log.error({ err, enrollmentId }, 'Unsubscribe error');
        return 'error';
    }
}

// ── GET /api/unsubscribe/:token ────────────────────────────────────────────

router.get('/:token', async (req: Request<{ token: string }>, res: Response): Promise<void> => {
    const html = (msg: string) => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Unsubscribe</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8fafc;">
<div style="text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);max-width:400px;">
<p style="font-size:16px;color:#334155;">${msg}</p></div></body></html>`;

    switch (await unsubscribeByToken(req.params.token)) {
        case 'invalid': res.status(400).send(html('Invalid or expired link.')); return;
        case 'notfound': res.status(404).send(html('Subscription not found.')); return;
        case 'already': res.send(html('You are already unsubscribed.')); return;
        case 'ok': res.send(html('You have been unsubscribed successfully.')); return;
        default: res.status(500).send(html('Something went wrong.')); return;
    }
});

// ── POST /api/unsubscribe/:token — RFC 8058 tek-tık ────────────────────────
// Mail istemcisi `List-Unsubscribe=One-Click` gövdesiyle POST atar. Auth yok;
// güvenlik HMAC token doğrulamasından gelir. Gövdeyi okumaya gerek yok (token yeter).

router.post('/:token', async (req: Request<{ token: string }>, res: Response): Promise<void> => {
    switch (await unsubscribeByToken(req.params.token)) {
        case 'invalid': res.status(400).json({ unsubscribed: false, error: 'invalid' }); return;
        case 'error': res.status(500).json({ unsubscribed: false, error: 'error' }); return;
        // ok / already / notfound → idempotent başarı
        default: res.status(200).json({ unsubscribed: true }); return;
    }
});

function isSafeUrl(url: string): boolean {
    try { const p = new URL(url); return p.protocol === 'http:' || p.protocol === 'https:'; }
    catch { return false; }
}

export default router;
