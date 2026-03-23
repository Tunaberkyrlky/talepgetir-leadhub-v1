-- ==========================================
-- Import file cache: persist uploaded file data in DB
-- so imports survive deploys, restarts, and scaling
-- ==========================================

CREATE TABLE import_file_cache (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_name   TEXT,
  file_type   TEXT,
  headers     JSONB NOT NULL DEFAULT '[]',
  row_data    JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE import_file_cache ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_import_file_cache_tenant ON import_file_cache(tenant_id);
CREATE INDEX idx_import_file_cache_created ON import_file_cache(created_at);

-- Lifecycle:
--   1. Preview endpoint INSERT → cache oluşur
--   2. Execute endpoint SELECT + DELETE → import bitince silinir
--   3. Orphan cache (kullanıcı tarayıcı kapattı vs.) → aşağıdaki cron 2 saat sonra siler
--
-- pg_cron ile otomatik temizleme (Supabase Dashboard > SQL Editor'da enable):
-- SELECT cron.schedule('cleanup-import-file-cache', '*/30 * * * *',
--   $$DELETE FROM import_file_cache WHERE created_at < now() - interval '2 hours'$$
-- );
--
-- pg_cron yoksa server tarafında cleanup endpoint/startup hook kullanılabilir.

CREATE POLICY "import_file_cache_all" ON import_file_cache
  FOR ALL USING (tenant_id = get_user_tenant_id());

-- ==========================================
-- Add 'cancelled' to import_jobs status check
-- ==========================================

ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_status_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'));

-- Allow 'matched' file_type in import_jobs
ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_file_type_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_file_type_check
  CHECK (file_type IN ('csv', 'xlsx', 'matched'));
