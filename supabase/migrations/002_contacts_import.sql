-- ==========================================
-- LeadHub V1 — Contacts + Import Jobs
-- ==========================================

-- ==========================================
-- CONTACTS
-- ==========================================

CREATE TABLE contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name     TEXT NOT NULL,
  title         TEXT,
  email         TEXT,
  phone_e164    TEXT,
  whatsapp_e164 TEXT,
  is_primary    BOOLEAN DEFAULT false,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

-- SELECT: tenant sees own contacts
CREATE POLICY "contacts_select" ON contacts
  FOR SELECT USING (tenant_id = get_user_tenant_id());

-- INSERT: ops_agent and superadmin
CREATE POLICY "contacts_insert" ON contacts
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND get_user_role() IN ('superadmin', 'ops_agent')
  );

-- UPDATE: ops_agent and superadmin
CREATE POLICY "contacts_update" ON contacts
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND get_user_role() IN ('superadmin', 'ops_agent')
  );

-- DELETE: superadmin only
CREATE POLICY "contacts_delete" ON contacts
  FOR DELETE USING (
    tenant_id = get_user_tenant_id()
    AND get_user_role() = 'superadmin'
  );

-- Trigger for updated_at
CREATE TRIGGER contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ==========================================
-- IMPORT JOBS
-- ==========================================

CREATE TABLE import_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_name     TEXT NOT NULL,
  file_type     TEXT NOT NULL CHECK (file_type IN ('csv','xlsx')),
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  total_rows    INT,
  success_count INT DEFAULT 0,
  error_count   INT DEFAULT 0,
  error_details JSONB DEFAULT '[]',
  column_mapping JSONB DEFAULT '{}',
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "import_jobs_select" ON import_jobs
  FOR SELECT USING (tenant_id = get_user_tenant_id());

CREATE POLICY "import_jobs_insert" ON import_jobs
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND get_user_role() IN ('superadmin', 'ops_agent')
  );

CREATE POLICY "import_jobs_update" ON import_jobs
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND get_user_role() IN ('superadmin', 'ops_agent')
  );

-- ==========================================
-- INDEXES
-- ==========================================

CREATE INDEX idx_contacts_tenant ON contacts(tenant_id);
CREATE INDEX idx_contacts_company ON contacts(company_id);
CREATE INDEX idx_import_jobs_tenant ON import_jobs(tenant_id);
