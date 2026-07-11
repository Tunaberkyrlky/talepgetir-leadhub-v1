-- Tibexa Core CRM Expansion — search_companies owner filter  [118]
-- The ranked-search RPC gained no owner filter in 050, so the Leads owner control
-- had to be disabled while a text search was active. This adds two trailing,
-- DEFAULT-ed params so the owner filter also applies during search.
--
-- BACKWARD COMPATIBLE: the two new params are appended AFTER p_offset and both
-- default (p_owner → NULL, p_unassigned → FALSE), so a deployed OLD server that
-- still calls the 11-arg named form resolves to this function unchanged. The
-- 11-arg signature is DROPped first so an exact-arity 11-param call can't bind to
-- the stale definition (which would silently ignore the owner filter). Body is a
-- verbatim copy of the LIVE staging definition (pg_get_functiondef, 2026-07-11)
-- with only the owner predicate + the two params added. NOTE: product_portfolio
-- is intentionally ABSENT from the return set — the shared staging DB dropped it
-- (parallel worktree's merge_product_portfolio_into_services + drop migrations),
-- and the live function no longer returns it.

DROP FUNCTION IF EXISTS search_companies(UUID, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER);

CREATE FUNCTION search_companies(
  p_tenant_id   UUID,
  p_search      TEXT,
  p_stages      TEXT[]      DEFAULT NULL,
  p_industries  TEXT[]      DEFAULT NULL,
  p_locations   TEXT[]      DEFAULT NULL,
  p_countries   TEXT[]      DEFAULT NULL,
  p_products    TEXT[]      DEFAULT NULL,
  p_date_from   TIMESTAMPTZ DEFAULT NULL,
  p_date_to     TIMESTAMPTZ DEFAULT NULL,
  p_limit       INTEGER     DEFAULT 25,
  p_offset      INTEGER     DEFAULT 0,
  p_owner       UUID        DEFAULT NULL,
  p_unassigned  BOOLEAN     DEFAULT FALSE
)
RETURNS TABLE(
  id                UUID,
  name              TEXT,
  website           TEXT,
  location          TEXT,
  latitude          NUMERIC,
  industry          TEXT,
  employee_size     TEXT,
  product_services  TEXT[],
  linkedin          TEXT,
  company_phone     TEXT,
  company_email     TEXT,
  email_status      TEXT,
  stage             TEXT,
  company_summary   TEXT,
  next_step         TEXT,
  assigned_to       UUID,
  fit_score         TEXT,
  custom_field_1    TEXT,
  custom_field_2    TEXT,
  custom_field_3    TEXT,
  contact_count     INTEGER,
  country           TEXT,
  created_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ,
  total_count       BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q      TEXT := lower(trim(coalesce(p_search, '')));
  v_q_like TEXT := '%' || lower(trim(coalesce(p_search, ''))) || '%';
BEGIN
  RETURN QUERY
  WITH ranked AS (
    SELECT
      c.*,
      CASE
        WHEN v_q = '' THEN 99
        WHEN lower(c.name) = v_q                                 THEN 0
        WHEN lower(c.name) ~ ('\m' || v_q || '\M')               THEN 1
        WHEN lower(c.name) LIKE v_q || '%'                       THEN 2
        WHEN lower(c.name) LIKE v_q_like                         THEN 3
        WHEN lower(coalesce(c.website,   '')) LIKE v_q_like      THEN 4
        WHEN lower(coalesce(c.industry,  '')) LIKE v_q_like      THEN 5
        WHEN lower(coalesce(c.location,  '')) LIKE v_q_like      THEN 6
        WHEN lower(coalesce(c.next_step, '')) LIKE v_q_like      THEN 7
        ELSE 99
      END AS _rank
    FROM companies c
    WHERE c.tenant_id = p_tenant_id
      AND (
        v_q = ''
        OR lower(c.name) LIKE v_q_like
        OR lower(coalesce(c.website,   '')) LIKE v_q_like
        OR lower(coalesce(c.industry,  '')) LIKE v_q_like
        OR lower(coalesce(c.location,  '')) LIKE v_q_like
        OR lower(coalesce(c.next_step, '')) LIKE v_q_like
      )
      AND (p_stages     IS NULL OR cardinality(p_stages)     = 0 OR c.stage    = ANY(p_stages))
      AND (p_industries IS NULL OR cardinality(p_industries) = 0 OR c.industry = ANY(p_industries))
      AND (p_products   IS NULL OR cardinality(p_products)   = 0 OR c.product_services && p_products)
      -- Owner filter (added in 118): p_owner pins a specific owner; p_unassigned
      -- matches the queue (assigned_to IS NULL). Both no-op at their defaults, so
      -- an owner-less call behaves exactly as 050 did.
      AND (p_owner IS NULL OR c.assigned_to = p_owner)
      AND (NOT p_unassigned OR c.assigned_to IS NULL)
      AND (
        (p_locations IS NULL OR cardinality(p_locations) = 0)
        AND (p_countries IS NULL OR cardinality(p_countries) = 0)
        OR (
          (p_locations IS NOT NULL AND cardinality(p_locations) > 0 AND (
              c.location = ANY(p_locations)
              OR ('__empty__'        = ANY(p_locations) AND c.location IS NULL)
              OR ('__not_geocoded__' = ANY(p_locations) AND c.latitude IS NULL)
          ))
          OR (p_countries IS NOT NULL AND cardinality(p_countries) > 0 AND c.country = ANY(p_countries))
        )
      )
      AND (p_date_from IS NULL OR c.created_at >= p_date_from)
      AND (p_date_to   IS NULL OR c.created_at <= p_date_to)
  )
  SELECT
    r.id, r.name, r.website, r.location, r.latitude, r.industry,
    r.employee_size, r.product_services, r.linkedin,
    r.company_phone, r.company_email, r.email_status, r.stage,
    r.company_summary, r.next_step, r.assigned_to, r.fit_score,
    r.custom_field_1, r.custom_field_2, r.custom_field_3,
    r.contact_count, r.country, r.created_at, r.updated_at,
    count(*) OVER () AS total_count
  FROM ranked r
  ORDER BY
    r._rank ASC,
    length(r.name) ASC NULLS LAST,
    r.updated_at DESC NULLS LAST,
    r.id ASC
  LIMIT p_limit OFFSET p_offset;
END;
$$;

-- Re-issue grants on the NEW 13-arg signature (the DROP dropped the old grants
-- with the old signature). Same posture as 050: authenticated (client roles call
-- via the user client) + service_role (internal roles via the admin client).
REVOKE ALL ON FUNCTION search_companies(UUID, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_companies(UUID, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, UUID, BOOLEAN) TO anon;
GRANT EXECUTE ON FUNCTION search_companies(UUID, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION search_companies(UUID, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, UUID, BOOLEAN) TO service_role;
