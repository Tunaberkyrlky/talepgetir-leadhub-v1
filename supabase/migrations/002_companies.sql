-- ==========================================
-- Companies table (final schema)
-- ==========================================

CREATE TABLE companies (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                      TEXT NOT NULL,
  website                   TEXT,
  location                  TEXT,
  industry                  TEXT,
  custom_fields             JSONB DEFAULT '{}',
  employee_size             TEXT,
  stage                     TEXT NOT NULL DEFAULT 'cold',
  company_summary           TEXT,
  internal_notes            TEXT,
  next_step                 TEXT,
  assigned_to               UUID REFERENCES auth.users(id),
  product_services          TEXT,
  product_portfolio         TEXT,
  linkedin                  TEXT,
  company_phone             TEXT,
  company_email             TEXT,
  email_status              TEXT CHECK (email_status IN ('valid', 'uncertain', 'invalid')),
  fit_score                 TEXT,
  partnership_observation_1 TEXT,
  partnership_observation_2 TEXT,
  partnership_observation_3 TEXT,
  contact_count             INTEGER NOT NULL DEFAULT 0,
  stage_changed_at          TIMESTAMPTZ,
  latitude                  NUMERIC(10, 7),
  longitude                 NUMERIC(10, 7),
  translations              JSONB DEFAULT NULL,
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

-- ==========================================
-- INDEXES
-- ==========================================

CREATE INDEX idx_companies_tenant ON companies(tenant_id);
CREATE INDEX idx_companies_tenant_stage ON companies(tenant_id, stage);
CREATE INDEX idx_companies_tenant_name ON companies(tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_companies_coordinates
  ON companies (tenant_id)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- ==========================================
-- RLS POLICIES (with superadmin override)
-- ==========================================

CREATE POLICY "companies_select" ON companies
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    OR is_superadmin()
  );

CREATE POLICY "companies_insert" ON companies
  FOR INSERT WITH CHECK (
    (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin', 'ops_agent'))
    OR is_superadmin()
  );

CREATE POLICY "companies_update" ON companies
  FOR UPDATE USING (
    (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin', 'ops_agent'))
    OR is_superadmin()
  );

CREATE POLICY "companies_delete" ON companies
  FOR DELETE USING (
    (tenant_id = get_user_tenant_id() AND get_user_role() = 'superadmin')
    OR is_superadmin()
  );

-- ==========================================
-- TRIGGERS
-- ==========================================

CREATE TRIGGER companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-update stage_changed_at when stage changes
CREATE OR REPLACE FUNCTION update_stage_changed_at()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.stage IS DISTINCT FROM NEW.stage THEN
        NEW.stage_changed_at = NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stage_changed_at
    BEFORE UPDATE ON companies
    FOR EACH ROW
    EXECUTE FUNCTION update_stage_changed_at();

