import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const roleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = createClient(url, roleKey!);

async function run() {
    const email = 'gomiva8508@pckage.com';

    // Bul
    const { data: users, error: listError } = await sb.auth.admin.listUsers();
    if (listError) {
        console.error("List users error:", listError.message);
        return;
    }

    const user = users.users.find(u => u.email === email);
    if (!user) {
        console.log("User not found by email:", email);
        return;
    }

    console.log("User found! ID:", user.id);
    console.log("Resetting password to: Password!123");

    const { error: updateError } = await sb.auth.admin.updateUserById(user.id, {
        password: 'Password!123',
        email_confirm: true // Just in case it's waiting for confirmation
    });

    if (updateError) {
        console.error("Update error:", updateError.message);
    } else {
        console.log("Password reset successful.");
    }
}
run();
