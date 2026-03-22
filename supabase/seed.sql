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
-- SUPERADMIN (tenant-independent)
-- Set is_superadmin flag in app_metadata + default tenant
-- Superadmin can access ALL tenants without needing memberships
-- ==========================================

UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data
  || '{"is_superadmin": true, "tenant_id": "a0000000-0000-0000-0000-000000000001"}'::jsonb
WHERE id = '170ab440-e553-4644-a0bf-43b64f448e15';
