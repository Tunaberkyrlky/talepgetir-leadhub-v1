import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const roleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!roleKey) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(url, roleKey);
async function run() {
  const { data, error } = await sb.from('tenants').select('*');
  console.log("Tenants:");
  console.dir(data, { depth: null });

  const { data: mem, error: merr } = await sb.from('memberships').select('*, user_id');
  console.log("Memberships:");
  console.dir(mem, { depth: null });

  // also check users via auth.users if possible
  const { data: users, error: uerror } = await sb.auth.admin.listUsers();
  console.log("Users (Superadmin Check):");
  users?.users.forEach(u => {
    console.log(`User: ${u.email}, app_metadata: ${JSON.stringify(u.app_metadata)}`);
  });
}
run();
