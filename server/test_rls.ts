import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '../.env') });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

import jwt from 'jsonwebtoken';

async function run() {
    const { data: users, error } = await supabase.auth.admin.listUsers();
    if (error || !users?.users?.length) {
        console.error('No users found', error);
        return;
    }
    const user = users.users[0];
    
    // Instead of generating a JWT, we can just log the specific dataQuery error directly
    // by patching `routes/companies.ts` to log it! Wait, I already did that, but the user is blind to it because their npm run dev was already running, AND they just pasted the SAME error from before it restarted.
    
    // Actually, I can just query `dataQuery` from local script using RLS!
    // To do this I can mock the accessToken using the Supabase JWT secret.
    const secret = "SUPER_SECRET_KEY"; // Supabase doesn't expose JWT secret to DB over API except in dashboard
    
    // Instead of doing complicated things, I'll bypass this logic and just run the query as normal with admin client, but with an explicit "order" test!
    const { error: dataError } = await supabase
        .from('companies')
        .select('id, name, website, location, industry, employee_size, product_services, product_portfolio, linkedin, company_phone, company_email, email_status, stage, company_summary, next_step, assigned_to, fit_score, custom_field_1, custom_field_2, custom_field_3, contact_count, created_at, updated_at')
        .order('updated_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .range(0, 24);
        
    console.log('Test order query error:', dataError);
}
run();
