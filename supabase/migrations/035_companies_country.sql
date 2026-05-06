-- ==========================================
-- Companies: country column
-- ==========================================
-- Persists the country derived from the geocoder so the globe map can filter
-- companies by country even when location is entered as a city only
-- (e.g. "Istanbul" → country = "Turkey"). Backfilled lazily by the existing
-- /companies/geocode batch endpoint.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS country TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_tenant_country
  ON companies (tenant_id, country)
  WHERE country IS NOT NULL;
