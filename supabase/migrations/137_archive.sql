-- TG Core CRM — archive instead of delete  [137]
-- v2 Phase 8: companies and contacts gain a soft-archive marker so records can be
-- HIDDEN from the default list / pipeline / search views and RESTORED later, instead
-- of being permanently deleted. Nothing is destroyed — archiving is fully reversible.
--
-- Additive-only + IF NOT EXISTS guarded, so it is safe to (re-)apply on the shared
-- staging DB. The parallel merge worktree (E8) reads companies.archived_at
-- CONDITIONALLY in its merge RPC; the columns are introduced here (additive) so there
-- is no schema conflict — whichever migration lands first wins the CREATE, the other
-- no-ops. No RLS change is needed: the new nullable columns surface through the
-- existing tenant-scoped SELECT policies, and the archive/unarchive writes go through
-- the service-role server routes (like every other company/contact mutation).

-- Companies ------------------------------------------------------------------
ALTER TABLE companies ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS archived_by UUID
  REFERENCES auth.users(id) ON DELETE SET NULL;

-- Contacts -------------------------------------------------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS archived_by UUID
  REFERENCES auth.users(id) ON DELETE SET NULL;

-- Partial indexes keep the DEFAULT (active) listing fast. Almost every read now
-- carries `archived_at IS NULL`, so index only the active rows per tenant — archived
-- rows (the rare minority) stay out of the hot index.
CREATE INDEX IF NOT EXISTS idx_companies_active
  ON companies (tenant_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_active
  ON contacts (tenant_id) WHERE archived_at IS NULL;

-- Stage counts must also drop archived companies, otherwise the dashboard overview
-- (companiesByStage / activeDeals / wonDeals / conversionRate) and the pipeline funnel
-- would still count archived rows while the top-line total company card excludes them —
-- an internal inconsistency. This CREATE OR REPLACE keeps the exact 3-arg signature the
-- server calls (get_stage_counts(uuid, timestamptz, timestamptz)); only the WHERE clause
-- gains `AND c.archived_at IS NULL` (additive semantics, migrations 008/017 originals).
-- The unused 1-arg overload is left untouched.
CREATE OR REPLACE FUNCTION get_stage_counts(
    p_tenant_id UUID,
    p_date_from TIMESTAMPTZ DEFAULT NULL,
    p_date_to TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(stage TEXT, count BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
    SELECT c.stage::TEXT, COUNT(*) AS count
    FROM companies c
    WHERE c.tenant_id = p_tenant_id
      AND c.archived_at IS NULL
      AND (p_date_from IS NULL OR c.created_at >= p_date_from)
      AND (p_date_to IS NULL OR c.created_at <= p_date_to)
    GROUP BY c.stage;
$$;

-- ============================================================================
-- Archive-aware ranked SEARCH RPCs (E9 codex P1-1)
-- ----------------------------------------------------------------------------
-- The shared live search_companies / search_contacts RPCs neither return nor
-- filter archived_at, so the routes previously applied the archive filter in JS
-- AFTER the RPC had already paginated (LIMIT/OFFSET). That produced short/blank
-- pages and made ?archived=only search impossible (an active-only page never
-- contains archived rows to keep).
--
-- Fix: NEW, DISTINCTLY-NAMED functions (…_archive) that push the archive
-- predicate into the WHERE clause BEFORE count(*) OVER() + ORDER + LIMIT/OFFSET,
-- so pagination totals and page contents are archive-correct. The live shared
-- search_companies/search_contacts are LEFT UNTOUCHED (a parallel worktree's
-- merge RPC and other callers depend on their exact live shape). Routes call the
-- new RPC on the search path and fall back to the old RPC + in-page filter if the
-- new function is missing (pre-137 DB).
--
-- Bodies are based on the most-recent repo definitions (search_companies = 118,
-- search_contacts = 037). NOTE/openQuestion: the LIVE staging search_companies
-- body may be AHEAD of migration 118 (past 118 drift), so this copy could differ
-- from live in ranking/return details — acceptable because the name is new and
-- cannot shadow the live function; if live has diverged, re-sync this body from
-- pg_get_functiondef before relying on parity.

-- search_companies_archive: 118 body + p_archived_only predicate ------------
CREATE OR REPLACE FUNCTION search_companies_archive(
  p_tenant_id     UUID,
  p_search        TEXT,
  p_stages        TEXT[]      DEFAULT NULL,
  p_industries    TEXT[]      DEFAULT NULL,
  p_locations     TEXT[]      DEFAULT NULL,
  p_countries     TEXT[]      DEFAULT NULL,
  p_products      TEXT[]      DEFAULT NULL,
  p_date_from     TIMESTAMPTZ DEFAULT NULL,
  p_date_to       TIMESTAMPTZ DEFAULT NULL,
  p_limit         INTEGER     DEFAULT 25,
  p_offset        INTEGER     DEFAULT 0,
  p_owner         UUID        DEFAULT NULL,
  p_unassigned    BOOLEAN     DEFAULT FALSE,
  p_archived_only BOOLEAN     DEFAULT FALSE
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
      -- Archive predicate pushed BEFORE pagination: default hides archived rows,
      -- p_archived_only keeps ONLY them. This is the whole point of the _archive RPC.
      AND (
        (p_archived_only AND c.archived_at IS NOT NULL)
        OR (NOT p_archived_only AND c.archived_at IS NULL)
      )
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

REVOKE ALL ON FUNCTION search_companies_archive(UUID, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, UUID, BOOLEAN, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_companies_archive(UUID, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, UUID, BOOLEAN, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION search_companies_archive(UUID, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, UUID, BOOLEAN, BOOLEAN) TO service_role;

-- search_contacts_archive: 037 body + p_archived_only predicate (contact +
-- joined company archive both honored) --------------------------------------
CREATE OR REPLACE FUNCTION search_contacts_archive(
  p_tenant_id     UUID,
  p_search        TEXT,
  p_company_ids   UUID[]  DEFAULT NULL,
  p_seniorities   TEXT[]  DEFAULT NULL,
  p_countries     TEXT[]  DEFAULT NULL,
  p_limit         INTEGER DEFAULT 25,
  p_offset        INTEGER DEFAULT 0,
  p_archived_only BOOLEAN DEFAULT FALSE
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
      -- Contact archive predicate pushed BEFORE pagination. Only the contact's OWN
      -- archived_at is considered — this mirrors the non-search People list
      -- (contacts.ts filters ct.archived_at only), so search and list stay consistent
      -- (a contact of an archived company still appears while the contact is active).
      AND (
        (p_archived_only AND ct.archived_at IS NOT NULL)
        OR (NOT p_archived_only AND ct.archived_at IS NULL)
      )
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

REVOKE ALL ON FUNCTION search_contacts_archive(UUID, TEXT, UUID[], TEXT[], TEXT[], INTEGER, INTEGER, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_contacts_archive(UUID, TEXT, UUID[], TEXT[], TEXT[], INTEGER, INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION search_contacts_archive(UUID, TEXT, UUID[], TEXT[], TEXT[], INTEGER, INTEGER, BOOLEAN) TO service_role;

-- ============================================================================
-- Archive-aware contact filter options RPC (E9 codex P2-3)
-- ----------------------------------------------------------------------------
-- The People page seniority/country dropdowns were derived from ALL contacts
-- including archived ones. This 013-based copy filters archived_at IS NULL.
-- New name so the live get_contact_filter_options (used elsewhere) is untouched;
-- the route falls back to the old RPC if this one is missing. Grant posture
-- matches 020: revoked from anon/authenticated, service_role only (the route
-- always calls it via supabaseAdmin).
CREATE OR REPLACE FUNCTION get_contact_filter_options_archive(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
    SELECT jsonb_build_object(
        'seniorities', COALESCE(
            (
                SELECT jsonb_agg(s ORDER BY s)
                FROM (
                    SELECT DISTINCT seniority AS s
                    FROM contacts
                    WHERE tenant_id = p_tenant_id
                      AND archived_at IS NULL
                      AND seniority IS NOT NULL
                ) sub
            ),
            '[]'::jsonb
        ),
        'countries', COALESCE(
            (
                SELECT jsonb_agg(c ORDER BY c)
                FROM (
                    SELECT DISTINCT country AS c
                    FROM contacts
                    WHERE tenant_id = p_tenant_id
                      AND archived_at IS NULL
                      AND country IS NOT NULL
                ) sub
            ),
            '[]'::jsonb
        )
    );
$$;

REVOKE ALL ON FUNCTION get_contact_filter_options_archive(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_contact_filter_options_archive(uuid) TO service_role;

-- ============================================================================
-- contact_count now counts ACTIVE contacts only (E9 codex P2-1)
-- ----------------------------------------------------------------------------
-- companies.contact_count is maintained by the trigger from 003_contacts.sql.
-- It counted ALL contacts, so an archived contact still inflated the badge. This
-- CREATE OR REPLACE keeps the function name/shape the existing triggers call and
-- only adds `archived_at IS NULL` to both COUNT subqueries. The existing
-- trg_contact_count_update is a bare `AFTER UPDATE ON contacts FOR EACH ROW`
-- trigger (no UPDATE OF column list), so it ALREADY fires when archived_at flips
-- — no trigger change is needed and none is made (additive, no DROP of the
-- shared triggers). A one-time idempotent backfill re-syncs existing rows.
CREATE OR REPLACE FUNCTION update_company_contact_count()
RETURNS TRIGGER AS $$
DECLARE
    target_company_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_company_id := OLD.company_id;
    ELSE
        target_company_id := NEW.company_id;
    END IF;

    UPDATE companies
    SET contact_count = (
        SELECT COUNT(*)::int FROM contacts
        WHERE company_id = target_company_id AND archived_at IS NULL
    )
    WHERE id = target_company_id;

    -- Handle company_id change (moved contact to different company)
    IF TG_OP = 'UPDATE' AND OLD.company_id IS DISTINCT FROM NEW.company_id THEN
        UPDATE companies
        SET contact_count = (
            SELECT COUNT(*)::int FROM contacts
            WHERE company_id = OLD.company_id AND archived_at IS NULL
        )
        WHERE id = OLD.company_id;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- One-time backfill: recompute every company's contact_count as active-only.
-- Idempotent (re-running lands on the same value); guarded to touch only rows
-- whose stored count is stale so a re-apply is cheap.
UPDATE companies co
SET contact_count = sub.cnt
FROM (
    SELECT c.id, COUNT(ct.id)::int AS cnt
    FROM companies c
    LEFT JOIN contacts ct
      ON ct.company_id = c.id AND ct.archived_at IS NULL
    GROUP BY c.id
) sub
WHERE co.id = sub.id
  AND co.contact_count IS DISTINCT FROM sub.cnt;
