/**
 * TG-Research worker — process entrypoint.
 *
 * Run as its own service (separate from the API), e.g. on Railway:
 *   dev:   npm run dev:worker   --workspace=server
 *   prod:  npm run start:worker --workspace=server
 *
 * Env is loaded the same way as lib/supabase.ts (cwd-relative ../.env); on
 * Railway/Vercel env vars are injected and the file is simply absent.
 * The dotenv.config() call sits between imports on purpose — TS emits CommonJS
 * here (package is CJS), so this runs before ./runner.js (→ supabase) is required.
 */
import dotenv from 'dotenv';
import path from 'path';

if (!process.env.VERCEL) {
    // Same resolution as lib/supabase.ts: relative to the server/ workspace cwd.
    dotenv.config({ path: path.join(process.cwd(), '..', '.env') });
}

import { createLogger } from '../../logger.js';
import { ResearchWorker } from './runner.js';

const log = createLogger('research:worker:main');

const worker = new ResearchWorker({
    concurrency: Number(process.env.RESEARCH_WORKER_CONCURRENCY) || 4,
});

worker.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown signal received');
    try {
        await worker.stop();
    } catch (err) {
        log.error({ err }, 'error during shutdown');
    } finally {
        process.exit(0);
    }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'unhandledRejection in worker');
});
