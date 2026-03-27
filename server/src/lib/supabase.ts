import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

if (!process.env.VERCEL) {
    dotenv.config({ path: '../.env' });
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceKey || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY)');
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
