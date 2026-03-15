import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import pinoHttp from 'pino-http';

// Load env first
dotenv.config({ path: '../.env' });

import logger from './lib/logger.js';
import { authMiddleware, requireRole } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import companiesRoutes from './routes/companies.js';
import contactsRoutes from './routes/contacts.js';
import importRoutes from './routes/import.js';
import filterOptionsRoutes from './routes/filter-options.js';
import tenantsRoutes from './routes/tenants.js';
import statisticsRoutes from './routes/statistics.js';
import adminRoutes from './routes/admin.js';

const app = express();
const PORT = process.env.API_PORT || 3001;

// Security middleware
app.use(helmet());
app.use(pinoHttp({
    logger,
    customSuccessMessage: (req, res, responseTime) =>
        `${req.method} ${req.url} ${res.statusCode} ${responseTime}ms`,
    customErrorMessage: (req, res, err, responseTime) =>
        `${req.method} ${req.url} ${res.statusCode} ${responseTime}ms — ${err.message}`,
    serializers: {
        req: () => undefined as never,
        res: () => undefined as never,
    },
}));
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? [process.env.CLIENT_URL || 'https://leadhub.app']
        : ['http://localhost:5173', 'http://localhost:3000'],
    credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Health check (no auth)
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes (login/signup don't need auth middleware)
app.use('/api/auth', authRoutes);

// Protected routes — auth middleware applied
app.use('/api/companies', authMiddleware, companiesRoutes);
app.use('/api/contacts', authMiddleware, contactsRoutes);
app.use('/api/import', authMiddleware, importRoutes);
app.use('/api/filter-options', authMiddleware, filterOptionsRoutes);
app.use('/api/tenants', authMiddleware, tenantsRoutes);
app.use('/api/statistics', authMiddleware, statisticsRoutes);
app.use('/api/admin', authMiddleware, requireRole('superadmin'), adminRoutes);

// Error handler (must be last)
app.use(errorHandler);

app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'LeadHub API started');
});

export default app;
