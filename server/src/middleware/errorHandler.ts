import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../lib/logger.js';
import posthog from '../lib/posthog.js';

const log = createLogger('errorHandler');

// Custom error class with status code. An optional machine-readable `code`
// lets clients branch on specific app errors (e.g. closing_report_required)
// without string-matching the human message.
export class AppError extends Error {
    statusCode: number;
    code?: string;

    constructor(message: string, statusCode: number, code?: string) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.name = 'AppError';
    }
}

/** Truncate large strings to keep log payloads bounded. */
function truncate(value: unknown, max = 500): unknown {
    if (typeof value !== 'string') return value;
    return value.length > max ? `${value.slice(0, max)}…(truncated ${value.length - max})` : value;
}

function summarizeBody(body: unknown): unknown {
    if (!body || typeof body !== 'object') return body;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        out[k] = truncate(v);
    }
    return out;
}

export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    _next: NextFunction
): void {
    const anyReq = req as any;
    const requestId = (anyReq.id as string) ?? (res.getHeader('X-Request-ID') as string) ?? null;
    const statusCode = err instanceof AppError ? err.statusCode : 500;

    const context = {
        err,
        request_id: requestId,
        user_id: anyReq.user?.id ?? null,
        user_email: anyReq.user?.email ?? null,
        tenant_id: anyReq.tenantId ?? null,
        role: anyReq.user?.role ?? null,
        method: req.method,
        url: req.originalUrl ?? req.url,
        query: req.query,
        body: summarizeBody(req.body),
        status: statusCode,
    };

    // 4xx are warnings (user/input errors), 5xx are errors (server faults)
    if (statusCode >= 500) log.error(context, err.message);
    else log.warn(context, err.message);

    // PostHog: only capture 5xx (real exceptions); 4xx are expected app flows
    if (statusCode >= 500) {
        const distinctId = anyReq.user?.id ?? 'anonymous';
        posthog.captureException(err, distinctId, {
            request_id: requestId,
            tenant_id: anyReq.tenantId ?? null,
            method: req.method,
            url: req.originalUrl ?? req.url,
            status: statusCode,
        });
    }

    if (err instanceof AppError) {
        res.status(err.statusCode).json({
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
            request_id: requestId,
        });
        return;
    }

    // Don't leak internal error details in production
    const message =
        process.env.NODE_ENV === 'production'
            ? 'Something went wrong. Please try again.'
            : err.message;

    res.status(500).json({
        error: message,
        request_id: requestId,
    });
}
