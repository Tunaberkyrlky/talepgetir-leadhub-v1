-- ==========================================
-- Activities table
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

-- ==========================================
-- INDEXES
-- ==========================================

CREATE INDEX idx_activities_tenant ON activities(tenant_id);
CREATE INDEX idx_activities_company ON activities(company_id);

-- ==========================================
-- RLS POLICIES
-- ==========================================

CREATE POLICY "activities_select" ON activities
  FOR SELECT USING (tenant_id = get_user_tenant_id());

CREATE POLICY "activities_insert" ON activities
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND get_user_role() IN ('superadmin', 'ops_agent')
  );
