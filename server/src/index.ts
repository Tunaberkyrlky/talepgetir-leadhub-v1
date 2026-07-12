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
import tasksRoutes from './routes/tasks.js';
import leadsRoutes from './routes/leads/index.js';
import leadIntakeRoutes from './routes/leads/intake.js';
import assetsRoutes from './routes/assets/index.js';
import automationsRoutes from './routes/automations/index.js';
import emailRepliesRoutes from './routes/email-replies.js';
import plusvibeRoutes from './routes/plusvibe.js';
import webhooksRoutes from './routes/webhooks.js';
import feedbackRoutes from './routes/feedback.js';
import attachmentTemplatesRoutes from './routes/attachment-templates.js';
import campaignRoutes from './routes/campaigns.js';
import emailConnectionRoutes from './routes/email-connections.js';
import trackingRoutes from './routes/tracking.js';
import researchRoutes from './routes/research/index.js';
import linkedinRoutes from './routes/linkedin/index.js';
import linkedinCaptureRoutes from './routes/linkedin/capture.js';
import coldcallRoutes from './coldcall/routes/index.js';
import coldcallWebhookRoutes from './coldcall/routes/webhooks.js';
import { startCampaignScheduler } from './lib/campaignScheduler.js';
import { startImapPollingScheduler } from './lib/imapPollingScheduler.js';

const app = express();
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

// ── Public lead intake — mounted BEFORE the global 10mb JSON parser (P1-2) ────
// A website form is cookie-less (slug-authed) and must never be able to push a
// large body through the general 10mb parser. Its own tight chain runs first,
// here after CORS but ahead of express.json: per-IP limiter → route-local 50kb
// JSON parser → handler, so an oversized body is rejected at 50kb and never
// parsed at 10mb. Tenant is derived from the resolved form row, not req.tenantId.
const leadIntakeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many intake requests' },
});
app.use('/api/lead-intake', leadIntakeLimiter, express.json({ limit: '50kb' }), leadIntakeRoutes);

// Asset telemetry ingest is a tiny event body — cap it at 16kb BEFORE the global 10mb
// parser (same pre-parser pattern as lead intake). This just parses the body; auth,
// tenant scoping, and the handler stay on the assets router mounted below. The path
// pattern matches POST /api/assets/:id/events for any asset id.
app.use('/api/assets/:id/events', express.json({ limit: '16kb' }));

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

// LinkedIn cookie capture is UNAUTHENTICATED (token-authed) — rate-limit it hard.
const linkedinCaptureLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many capture requests' },
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
            res.status(503).json({ status: 'degraded', database: 'unreachable', timestamp: new Date().toISOString() });
            return;
        }
        res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
    } catch {
        res.status(503).json({ status: 'degraded', database: 'unreachable', timestamp: new Date().toISOString() });
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
app.use('/api/webhooks/coldcall', webhookLimiter, coldcallWebhookRoutes);
app.use('/api/webhooks', webhookLimiter, webhooksRoutes);

// LinkedIn cookie capture — public, authenticated by a single-use link token
// (the MV3 extension can't send the session cookie cross-site). No authMiddleware.
// MUST precede the protected /api/linkedin mount below (Express matches in order).
app.use('/api/linkedin/capture', linkedinCaptureLimiter, linkedinCaptureRoutes);

// (Lead intake is mounted ABOVE the global JSON parser — see the leadIntakeLimiter
// block near cookieParser — so its 50kb body cap runs before express.json's 10mb.)

// Protected routes — auth middleware applied
app.use('/api/companies', authMiddleware, dataFilter, companiesRoutes);
app.use('/api/contacts', authMiddleware, dataFilter, contactsRoutes);
app.use('/api/import', authMiddleware, importLimiter, importRoutes);
app.use('/api/filter-options', authMiddleware, filterOptionsRoutes);
app.use('/api/tenants', authMiddleware, tenantsRoutes);
app.use('/api/settings', authMiddleware, settingsRoutes);
app.use('/api/statistics', authMiddleware, statisticsRoutes);
app.use('/api/admin', authMiddleware, requireRole('superadmin'), adminRoutes);
app.use('/api/activities', authMiddleware, dataFilter, activitiesRoutes);
app.use('/api/tasks', authMiddleware, tasksRoutes);
app.use('/api/leads', authMiddleware, leadsRoutes);
app.use('/api/assets', authMiddleware, assetsRoutes);
// Automation run inspector (read-only). The runtime worker stays flag-gated OFF;
// this only READS runs / actions / messages for the tenant (v3 Phase 5).
app.use('/api/automations', authMiddleware, automationsRoutes);
app.use('/api/email-replies', authMiddleware, dataFilter, emailRepliesRoutes);
app.use('/api/plusvibe/import-replies', authMiddleware, plusvibeImportLimiter);
app.use('/api/plusvibe', authMiddleware, dataFilter, plusvibeRoutes);
app.use('/api/feedback', authMiddleware, feedbackRoutes);
app.use('/api/attachment-templates', authMiddleware, attachmentTemplatesRoutes);
app.use('/api/campaigns', authMiddleware, campaignRoutes);
app.use('/api/email-connections', authMiddleware, emailConnectionRoutes);

// TG-Research module (isolated). Auth only for now; tier/quota gating arrives
// with the billing slice. The module never touches CRM tables — handoff is
// one-way via importProcessor (F2), not wired in the skeleton.
app.use('/api/research', authMiddleware, researchRoutes);

// TG-LinkedIn module (isolated). Auth only for now; caps/limits arrive in Faz 3.
// The public capture endpoint is mounted above, BEFORE authMiddleware.
app.use('/api/linkedin', authMiddleware, linkedinRoutes);

// Cold Call module (isolated — server/src/coldcall/). Tek dokunuş bu mount +
// yukarıdaki webhook mount'udur; ayrıntı için coldcall/routes/index.ts.
app.use('/api/coldcall', authMiddleware, coldcallRoutes);

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
        'PLUSVIBE_WEBHOOK_SECRET is not set — the PlusVibe webhook endpoints (/api/webhooks/plusvibe and the legacy /api/webhooks/plusvibe/:tenantId) will reject all requests with 503. ' +
        'Set this variable to enable PlusVibe webhook ingestion.'
    );
}

app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'TG Core API started');
    startCampaignScheduler();
    startImapPollingScheduler();
});

export default app;
