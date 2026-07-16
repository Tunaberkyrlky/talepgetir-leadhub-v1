import { createHmac } from 'crypto';
import { Router, Request, Response } from 'express';
import { resolveUsers, ownerDisplayName } from '../lib/userResolver.js';

const router = Router();

/**
 * Returns a Secure Mode identity for the authenticated visitor. The Tawk API key
 * never leaves the server. If it is absent, the client intentionally falls back to
 * anonymous chat instead of sending spoofable PII.
 */
router.get('/identity', async (req: Request, res: Response): Promise<void> => {
    const user = req.user;
    const secret = process.env.TAWK_API_KEY;
    if (!user || !secret) {
        res.json({ identity: null });
        return;
    }

    const resolved = (await resolveUsers([user.id])).get(user.id);
    const name = ownerDisplayName(resolved) || user.email.split('@')[0] || 'TG Core user';
    const hash = createHmac('sha256', secret).update(user.email).digest('hex');

    res.setHeader('Cache-Control', 'no-store');
    res.json({
        identity: {
            name,
            email: user.email,
            hash,
        },
    });
});

export default router;
