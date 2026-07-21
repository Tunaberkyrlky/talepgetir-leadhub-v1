-- 068: Drip kampanya CSV alıcı importu — enrollment bazlı hazır mesaj + import job genişletmesi
-- Additive-only DDL (canlı müşteri). Plan: plans/DRIP_CSV_IMPORT_PLAN.md

ALTER TABLE campaign_enrollments
  ADD COLUMN IF NOT EXISTS custom_subject   TEXT,
  ADD COLUMN IF NOT EXISTS custom_body_text TEXT,
  ADD COLUMN IF NOT EXISTS email_status     TEXT
    CHECK (email_status IS NULL OR email_status IN ('ok','catch_all','unknown','invalid','error')),
  ADD COLUMN IF NOT EXISTS dnc_status       TEXT,
  ADD COLUMN IF NOT EXISTS excluded_reason  TEXT,   -- null=uygun; invalid_status|error_status|status_filtered|dnc
  ADD COLUMN IF NOT EXISTS import_job_id    UUID REFERENCES import_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS meta             JSONB;  -- angle, language, region, website, source_row, other_emails

CREATE INDEX IF NOT EXISTS idx_enrollments_import_job
  ON campaign_enrollments(import_job_id) WHERE import_job_id IS NOT NULL;

ALTER TABLE import_jobs
  ADD COLUMN IF NOT EXISTS import_type TEXT NOT NULL DEFAULT 'crm'
    CHECK (import_type IN ('crm','campaign_recipients')),
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_import_jobs_campaign
  ON import_jobs(campaign_id) WHERE campaign_id IS NOT NULL;
