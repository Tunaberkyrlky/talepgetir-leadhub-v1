import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceKey || !supabaseAnonKey) {
    // Use process.stderr directly here since the logger isn't available yet at module init
    process.stderr.write('Missing Supabase environment variables. Check .env file.\n');
    process.exit(1);
}

// Admin client — uses service_role key, bypasses RLS
// ONLY use on server-side for admin operations (DB queries)
// NEVER use for auth.signInWithPassword or auth.getUser — it pollutes internal state
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    },
});

// Auth-only client — uses anon key for auth operations (signIn, getUser)
// This keeps supabaseAdmin clean for service_role DB queries
export const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    },
});

// Debug: confirm which key role is in use (dev aid, can be removed once stable)
import { createLogger } from './logger.js';
const log = createLogger('supabase');
const keyRole = supabaseServiceKey.split('.')[1]
    ? JSON.parse(Buffer.from(supabaseServiceKey.split('.')[1], 'base64').toString()).role
    : 'unknown';
log.debug({ keyRole }, 'Supabase service key loaded');

// Create a per-request client using the user's JWT token
// This client respects RLS policies
export function createUserClient(accessToken: string) {
    return createClient(supabaseUrl!, supabaseAnonKey!, {
        global: {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        },
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    });
}
