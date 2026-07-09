import { PostHog } from 'posthog-node';

// Keyless processes (research worker) must not crash at import; the SDK asserts a
// non-empty key even when disabled, so a placeholder key + disabled carries the no-op.
const apiKey = process.env.POSTHOG_API_KEY;

const posthog = new PostHog(apiKey || 'phc_disabled', {
    host: process.env.POSTHOG_HOST,
    enableExceptionAutocapture: true,
    disabled: !apiKey,
});

process.on('SIGINT', async () => {
    await posthog.shutdown();
});
process.on('SIGTERM', async () => {
    await posthog.shutdown();
});

export default posthog;
