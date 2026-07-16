import { PostHog } from 'posthog-node';
import { AsyncLocalStorage } from 'async_hooks';
import type { Request, Response, NextFunction } from 'express';

// Keyless processes (research worker) must not crash at import; the SDK asserts a
// non-empty key even when disabled, so a placeholder key + disabled carries the no-op.
const apiKey = process.env.POSTHOG_API_KEY;

const client = new PostHog(apiKey || 'phc_disabled', {
    host: process.env.POSTHOG_HOST,
    enableExceptionAutocapture: true,
    disabled: !apiKey,
});

// Product analytics consent follows the entire asynchronous Express request.
// Route modules keep using this shared facade, while calls outside a consented
// request are denied by default. This prevents server-side events from bypassing
// the user's client-side PostHog opt-out.
const consentContext = new AsyncLocalStorage<boolean>();

export function analyticsConsentMiddleware(req: Request, _res: Response, next: NextFunction): void {
    consentContext.run(req.get('x-analytics-consent') === 'granted', next);
}

function isAllowed(): boolean {
    return consentContext.getStore() === true;
}

const posthog = {
    capture(...args: Parameters<PostHog['capture']>) {
        if (isAllowed()) return client.capture(...args);
    },
    identify(...args: Parameters<PostHog['identify']>) {
        if (isAllowed()) return client.identify(...args);
    },
    captureException(...args: Parameters<PostHog['captureException']>) {
        if (isAllowed()) return client.captureException(...args);
    },
};

process.on('SIGINT', async () => {
    await client.shutdown();
});
process.on('SIGTERM', async () => {
    await client.shutdown();
});

export default posthog;
