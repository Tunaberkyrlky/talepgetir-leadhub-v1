-- ==========================================
-- product_services / product_portfolio: TEXT -> TEXT[]
-- ==========================================
-- These hold lists of product/service categories (e.g. "Skincare, haircare,
-- makeup"). Storing them as text[] lets us split on import, show chips, and
-- filter by category overlap instead of exact-string match.
--
-- Type conversion is LOSSLESS for every tenant: each existing non-empty value
-- becomes a single-element array (NULL / blank -> NULL). Splitting historical
-- strings into multi-element lists is done separately, per tenant.

ALTER TABLE companies
  ALTER COLUMN product_services TYPE text[]
    USING (CASE WHEN product_services IS NULL OR btrim(product_services) = ''
                THEN NULL ELSE ARRAY[product_services] END),
  ALTER COLUMN product_portfolio TYPE text[]
    USING (CASE WHEN product_portfolio IS NULL OR btrim(product_portfolio) = ''
                THEN NULL ELSE ARRAY[product_portfolio] END);

-- ── Recreate search_companies ──
-- product_services / product_portfolio are now text[] (changes the RETURNS TABLE
-- shape, so the function must be dropped and recreated), and the product filter
-- switches from scalar equality (= ANY) to array overlap (&&).

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
  p_offset      INTEGER     DEFAULT 0
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
  product_portfolio TEXT[],
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
    r.employee_size, r.product_services, r.product_portfolio, r.linkedin,
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

REVOKE ALL ON FUNCTION search_companies(UUID, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_companies(UUID, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION search_companies(UUID, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER) TO service_role;
