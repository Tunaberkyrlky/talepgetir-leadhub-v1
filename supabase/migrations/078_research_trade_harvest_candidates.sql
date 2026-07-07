-- ==========================================
-- TG-Research v2 - Y2 explicit Research candidate selector
-- ------------------------------------------------------------------------------
-- Returns one company per imported batch that does not yet have a verdict for the
-- selected ICP's current ruleset. This makes repeated capped runs resume naturally.
-- ==========================================

CREATE OR REPLACE FUNCTION research_trade_batch_candidates(
  p_tenant  UUID,
  p_batch   UUID,
  p_icp     UUID,
  p_ruleset INTEGER,
  p_limit   INTEGER DEFAULT 80
)
RETURNS TABLE (
  company_id UUID,
  name       TEXT,
  domain     TEXT,
  website    TEXT,
  country    TEXT,
  city       TEXT,
  phone      TEXT,
  address    TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id,
    c.name,
    c.domain,
    c.website,
    c.country,
    c.city,
    c.phone,
    c.address
  FROM research_companies c
  WHERE c.tenant_id = p_tenant
    AND c.suppressed = false
    -- The shared validator requires source text from a real site. Domainless customs buyers stay
    -- in review for later enrichment instead of reappearing in every Research run forever.
    AND c.domain IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM research_trade_imports ti
      JOIN research_trade_import_batches b
        ON b.id = ti.batch_id
       AND b.tenant_id = ti.tenant_id
      WHERE ti.tenant_id = p_tenant
        AND ti.batch_id = p_batch
        AND ti.company_id = c.id
        AND ti.status = 'processed'
        AND b.status = 'processed'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM research_company_verdicts v
      WHERE v.tenant_id = p_tenant
        AND v.company_id = c.id
        AND v.icp_id = p_icp
        AND v.ruleset_version = p_ruleset
    )
    AND NOT EXISTS (
      SELECT 1
      FROM research_suppression s
      WHERE s.tenant_id = p_tenant
        AND s.entity_type = 'company'
        AND s.identity_key = c.canonical_key
    )
  ORDER BY c.first_seen_at, c.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 80), 1), 1000);
$$;

REVOKE ALL ON FUNCTION research_trade_batch_candidates(UUID, UUID, UUID, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_trade_batch_candidates(UUID, UUID, UUID, INTEGER, INTEGER)
  TO service_role;
