/**
 * Research-scoped Supabase admin client (service role).
 *
 * Model A (today): research shares the CRM Supabase project, so this falls back
 * to the shared SUPABASE_* env — behaviour is identical to lib/supabase.ts.
 *
 * The point is the seam: every research data query goes through
 * researchSupabaseAdmin, so if research ever moves to its own database (model B)
 * you set RESEARCH_SUPABASE_URL + RESEARCH_SUPABASE_SERVICE_ROLE_KEY and ONLY
 * this file changes — no research route/lib query needs touching.
 *
 * Note: supabase-js is a stateless HTTP client (PostgREST), NOT a connection
 * pool, so a second client to the same project costs nothing at runtime. This is
 * purely a module boundary (K1) + future-split seam, not a perf isolation.
 *
 * Auth/tenant identity still resolves against the CRM project (middleware/auth.ts
 * + lib/supabase.ts). Only research *data* flows through this client.
 */
import { createClient } from '@supabase/supabase-js';
import { createLogger } from '../logger.js';

const log = createLogger('research:supabase');

const url = process.env.RESEARCH_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceKey = process.env.RESEARCH_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
    throw new Error(
        'Missing Supabase env for research (set RESEARCH_SUPABASE_URL + RESEARCH_SUPABASE_SERVICE_ROLE_KEY, or the shared SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)'
    );
}

const dedicated = !!process.env.RESEARCH_SUPABASE_URL && process.env.RESEARCH_SUPABASE_URL !== process.env.SUPABASE_URL;
if (dedicated) {
    log.info('research is using a dedicated Supabase project (model B)');
}

export const researchSupabaseAdmin = createClient(url, serviceKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    },
});
