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

// Load env first (skip in Vercel — env vars are injected)
if (!process.env.VERCEL) {
    dotenv.config({ path: '../.env' });
}

import logger from './lib/logger.js';
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

const app = express();
const PORT = process.env.PORT || process.env.API_PORT || 3001;

// Compression (before all routes for smaller responses)
app.use(compression());

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'window-management=(), protocol-handler=()');
    next();
});
app.use(pinoHttp({
    logger,
    customSuccessMessage: (req: any, res: any, responseTime: any) =>
        `${req.method} ${req.url} ${res.statusCode} ${responseTime}ms`,
    customErrorMessage: (req: any, res: any, err: any) =>
        `${req.method} ${req.url} ${res.statusCode} — ${err.message}`,
    serializers: {
        req: () => undefined as never,
        res: () => undefined as never,
    },
}));
app.use(cors({
    origin: process.env.NODE_ENV === 'production' || process.env.VERCEL
        ? [process.env.CLIENT_URL || 'https://leadhub.app']
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
app.use(express.json({ limit: '10mb' }));

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
    limit: 100,
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

const plusvibeImportLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many PlusVibe import requests, please try again later' },
});

// Apply general rate limit to all API routes
app.use('/api', generalLimiter);

// Health check (no auth)
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes — strict rate limit on login/refresh
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/refresh', authLimiter);
app.use('/api/auth', authRoutes);

// Webhook routes — public, validated by their own secret
app.use('/api/webhooks', webhookLimiter, webhooksRoutes);

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
app.use('/api/email-replies', authMiddleware, dataFilter, emailRepliesRoutes);
app.use('/api/plusvibe/import-replies', authMiddleware, plusvibeImportLimiter);
app.use('/api/plusvibe', authMiddleware, dataFilter, plusvibeRoutes);
app.use('/api/feedback', authMiddleware, feedbackRoutes);

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
        'PLUSVIBE_WEBHOOK_SECRET is not set — the /api/webhooks/plusvibe/:tenantId endpoint will reject all requests with 503. ' +
        'Set this variable to enable PlusVibe webhook ingestion.'
    );
}

// Only listen when running standalone (not on Vercel serverless)
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'TG Core API started');
    });
}

export default app;
