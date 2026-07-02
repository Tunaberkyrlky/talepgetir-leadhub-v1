-- ==========================================
-- TG-Research v2 — Admin cost summary: ICP-setup cost line (1b excluded-costs item)
-- ------------------------------------------------------------------------------
-- icp:generate results now carry usage_raw + cost_usd (the Opus setup spend was previously
-- unmetered — the only excluded LLM cost line). Surface it per tenant in the margin panel.
-- RETURNS TABLE changes (adds icp_cost_usd) → DROP + CREATE (a return-type change cannot be
-- CREATE OR REPLACE'd). Additive + re-runnable.
-- ==========================================

DROP FUNCTION IF EXISTS research_admin_cost_summary(TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION research_admin_cost_summary(
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to   TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  tenant_id         UUID,
  tenant_name       TEXT,
  harvest_runs      BIGINT,
  failed_runs       BIGINT,
  harvest_cost_usd  NUMERIC,
  search_cost_usd   NUMERIC,
  icp_runs          BIGINT,
  icp_cost_usd      NUMERIC,
  billed_leads      BIGINT,
  credits_balance   BIGINT,
  credits_reserved  BIGINT,
  cost_per_lead_usd NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH active AS (
    SELECT DISTINCT tenant_id FROM research_jobs
    UNION SELECT DISTINCT tenant_id FROM research_usage_ledger
    UNION SELECT DISTINCT tenant_id FROM research_billable_events
  ),
  jobs AS (
    SELECT j.tenant_id,
           count(*) FILTER (WHERE j.type = 'harvest:run' AND j.status = 'succeeded') AS harvest_runs,
           count(*) FILTER (WHERE j.type = 'harvest:run' AND j.status = 'failed')    AS failed_runs,
           COALESCE(sum(
             CASE WHEN j.type = 'harvest:run' AND j.status = 'succeeded'
                  THEN NULLIF(j.result->'cost_usd'->>'totalUsd','')::numeric END
           ), 0)                                                                     AS harvest_cost_usd,
           count(*) FILTER (WHERE j.type = 'icp:generate' AND j.status = 'succeeded') AS icp_runs,
           COALESCE(sum(
             CASE WHEN j.type = 'icp:generate' AND j.status = 'succeeded'
                  THEN NULLIF(j.result->'cost_usd'->>'totalUsd','')::numeric END
           ), 0)                                                                     AS icp_cost_usd
    FROM research_jobs j
    WHERE (p_from IS NULL OR j.created_at >= p_from)
      AND (p_to   IS NULL OR j.created_at <  p_to)
    GROUP BY j.tenant_id
  ),
  search AS (
    SELECT s.tenant_id, COALESCE(sum(s.cost_usd), 0) AS search_cost_usd
    FROM research_search_log s
    WHERE (p_from IS NULL OR s.created_at >= p_from)
      AND (p_to   IS NULL OR s.created_at <  p_to)
    GROUP BY s.tenant_id
  ),
  billed AS (
    SELECT b.tenant_id, count(*) AS billed_leads
    FROM research_billable_events b
    WHERE (p_from IS NULL OR b.created_at >= p_from)
      AND (p_to   IS NULL OR b.created_at <  p_to)
    GROUP BY b.tenant_id
  ),
  ledger AS (
    SELECT l.tenant_id, COALESCE(sum(l.delta), 0)::bigint AS credits_balance
    FROM research_usage_ledger l
    GROUP BY l.tenant_id
  ),
  holds AS (
    SELECT h.tenant_id, COALESCE(sum(h.reserved - h.settled - h.released), 0)::bigint AS credits_reserved
    FROM research_usage_holds h
    WHERE h.status = 'open'
    GROUP BY h.tenant_id
  )
  SELECT
    a.tenant_id,
    t.name                                   AS tenant_name,
    COALESCE(j.harvest_runs, 0)              AS harvest_runs,
    COALESCE(j.failed_runs, 0)               AS failed_runs,
    COALESCE(j.harvest_cost_usd, 0)          AS harvest_cost_usd,
    COALESCE(s.search_cost_usd, 0)           AS search_cost_usd,
    COALESCE(j.icp_runs, 0)                  AS icp_runs,
    COALESCE(j.icp_cost_usd, 0)              AS icp_cost_usd,
    COALESCE(b.billed_leads, 0)              AS billed_leads,
    COALESCE(l.credits_balance, 0)           AS credits_balance,
    COALESCE(h.credits_reserved, 0)          AS credits_reserved,
    CASE WHEN COALESCE(b.billed_leads, 0) > 0
         THEN round(COALESCE(j.harvest_cost_usd, 0) / b.billed_leads, 6) END AS cost_per_lead_usd
  FROM active a
  LEFT JOIN tenants t  ON t.id = a.tenant_id
  LEFT JOIN jobs   j   ON j.tenant_id = a.tenant_id
  LEFT JOIN search s   ON s.tenant_id = a.tenant_id
  LEFT JOIN billed b   ON b.tenant_id = a.tenant_id
  LEFT JOIN ledger l   ON l.tenant_id = a.tenant_id
  LEFT JOIN holds  h   ON h.tenant_id = a.tenant_id
  ORDER BY COALESCE(j.harvest_cost_usd, 0) DESC, a.tenant_id;
$$;
REVOKE ALL ON FUNCTION research_admin_cost_summary(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_admin_cost_summary(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
