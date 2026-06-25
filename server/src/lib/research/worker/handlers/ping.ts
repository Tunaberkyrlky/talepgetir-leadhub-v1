/**
 * ping — skeleton smoke-test handler.
 * Proves the full loop works: API enqueues → worker claims → handler runs →
 * heartbeat/progress recorded → result written back. No external calls.
 */
import type { HandlerContext } from '../types.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:ping');

export async function pingHandler({ job, heartbeat }: HandlerContext): Promise<Record<string, unknown>> {
    const message = typeof job.payload?.message === 'string' ? job.payload.message : 'pong';
    log.info({ jobId: job.id, message }, 'ping running');

    await heartbeat({ stage: 'started' });
    // A tiny pause so progress/heartbeat updates are observable during a smoke test.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await heartbeat({ stage: 'done' });

    return {
        echo: message,
        attempt: job.attempts,
        finishedAt: new Date().toISOString(),
    };
}
