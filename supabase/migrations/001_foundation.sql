-- ==========================================
-- LeadHub V0 Foundation Migration
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
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

-- Tenants: users can only see their own tenant
CREATE POLICY "tenants_select" ON tenants
  FOR SELECT USING (
    id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::UUID
  );

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

-- Memberships: users can see memberships in their own tenant
CREATE POLICY "memberships_select" ON memberships
  FOR SELECT USING (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::UUID
  );

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

-- ==========================================
-- COMPANIES
-- ==========================================

CREATE TABLE companies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  website         TEXT,
  location        TEXT,
  industry        TEXT,
  custom_fields   JSONB DEFAULT '{}',
  employee_count  TEXT,
  stage           TEXT NOT NULL DEFAULT 'new'
                  CHECK (stage IN ('new','researching','contacted','meeting_scheduled',
                                   'proposal_sent','negotiation','won','lost','on_hold')),
  deal_summary    TEXT,
  internal_notes  TEXT,
  next_step       TEXT,
  assigned_to     UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

-- SELECT: tenant sees own data
CREATE POLICY "companies_select" ON companies
  FOR SELECT USING (tenant_id = get_user_tenant_id());

-- INSERT: ops_agent and superadmin
CREATE POLICY "companies_insert" ON companies
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND get_user_role() IN ('superadmin', 'ops_agent')
  );

-- UPDATE: ops_agent and superadmin
CREATE POLICY "companies_update" ON companies
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND get_user_role() IN ('superadmin', 'ops_agent')
  );

-- DELETE: superadmin only
CREATE POLICY "companies_delete" ON companies
  FOR DELETE USING (
    tenant_id = get_user_tenant_id()
    AND get_user_role() = 'superadmin'
  );

-- ==========================================
-- ACTIVITIES (DB only — UI in V4)
-- ==========================================

CREATE TABLE activities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id  UUID,
  type        TEXT NOT NULL CHECK (type IN ('call','email','whatsapp','meeting','note','status_change')),
  outcome     TEXT,
  summary     TEXT NOT NULL,
  detail      TEXT,
  visibility  TEXT DEFAULT 'internal' CHECK (visibility IN ('internal','client')),
  occurred_at TIMESTAMPTZ DEFAULT now(),
  created_by  UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE activities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "activities_select" ON activities
  FOR SELECT USING (tenant_id = get_user_tenant_id());

CREATE POLICY "activities_insert" ON activities
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND get_user_role() IN ('superadmin', 'ops_agent')
  );

-- ==========================================
-- INDEXES
-- ==========================================

CREATE INDEX idx_companies_tenant ON companies(tenant_id);
CREATE INDEX idx_companies_tenant_stage ON companies(tenant_id, stage);
CREATE INDEX idx_companies_tenant_name ON companies(tenant_id, name);
CREATE INDEX idx_activities_tenant ON activities(tenant_id);
CREATE INDEX idx_activities_company ON activities(company_id);
CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_memberships_tenant ON memberships(tenant_id);

-- ==========================================
-- UPDATED_AT TRIGGER
-- ==========================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
