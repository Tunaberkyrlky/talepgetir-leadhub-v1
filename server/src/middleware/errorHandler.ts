import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../lib/logger.js';
import posthog from '../lib/posthog.js';

const log = createLogger('errorHandler');

// Custom error class with status code
export class AppError extends Error {
    statusCode: number;

    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'AppError';
    }
}

export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    _next: NextFunction
): void {
    log.error({ err }, err.message);

    const distinctId = (req as any).user?.id ?? 'anonymous';
    posthog.captureException(err, distinctId);

    if (err instanceof AppError) {
        res.status(err.statusCode).json({
            error: err.message,
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
    });
}
