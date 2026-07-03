/**
 * TG-Research standalone API — process entrypoint.
 *
 * Runs the research module as its OWN service (separate from the CRM monolith), so TG-Research
 * is fully isolated. It exposes only auth + tenant identity + /api/research — NOT the CRM API.
 *
 * Two databases, by design:
 *   • researchSupabaseAdmin → RESEARCH_SUPABASE_URL  (all research data — projects, ICPs, jobs,
 *     companies, ledger). Never prod.
 *   • supabaseAdmin (lib/supabase) → SUPABASE_URL     (PROD CRM). Used ONLY for identity/auth
 *     (memberships live in the CRM) and the export handoff, which writes qualified leads into
 *     the CRM `companies` table. This is the single bridge to TG-Core prod.
 *
 * So: research runs separately; only auth + export touch prod. Mirror of src/index.ts's
 * middleware stack, trimmed to the research surface. No CRM routes, no static client, no
 * campaign/imap schedulers.
 */
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import pinoHttp from 'pino-http';
import path from 'path';
import { randomUUID } from 'crypto';

// Load env for local dev (Railway injects env vars directly; the file is simply absent there).
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

import logger from './lib/logger.js';
import { researchSupabaseAdmin } from './lib/research/supabase.js';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import tenantsRoutes from './routes/tenants.js';
import researchRoutes from './routes/research/index.js';

const app = express();
const PORT = process.env.PORT || process.env.RESEARCH_API_PORT || 3002;

app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'window-management=(), protocol-handler=()');
    next();
});
app.use((req: any, res, next) => {
    const incoming = req.headers['x-request-id'];
    req.id = (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128) ? incoming : randomUUID();
    res.setHeader('X-Request-ID', req.id);
    next();
});
app.use(pinoHttp({
    logger,
    genReqId: (req: any) => req.id,
    customLogLevel: (req: any, res: any, err: any) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        if (req.url === '/api/health') return 'silent';
        if (req.method === 'GET') return 'debug';
        return 'info';
    },
    customSuccessMessage: (req: any, res: any, rt: any) => `${req.method} ${req.url} ${res.statusCode} ${rt}ms [${req.id}]`,
    serializers: { req: () => undefined as never, res: () => undefined as never },
}));

// CORS — allow the research UI origin(s) in prod (comma-separated RESEARCH_CLIENT_URL), any
// localhost in dev. Credentials on (httpOnly cookie auth).
const allowedOrigins = (process.env.RESEARCH_CLIENT_URL || process.env.CLIENT_URL || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? (allowedOrigins.length ? allowedOrigins : false)
        : (origin, cb) => cb(null, !origin || /^http:\/\/localhost:\d+$/.test(origin)),
    credentials: true,
}));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, please try again later' } });
const generalLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, please try again later' } });

app.use('/api', generalLimiter);

// Health — verifies the RESEARCH database is reachable (this service's primary dependency).
app.get('/api/health', async (_req, res) => {
    try {
        const { error } = await researchSupabaseAdmin.from('research_jobs').select('id', { count: 'exact', head: true });
        if (error) {
            res.status(503).json({ status: 'degraded', database: 'unreachable', timestamp: new Date().toISOString() });
            return;
        }
        res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
    } catch {
        res.status(503).json({ status: 'degraded', database: 'unreachable', timestamp: new Date().toISOString() });
    }
});

// Auth (identity resolves against the CRM/prod project) + tenant switching + the research module.
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/refresh', authLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/tenants', authMiddleware, tenantsRoutes);
app.use('/api/research', authMiddleware, researchRoutes);

app.use(errorHandler);

app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'TG-Research API started');
});

export default app;
