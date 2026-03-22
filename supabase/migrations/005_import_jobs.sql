-- ==========================================
-- Import Jobs table
-- ==========================================

CREATE TABLE import_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_name       TEXT NOT NULL,
  file_type       TEXT NOT NULL CHECK (file_type IN ('csv', 'xlsx', 'matched')),
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  total_rows      INT,
  success_count   INT DEFAULT 0,
  error_count     INT DEFAULT 0,
  error_details   JSONB DEFAULT '[]',
  column_mapping  JSONB DEFAULT '{}',
  progress_count  INTEGER DEFAULT 0,
  cancelled       BOOLEAN DEFAULT FALSE,
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;

-- ==========================================
-- INDEXES
-- ==========================================

CREATE INDEX idx_import_jobs_tenant ON import_jobs(tenant_id);

-- ==========================================
-- RLS POLICIES
-- ==========================================

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
