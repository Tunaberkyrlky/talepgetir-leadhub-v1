-- ==========================================
-- TG-Research v2 - Y2 customs/trade CSV ingest
-- ------------------------------------------------------------------------------
-- Groups uploaded rows into auditable batches and carries the normalized buyer
-- fields needed to seed research_companies. Trade ingest is data-only: rows create
-- unbilled review candidates; a later explicit research run validates/bills MATCHes.
-- ==========================================

-- Composite ownership FKs need a matching unique key. project.id is already globally
-- unique; this companion constraint lets the DB also prove tenant ownership.
ALTER TABLE research_projects
  ADD CONSTRAINT uq_research_projects_tenant_id UNIQUE (tenant_id, id);

CREATE TABLE research_trade_import_batches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id       UUID NOT NULL,
  file_name        TEXT NOT NULL,
  source_sha256    TEXT NOT NULL,
  job_id           UUID REFERENCES research_jobs(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','processing','processed','failed')),
  total_rows       INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  accepted_rows    INTEGER NOT NULL DEFAULT 0 CHECK (accepted_rows >= 0),
  review_rows      INTEGER NOT NULL DEFAULT 0 CHECK (review_rows >= 0),
  rejected_rows    INTEGER NOT NULL DEFAULT 0 CHECK (rejected_rows >= 0),
  processed_rows   INTEGER NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
  linked_companies INTEGER NOT NULL DEFAULT 0 CHECK (linked_companies >= 0),
  error            TEXT,
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_research_trade_batches_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_research_trade_batches_project
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES research_projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_research_trade_batches_file
    UNIQUE (tenant_id, project_id, source_sha256)
);

CREATE INDEX idx_research_trade_batches_project
  ON research_trade_import_batches(tenant_id, project_id, created_at DESC);

ALTER TABLE research_trade_import_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_trade_import_batches_select ON research_trade_import_batches
  FOR SELECT USING (tenant_id = get_user_tenant_id() OR is_superadmin());

REVOKE INSERT, UPDATE, DELETE ON research_trade_import_batches FROM PUBLIC, anon, authenticated;

CREATE TRIGGER research_trade_import_batches_updated_at
  BEFORE UPDATE ON research_trade_import_batches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE research_trade_imports
  ADD COLUMN batch_id UUID,
  ADD COLUMN row_number INTEGER,
  ADD COLUMN country TEXT,
  ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN confidence TEXT CHECK (confidence IN ('high','medium','low')),
  ADD COLUMN needs_review BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN review_reasons TEXT,
  ADD COLUMN company_id UUID;

ALTER TABLE research_trade_imports
  ADD CONSTRAINT fk_research_trade_imports_batch
    FOREIGN KEY (tenant_id, batch_id)
    REFERENCES research_trade_import_batches(tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_research_trade_imports_company
    FOREIGN KEY (tenant_id, company_id)
    REFERENCES research_companies(tenant_id, id) ON DELETE SET NULL (company_id);

CREATE UNIQUE INDEX uq_research_trade_imports_batch_row
  ON research_trade_imports(batch_id, row_number)
  WHERE batch_id IS NOT NULL;
CREATE INDEX idx_research_trade_imports_batch_status
  ON research_trade_imports(tenant_id, batch_id, status);

-- Customs rows contain commercially sensitive source data. They are served only by
-- tenant-scoped API routes; direct browser PostgREST access is unnecessary.
REVOKE SELECT, INSERT, UPDATE, DELETE ON research_trade_imports FROM PUBLIC, anon, authenticated;
