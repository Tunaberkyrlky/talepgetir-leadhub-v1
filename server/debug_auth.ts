import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!anonKey) {
    console.error("Missing SUPABASE_ANON_KEY");
    process.exit(1);
}
const sb = createClient(url, anonKey);
async function run() {
    const email = 'gomiva8508@pckage.com';
    const password = 'Password!123'; // typically default test password, if not I'll just check the logic 
    const { data, error } = await sb.auth.signInWithPassword({
        email,
        password
    });
    if (error) {
        console.error("Auth error:", error.message);
        // Since I don't know the password, let me just mock the JWT validation manually by signing a ticket?
        // No, I can just use supabaseAdmin to generate a link or modify password
    } else {
        console.log("Logged in!");
    }
}
run();
