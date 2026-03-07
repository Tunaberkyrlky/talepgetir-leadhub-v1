-- ==========================================
-- SEED DATA — For development/testing only
-- ==========================================
-- NOTE: Run this AFTER creating users in Supabase Auth.
-- Replace the UUIDs below with actual user IDs from your Supabase Auth dashboard.

-- Step 1: Create test tenants
INSERT INTO tenants (id, name, slug) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Acme Corp', 'acme-corp'),
  ('b0000000-0000-0000-0000-000000000002', 'Beta Industries', 'beta-industries'),
  ('c0000000-0000-0000-0000-000000000003', 'Naturagen', 'naturagen');

-- Step 2: After creating users in Supabase Auth, create memberships
-- Replace 'USER_A_UUID' and 'USER_B_UUID' with actual user IDs
--
-- INSERT INTO memberships (user_id, tenant_id, role) VALUES
--   ('USER_A_UUID', 'a0000000-0000-0000-0000-000000000001', 'superadmin'),
--   ('USER_B_UUID', 'b0000000-0000-0000-0000-000000000002', 'ops_agent');

-- Step 3: Sample companies for Tenant A
INSERT INTO companies (tenant_id, name, website, location, industry, employee_count, stage, deal_summary, next_step) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'TechCo Ltd', 'techco.com', 'Istanbul', 'SaaS', '50-200', 'meeting_scheduled', 'Looking for 500 leads in EU market', 'Follow up call on Monday 10:00'),
  ('a0000000-0000-0000-0000-000000000001', 'DataFlow Inc', 'dataflow.io', 'Ankara', 'Fintech', '200-500', 'won', 'Data analytics partnership', 'Start onboarding process'),
  ('a0000000-0000-0000-0000-000000000001', 'CloudBase', 'cloudbase.dev', 'Izmir', 'Cloud', '10-50', 'lost', 'Cloud migration project', NULL),
  ('a0000000-0000-0000-0000-000000000001', 'GreenEnergy AS', 'greenenergy.no', 'Oslo', 'Energy', '500-1000', 'proposal_sent', 'Sustainability reporting tool', 'Wait for proposal review'),
  ('a0000000-0000-0000-0000-000000000001', 'RetailMax', 'retailmax.com', 'Berlin', 'Retail', '100-200', 'contacted', 'Inventory management integration', 'Schedule demo'),
  ('a0000000-0000-0000-0000-000000000001', 'HealthTech Plus', 'healthtechplus.com', 'London', 'Healthcare', '50-100', 'researching', 'Patient management system', 'Research their current stack'),
  ('a0000000-0000-0000-0000-000000000001', 'LogiTrans GmbH', 'logitrans.de', 'Munich', 'Logistics', '200-500', 'negotiation', 'Fleet tracking solution', 'Negotiate pricing terms'),
  ('a0000000-0000-0000-0000-000000000001', 'EduSmart', 'edusmart.co', 'Amsterdam', 'Education', '20-50', 'new', 'LMS platform integration', 'Initial research');

-- Step 4: Sample companies for Tenant B (to test isolation)
INSERT INTO companies (tenant_id, name, website, location, industry, employee_count, stage, deal_summary, next_step) VALUES
  ('b0000000-0000-0000-0000-000000000002', 'SecretCorp', 'secretcorp.com', 'Tokyo', 'Defense', '1000+', 'contacted', 'Classified project', 'NDA signing'),
  ('b0000000-0000-0000-0000-000000000002', 'BetaClient', 'betaclient.io', 'Seoul', 'Technology', '50-100', 'new', 'API integration', 'Discovery call');
