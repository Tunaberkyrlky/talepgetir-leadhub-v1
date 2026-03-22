-- ==========================================
-- LeadHub Foundation Migration
-- Extensions, tenants, memberships, helper functions
-- ==========================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================
-- TENANTS
-- ==========================================

CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  settings    JSONB DEFAULT '{}',
  is_active   BOOLEAN DEFAULT true,
  tier        TEXT NOT NULL DEFAULT 'basic' CHECK (tier IN ('basic', 'pro')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_tenants_tier ON tenants(tier);

-- ==========================================
-- MEMBERSHIPS
-- ==========================================

CREATE TABLE memberships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('superadmin','ops_agent','client_admin','client_viewer')),
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, tenant_id)
);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_memberships_tenant ON memberships(tenant_id);

-- ==========================================
-- HELPER FUNCTIONS
-- ==========================================

-- Get user's active tenant_id from JWT
CREATE OR REPLACE FUNCTION get_user_tenant_id()
RETURNS UUID AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::UUID;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Get user's role in their active tenant
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS TEXT AS $$
  SELECT role FROM memberships
  WHERE user_id = auth.uid()
    AND tenant_id = get_user_tenant_id()
    AND is_active = true
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Check if user is superadmin (stored in app_metadata, tenant-independent)
CREATE OR REPLACE FUNCTION is_superadmin()
RETURNS BOOLEAN AS $$
  SELECT COALESCE((auth.jwt() -> 'app_metadata' ->> 'is_superadmin')::BOOLEAN, false);
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Auto-update updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- RLS POLICIES: Tenants
-- ==========================================

CREATE POLICY "tenants_select" ON tenants
  FOR SELECT USING (
    id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::UUID
    OR is_superadmin()
  );

-- ==========================================
-- RLS POLICIES: Memberships
-- ==========================================

CREATE POLICY "memberships_select" ON memberships
  FOR SELECT USING (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::UUID
    OR is_superadmin()
  );

-- ==========================================
-- TRIGGERS
-- ==========================================

CREATE TRIGGER tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
