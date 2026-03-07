import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient('http://127.0.0.1:54321', process.env.SUPABASE_SERVICE_ROLE_KEY);
// actually the URL is process.env.VITE_SUPABASE_URL
const url = process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data, error } = await sb.from('tenants').select('*');
  console.log("Tenants count:", data?.length);
  console.log(data);
  const { data: mem, error: merr } = await sb.from('memberships').select('*');
  console.log("Memberships:", mem);
}
run();
