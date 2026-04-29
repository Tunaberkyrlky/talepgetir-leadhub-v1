import { PostHog } from 'posthog-node';

const posthog = new PostHog(process.env.POSTHOG_API_KEY!, {
    host: process.env.POSTHOG_HOST,
    enableExceptionAutocapture: true,
});

process.on('SIGINT', async () => {
    await posthog.shutdown();
});
process.on('SIGTERM', async () => {
    await posthog.shutdown();
});

export default posthog;
