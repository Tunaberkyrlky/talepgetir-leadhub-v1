import 'dotenv/config';
import { supabaseAdmin } from '../src/lib/supabase.js';

async function run() {
    const { data: tenant, error } = await supabaseAdmin
        .from('tenants')
        .select('id, name')
        .eq('name', 'Acme Corp')
        .single();

    if (error) {
        console.error("Acme Corp bulunamadı:", error.message);
    } else {
        console.log("Acme Corp Tenant ID:", tenant.id);

        // Also insert a company "Tech Solutions" and a contact to match later
        const { data: company, error: compErr } = await supabaseAdmin
            .from('companies')
            .upsert({
                id: '00000000-0000-0000-0000-000000000001',
                tenant_id: tenant.id,
                name: 'Tech Solutions',
                company_email: 'info@techsolutions.com'
            }, { onConflict: 'id' })
            .select().single();

        const { data: contact, error: contErr } = await supabaseAdmin
            .from('contacts')
            .upsert({
                id: '00000000-0000-0000-0000-000000000002',
                tenant_id: tenant.id,
                company_id: '00000000-0000-0000-0000-000000000001',
                first_name: 'Ahmet',
                last_name: 'Yılmaz',
                email: 'ahmet@techsolutions.com'
            }, { onConflict: 'id' })
            .select().single();

        console.log("Mock data inserted.");
    }
    process.exit(0);
}
run();
