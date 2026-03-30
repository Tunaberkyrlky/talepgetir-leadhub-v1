import 'dotenv/config';
import { supabaseAdmin } from '../src/lib/supabase.js';

async function run() {
    console.log("Starting...");
    const { data: tenant, error } = await supabaseAdmin
        .from('tenants')
        .select('id, name')
        .eq('name', 'Naturagen')
        .single();
        
    if (error) {
        console.error("Naturagen bulunamadı:", error.message);
    } else {
        console.log("Naturagen Tenant ID:", tenant.id);
        
        // Let's create a real company inside Naturagen
        const { data: company, error: compErr } = await supabaseAdmin
            .from('companies')
            .upsert({
                id: '44444444-4444-4444-4444-444444444444',
                tenant_id: tenant.id,
                name: 'Doğa Lojistik AŞ'
            }, { onConflict: 'id' })
            .select().single();
            
        console.log("Company Doğa Lojistik error?", compErr?.message);
            
        const { data: contact, error: contErr } = await supabaseAdmin
            .from('contacts')
            .upsert({
                id: '55555555-5555-5555-5555-555555555555',
                tenant_id: tenant.id,
                company_id: '44444444-4444-4444-4444-444444444444',
                first_name: 'Ayşe',
                last_name: 'Demir',
                email: 'ayse@dogalojistik.com'
            }, { onConflict: 'id' })
            .select().single();
            
        console.log("Contact Ayşe error?", contErr?.message);
        
        const { data: company2, error: compErr2 } = await supabaseAdmin
            .from('companies')
            .upsert({
                id: '66666666-6666-6666-6666-666666666666',
                tenant_id: tenant.id,
                name: 'Tarım Ürünleri Ltd',
                company_email: 'iletisim@tarimurunleri.net'
            }, { onConflict: 'id' })
            .select().single();
            
        console.log("Company Tarım Ürünleri error?", compErr2?.message);
        
        console.log("Mock companies and contacts inserted for Naturagen.");
    }
    process.exit(0);
}
run();
