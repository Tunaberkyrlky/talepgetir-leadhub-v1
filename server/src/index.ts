import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import pinoHttp from 'pino-http';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

// Load env for local development (Railway/Vercel inject env vars directly)
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

import logger from './lib/logger.js';
import { supabaseAdmin } from './lib/supabase.js';
import { authMiddleware, requireRole } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { dataFilter } from './middleware/dataFilter.js';
import authRoutes from './routes/auth.js';
import companiesRoutes from './routes/companies.js';
import contactsRoutes from './routes/contacts.js';
import importRoutes from './routes/import.js';
import filterOptionsRoutes from './routes/filter-options.js';
import tenantsRoutes from './routes/tenants.js';
import statisticsRoutes from './routes/statistics.js';
import adminRoutes from './routes/admin.js';
import settingsRoutes from './routes/settings.js';
import activitiesRoutes from './routes/activities.js';
import emailRepliesRoutes from './routes/email-replies.js';
import plusvibeRoutes from './routes/plusvibe.js';
import webhooksRoutes from './routes/webhooks.js';
import feedbackRoutes from './routes/feedback.js';
import attachmentTemplatesRoutes from './routes/attachment-templates.js';
import campaignRoutes from './routes/campaigns.js';
import emailConnectionRoutes from './routes/email-connections.js';
import trackingRoutes from './routes/tracking.js';
import { startCampaignScheduler } from './lib/campaignScheduler.js';
import { startImapPollingScheduler } from './lib/imapPollingScheduler.js';
import { startDailyDigestScheduler } from './lib/dailyDigestScheduler.js';
import { getHeartbeatsPublic } from './lib/heartbeat.js';

// App version — read once at startup. Works in dev (tsx: __dirname=server/src) and
// prod (tsc: __dirname=server/dist); package.json sits one level up in both.
// Surfaced at /api/health so "is the new code actually live?" is answerable.
let APP_VERSION = 'unknown';
try {
    APP_VERSION = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    ).version || 'unknown';
} catch { /* leave 'unknown' */ }
const STARTED_AT = new Date().toISOString();

// ── Global crash safety net ──────────────────────────────────────────────
// Long-lived process: a single escaped async error must not silently kill it.
// unhandledRejection: log and keep serving (Node's default since v15 is to
// crash the process). uncaughtException: state may be corrupt — log fatal and
// exit(1); Railway's ON_FAILURE restart policy brings the service back up.
process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection — continuing');
});
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — exiting for a clean restart');
    process.exit(1);
});

const app = express();
// Behind Railway's edge proxy: trust exactly one hop so req.ip is the real client
// IP (from X-Forwarded-For) instead of the proxy's. Without this, per-IP rate
// limiting collapses to a single shared bucket for all users. `1` (not `true`)
// keeps it safe from X-Forwarded-For spoofing. No code reads req.secure/protocol,
// so there are no cookie/redirect side effects.
app.set('trust proxy', 1);
const PORT = process.env.PORT || process.env.API_PORT || 3001;

// Compression (before all routes for smaller responses)
// Skip compression for SSE endpoints — buffering breaks streaming
app.use(compression({
    filter: (req, res) => {
        if (req.url.includes('/geocode')) return false;
        return compression.filter(req, res);
    },
}));

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'window-management=(), protocol-handler=()');
    next();
});
// Echo request id back to the client so bug reports can quote a correlation token.
// Accepts an upstream X-Request-ID if present (eg. from a CDN); otherwise mints one.
app.use((req: any, res, next) => {
    const incoming = req.headers['x-request-id'];
    const reqId = (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128)
        ? incoming
        : randomUUID();
    req.id = reqId;
    res.setHeader('X-Request-ID', reqId);
    next();
});

app.use(pinoHttp({
    logger,
    genReqId: (req: any) => req.id,
    customLogLevel: (req: any, res: any, err: any) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        // Quiet noise: health checks silenced, read-only GETs to debug (hidden at LOG_LEVEL=info)
        if (req.url === '/api/health') return 'silent';
        if (req.method === 'GET') return 'debug';
        return 'info';
    },
    customSuccessMessage: (req: any, res: any, responseTime: any) =>
        `${req.method} ${req.url} ${res.statusCode} ${responseTime}ms [${req.id}]`,
    customErrorMessage: (req: any, res: any, err: any) =>
        `${req.method} ${req.url} ${res.statusCode} — ${err.message} [${req.id}]`,
    serializers: {
        req: () => undefined as never,
        res: () => undefined as never,
    },
}));
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? (process.env.CLIENT_URL ? [process.env.CLIENT_URL] : false)
        : (origin, callback) => {
            // Allow any localhost port in development (Vite may pick 5173, 5174, etc.)
            if (!origin || /^http:\/\/localhost:\d+$/.test(origin)) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
    credentials: true,
}));
app.use(cookieParser());
app.use(express.json({
    limit: '10mb',
    // Capture raw body buffer so webhook HMAC verification can re-read it
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
}));

// Rate limiters
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
});

const importLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many import requests, please try again later' },
});

const generalLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
});

const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many webhook requests' },
});

const trackingLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 200,
    standardHeaders: false,
    legacyHeaders: false,
    // Tracking endpoints return GIF/redirect — no JSON error body
});

const plusvibeImportLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many PlusVibe import requests, please try again later' },
});

