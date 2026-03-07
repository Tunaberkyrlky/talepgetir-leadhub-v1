import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import axios from 'axios';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const roleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = createClient(url, roleKey!);

async function run() {
    const userId = 'd77adea6-5b55-4319-a5b9-eb0f0b7f5ad3';
    console.log("Updating password...");
    const { error: updateError } = await sb.auth.admin.updateUserById(userId, {
        password: 'Password!123'
    });
    if (updateError) {
        console.error("Update error:", updateError);
        return;
    }

    console.log("Logging in via our api/auth/login...");
    try {
        const loginRes = await axios.post('http://localhost:3001/api/auth/login', {
            email: 'gomiva8508@pckage.com',
            password: 'Password!123'
        });

        console.log("Login user:", JSON.stringify(loginRes.data.user, null, 2));

        const token = loginRes.data.token;
        console.log("Calling /api/auth/me...");
        const meRes = await axios.get('http://localhost:3001/api/auth/me', {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        console.log("Me user:", JSON.stringify(meRes.data.user, null, 2));

    } catch (err: any) {
        console.error("Axios Error:", err.message);
        if (err.response) {
            console.error(err.response.data);
        }
    }
}
run();
