-- ==========================================
-- TG-Research v2 — WP5 hardening (2-lens review)  [100]
--
-- 1) Daily-tick tenant discovery was a raw 2000-row scan of research_companies — one big
--    tenant's exported rows could fill the window and SILENTLY starve every other tenant's
--    daily aggregate (and with it their opt-out → suppression sync). The DISTINCT now runs
--    in the DB via a tiny SECURITY DEFINER helper, immune to row volume.
-- 2) Partial index so the helper (and the handler's exported-companies scan) stays cheap
--    on the worker's 60s reap tick.
-- ==========================================

CREATE INDEX IF NOT EXISTS idx_research_companies_exported
  ON research_companies(tenant_id, id) WHERE crm_company_id IS NOT NULL;

CREATE OR REPLACE FUNCTION research_tenants_with_exports()
RETURNS TABLE(tenant_id UUID)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT c.tenant_id FROM research_companies c WHERE c.crm_company_id IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION research_tenants_with_exports() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_tenants_with_exports() TO service_role;
