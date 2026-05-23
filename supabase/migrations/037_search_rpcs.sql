-- ==========================================
-- Search RPCs — relevance ranking for companies & contacts
-- ==========================================
-- Problem: ILIKE on multiple columns returns all hits but sorts by updated_at,
-- so typing the exact company/contact name often pushes the true match far
-- below the fold. These RPCs return results ranked by match strength.
--
-- Ranking (lower = better):
--   companies: name exact (0) → name whole-word (1) → name prefix (2)
--              → name contains (3) → website contains (4) → industry contains (5)
--              → location contains (6) → next_step contains (7)
--   contacts:  full_name exact (0) → email exact (0) → first/last exact (1)
--              → email prefix (2) → first/last prefix (3)
--              → first/last/email contains (4) → title contains (5)
--
-- Tie-breaker: shorter name first (more specific), then updated_at DESC.
-- Window function returns total_count alongside each row so the route does
-- not need a separate COUNT query.
--
-- Filters mirror the existing route handlers exactly.

-- ── search_companies ──

CREATE OR REPLACE FUNCTION search_companies(
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
  product_services  TEXT,
  product_portfolio TEXT,
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
      AND (p_products   IS NULL OR cardinality(p_products)   = 0 OR c.product_services = ANY(p_products))
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

-- ── search_contacts ──

CREATE OR REPLACE FUNCTION search_contacts(
  p_tenant_id   UUID,
  p_search      TEXT,
  p_company_ids UUID[]  DEFAULT NULL,
  p_seniorities TEXT[]  DEFAULT NULL,
  p_countries   TEXT[]  DEFAULT NULL,
  p_limit       INTEGER DEFAULT 25,
  p_offset      INTEGER DEFAULT 0
)
RETURNS TABLE(
  id            UUID,
  first_name    TEXT,
  last_name     TEXT,
  email         TEXT,
  phone_e164    TEXT,
  title         TEXT,
  country       TEXT,
  seniority     TEXT,
  is_primary    BOOLEAN,
  linkedin      TEXT,
  company_id    UUID,
  company_name  TEXT,
  company_stage TEXT,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ,
  total_count   BIGINT
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
      ct.*,
      co.name  AS _co_name,
      co.stage AS _co_stage,
      lower(trim(coalesce(ct.first_name,'') || ' ' || coalesce(ct.last_name,''))) AS _full_name,
      CASE
        WHEN v_q = '' THEN 99
        WHEN lower(trim(coalesce(ct.first_name,'') || ' ' || coalesce(ct.last_name,''))) = v_q THEN 0
        WHEN lower(coalesce(ct.email, '')) = v_q                                              THEN 0
        WHEN lower(coalesce(ct.first_name, '')) = v_q                                         THEN 1
        WHEN lower(coalesce(ct.last_name,  '')) = v_q                                         THEN 1
        WHEN lower(coalesce(ct.email, ''))      LIKE v_q || '%'                               THEN 2
        WHEN lower(coalesce(ct.first_name, '')) LIKE v_q || '%'                               THEN 3
        WHEN lower(coalesce(ct.last_name,  '')) LIKE v_q || '%'                               THEN 3
        WHEN lower(coalesce(ct.first_name, '')) LIKE v_q_like                                 THEN 4
        WHEN lower(coalesce(ct.last_name,  '')) LIKE v_q_like                                 THEN 4
        WHEN lower(coalesce(ct.email, ''))      LIKE v_q_like                                 THEN 4
        WHEN lower(coalesce(ct.title, ''))      LIKE v_q_like                                 THEN 5
        ELSE 99
      END AS _rank
    FROM contacts ct
    LEFT JOIN companies co ON co.id = ct.company_id
    WHERE ct.tenant_id = p_tenant_id
      AND (
        v_q = ''
        OR lower(coalesce(ct.first_name, '')) LIKE v_q_like
        OR lower(coalesce(ct.last_name,  '')) LIKE v_q_like
        OR lower(coalesce(ct.email,      '')) LIKE v_q_like
        OR lower(coalesce(ct.title,      '')) LIKE v_q_like
      )
      AND (p_company_ids IS NULL OR cardinality(p_company_ids) = 0 OR ct.company_id = ANY(p_company_ids))
      AND (p_seniorities IS NULL OR cardinality(p_seniorities) = 0 OR ct.seniority  = ANY(p_seniorities))
      AND (p_countries   IS NULL OR cardinality(p_countries)   = 0 OR ct.country    = ANY(p_countries))
  )
  SELECT
    r.id, r.first_name, r.last_name, r.email, r.phone_e164, r.title,
    r.country, r.seniority, r.is_primary, r.linkedin,
    r.company_id, r._co_name AS company_name, r._co_stage AS company_stage,
    r.created_at, r.updated_at,
    count(*) OVER () AS total_count
  FROM ranked r
  ORDER BY
    r._rank ASC,
    length(r._full_name) ASC NULLS LAST,
    r.updated_at DESC NULLS LAST,
    r.id ASC
  LIMIT p_limit OFFSET p_offset;
END;
$$;

REVOKE ALL ON FUNCTION search_contacts(UUID, TEXT, UUID[], TEXT[], TEXT[], INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_contacts(UUID, TEXT, UUID[], TEXT[], TEXT[], INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION search_contacts(UUID, TEXT, UUID[], TEXT[], TEXT[], INTEGER, INTEGER) TO service_role;
