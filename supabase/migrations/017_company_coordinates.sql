-- ==========================================
-- 017: Add geocoordinates to companies
-- ==========================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS latitude  NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS longitude NUMERIC(10, 7);

-- Partial index for the dashboard globe query (tenant_id + has coordinates)
CREATE INDEX IF NOT EXISTS idx_companies_coordinates
  ON companies (tenant_id)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