// Dedicated caps for the compute-heavy endpoints (stats aggregation, campaign
// send/enroll, inbox thread queries). Generous — sits under the general 300/min
// and only trips on abuse/runaway polling, not normal heavy use. Per-IP (needs
// trust proxy, set above).
const statisticsLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
});

const emailRepliesLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
});

const campaignsLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
});

// Apply general rate limit to all API routes
app.use('/api', generalLimiter);

// Health check (no auth) — tests HTTP liveness and Supabase connectivity
app.get('/api/health', async (_req, res) => {
    try {
        // Lightweight Supabase ping: count one row from tenants (0 rows is fine, error is not)
        const { error } = await supabaseAdmin
            .from('tenants')
            .select('id', { count: 'exact', head: true });
        if (error) {
            res.status(503).json({ status: 'degraded', database: 'unreachable', version: APP_VERSION, startedAt: STARTED_AT, timestamp: new Date().toISOString() });
            return;
        }
        res.json({ status: 'ok', database: 'connected', version: APP_VERSION, startedAt: STARTED_AT, schedulers: getHeartbeatsPublic(), timestamp: new Date().toISOString() });
    } catch {
        res.status(503).json({ status: 'degraded', database: 'unreachable', version: APP_VERSION, startedAt: STARTED_AT, timestamp: new Date().toISOString() });
    }
});

// Auth routes — strict rate limit on login/refresh
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/refresh', authLimiter);
app.use('/api/auth', authRoutes);

// Tracking routes — public (email open pixel, click redirect, unsubscribe)
app.use('/api/t', trackingLimiter, trackingRoutes);
app.use('/api/unsubscribe', trackingLimiter, trackingRoutes);

// Webhook routes — public, validated by their own secret
app.use('/api/webhooks', webhookLimiter, webhooksRoutes);

// Protected routes — auth middleware applied
app.use('/api/companies', authMiddleware, dataFilter, companiesRoutes);
app.use('/api/contacts', authMiddleware, dataFilter, contactsRoutes);
app.use('/api/import', authMiddleware, importLimiter, importRoutes);
app.use('/api/filter-options', authMiddleware, filterOptionsRoutes);
app.use('/api/tenants', authMiddleware, tenantsRoutes);
app.use('/api/settings', authMiddleware, settingsRoutes);
app.use('/api/statistics', authMiddleware, statisticsLimiter, statisticsRoutes);
app.use('/api/admin', authMiddleware, requireRole('superadmin'), adminRoutes);
app.use('/api/activities', authMiddleware, dataFilter, activitiesRoutes);
app.use('/api/email-replies', authMiddleware, emailRepliesLimiter, dataFilter, emailRepliesRoutes);
app.use('/api/plusvibe/import-replies', authMiddleware, plusvibeImportLimiter);
app.use('/api/plusvibe', authMiddleware, dataFilter, plusvibeRoutes);
app.use('/api/feedback', authMiddleware, feedbackRoutes);
app.use('/api/attachment-templates', authMiddleware, attachmentTemplatesRoutes);
app.use('/api/campaigns', authMiddleware, campaignsLimiter, campaignRoutes);
app.use('/api/email-connections', authMiddleware, emailConnectionRoutes);

// Nango OAuth custom callback — Google, redirect URI'nin bizim sahip olduğumuz
// (ve Search Console'da doğrulayabildiğimiz) bir domain'de olmasını ister. Nango'nun
// kendi callback'i api.nango.dev'de olduğu için doğrulanamaz; bu yüzden Google'ı buraya
// (core.tibexa.com/oauth-callback) yönlendirip, tüm query paramlarını (code, state…)
// koruyarak Nango'nun callback'ine 308 ile geçiyoruz.
// Bu URL hem Google Cloud "Authorized redirect URIs" hem de Nango "Environment
// Settings → Callback URL" alanına yazılmalı. SPA fallback'ten ÖNCE durmalı.
const NANGO_CALLBACK_URL = process.env.NANGO_CALLBACK_URL || 'https://api.nango.dev/oauth/callback';
app.get('/oauth-callback', (req, res) => {
    const qIndex = req.originalUrl.indexOf('?');
    const qs = qIndex >= 0 ? req.originalUrl.slice(qIndex) : '';
    res.redirect(308, `${NANGO_CALLBACK_URL}${qs}`);
});

// Serve static client files in production (Railway/non-Vercel)
if (!process.env.VERCEL) {
    const clientDist = path.resolve(__dirname, '../../client/dist');
    if (fs.existsSync(path.join(clientDist, 'index.html'))) {
        app.use(express.static(clientDist));
        // SPA fallback — serve index.html for all non-API routes
        app.get(/^(?!\/api).*/, (_req, res) => {
            res.sendFile(path.join(clientDist, 'index.html'));
        });
    }
}

// Error handler (must be last)
app.use(errorHandler);

// Warn about missing PlusVibe integration env vars at startup
if (!process.env.PLUSVIBE_WEBHOOK_SECRET) {
    logger.warn(
        'PLUSVIBE_WEBHOOK_SECRET is not set — the PlusVibe webhook endpoint (/api/webhooks/plusvibe) will reject all requests with 503. ' +
        'Set this variable to enable PlusVibe webhook ingestion.'
    );
}

app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'TG Core API started');
    startCampaignScheduler();
    startImapPollingScheduler();
    startDailyDigestScheduler();
});

export default app;
