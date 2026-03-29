-- supabase/migrations/015_pipeline_stage_fk.sql
-- Add composite FK: companies(tenant_id, stage) → pipeline_stages(tenant_id, slug)

-- Pre-flight: fail if orphaned stage values exist
DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM companies c
    WHERE NOT EXISTS (
      SELECT 1 FROM pipeline_stages ps
      WHERE ps.tenant_id = c.tenant_id AND ps.slug = c.stage
    )
  ) = 0, 'Orphaned stage values found — fix before adding FK';
END $$;

ALTER TABLE companies
  ADD CONSTRAINT fk_companies_stage
  FOREIGN KEY (tenant_id, stage)
  REFERENCES pipeline_stages(tenant_id, slug)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;
