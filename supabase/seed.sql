-- ==========================================
-- SEED DATA — For development/testing only
-- ==========================================

-- ==========================================
-- TENANTS
-- ==========================================

INSERT INTO tenants (id, name, slug) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Acme Corp',        'acme-corp'),
  ('b0000000-0000-0000-0000-000000000002', 'Beta Industries',   'beta-industries'),
  ('c0000000-0000-0000-0000-000000000003', 'Naturagen',         'naturagen');

-- ==========================================
-- AUTH USERS (one per role)
-- ==========================================
-- Passwords are all: Test1234!
-- Emails: <role>@leadhub.dev

INSERT INTO auth.users (
  id, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, role, aud
) VALUES
  (
    'u0000000-0000-0000-0000-000000000001',
    'superadmin@leadhub.dev',
    crypt('Test1234!', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"],"tenant_id":"a0000000-0000-0000-0000-000000000001","role":"superadmin"}'::jsonb,
    '{"full_name":"Super Admin"}'::jsonb,
    now(), now(), 'authenticated', 'authenticated'
  ),
  (
    'u0000000-0000-0000-0000-000000000002',
    'ops@leadhub.dev',
    crypt('Test1234!', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"],"tenant_id":"a0000000-0000-0000-0000-000000000001","role":"ops_agent"}'::jsonb,
    '{"full_name":"Ops Agent"}'::jsonb,
    now(), now(), 'authenticated', 'authenticated'
  ),
  (
    'u0000000-0000-0000-0000-000000000003',
    'client.admin@leadhub.dev',
    crypt('Test1234!', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"],"tenant_id":"a0000000-0000-0000-0000-000000000001","role":"client_admin"}'::jsonb,
    '{"full_name":"Client Admin"}'::jsonb,
    now(), now(), 'authenticated', 'authenticated'
  ),
  (
    'u0000000-0000-0000-0000-000000000004',
    'client.viewer@leadhub.dev',
    crypt('Test1234!', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"],"tenant_id":"a0000000-0000-0000-0000-000000000001","role":"client_viewer"}'::jsonb,
    '{"full_name":"Client Viewer"}'::jsonb,
    now(), now(), 'authenticated', 'authenticated'
  ),
  -- Beta Industries ops agent (to test tenant isolation)
  (
    'u0000000-0000-0000-0000-000000000005',
    'ops.beta@leadhub.dev',
    crypt('Test1234!', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"],"tenant_id":"b0000000-0000-0000-0000-000000000002","role":"ops_agent"}'::jsonb,
    '{"full_name":"Ops Beta"}'::jsonb,
    now(), now(), 'authenticated', 'authenticated'
  );

-- ==========================================
-- MEMBERSHIPS
-- ==========================================

INSERT INTO memberships (user_id, tenant_id, role) VALUES
  ('u0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'superadmin'),
  ('u0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'ops_agent'),
  ('u0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'client_admin'),
  ('u0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'client_viewer'),
  ('u0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000002', 'ops_agent');

ops
6836ddb2-7dfd-479c-bd3c-66ed08ca29c7 

sa
5d7f1763-39e4-473e-bfc1-3cf364b6b389
