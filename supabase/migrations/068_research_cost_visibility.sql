-- ==========================================
-- TG-Research v2 — COGS visibility split: admin sees costs, customers NEVER do
-- ------------------------------------------------------------------------------
-- Requirement (product): real costs (USD COGS — LLM tokens, grounding fees, fetch spend) are an
-- INTERNAL margin signal. Customers see leads/credits (counts), never dollars. Until now the
-- 062 "user clients SELECT-only" posture still exposed dollar figures to a customer's OWN JWT
-- via direct PostgREST reads (the API never returned them, but the DB grant did):
--   • research_jobs.result        → cost_usd / cost_recheck / usage_raw (the full COGS breakdown)
--   • research_jobs.payload       → caps.maxSpendUsd (the operator's per-run USD budget)
--   • research_search_log.cost_usd, research_billable_events.amount_usd / pricing_version
--
-- Fix = COLUMN-LEVEL grants (structural, not app-discipline): authenticated keeps tenant-scoped
-- SELECT on the operational columns and loses the dollar-bearing ones. The app/worker (service
-- role) is unaffected; the API serves customers a sanitized job view and serves internal roles
-- (superadmin/ops_agent) the full one.
--
-- Plus the margin-panel read (01 §3 D11): research_admin_cost_summary — a cross-tenant COGS/
-- revenue aggregate for the internal admin panel only (service_role-only EXECUTE; the route
-- gates on internal roles).
--
-- Additive + re-runnable.
-- ==========================================


-- ============================================================================
-- research_jobs — hide result (COGS breakdown) + payload (spend caps) from client JWTs
-- The RLS SELECT policy (tenant-scoped) still applies on top of these grants.
-- ============================================================================
REVOKE SELECT ON research_jobs FROM anon, authenticated;
GRANT SELECT (
  id, tenant_id, project_id, type, status, priority, attempts, max_attempts,
  progress, error, scheduled_at, locked_by, locked_at, heartbeat_at,
  started_at, finished_at, created_by, created_at, updated_at, lease
) ON research_jobs TO authenticated;

-- ============================================================================
-- research_search_log — pure COGS ledger; no customer-facing purpose at all
-- ============================================================================
REVOKE SELECT ON research_search_log FROM anon, authenticated;
DROP POLICY IF EXISTS research_search_log_select ON research_search_log;

-- ============================================================================
-- research_billable_events — customers may see WHAT was billed (usage transparency:
-- company, canonical key, when), never the internal USD amount / price book
-- ============================================================================
REVOKE SELECT ON research_billable_events FROM anon, authenticated;
GRANT SELECT (
  id, tenant_id, company_id, canonical_key, unit, ledger_id, job_id, created_at
) ON research_billable_events TO authenticated;


-- ============================================================================
-- research_admin_cost_summary — per-tenant margin panel (internal only)
-- ----------------------------------------------------------------------------
-- One row per tenant with research activity, in the optional [p_from, p_to) window (job/billing
-- rows filtered by created_at; balances are CURRENT, not windowed):
--   harvest_runs / failed_runs   succeeded vs failed harvest:run jobs
--   harvest_cost_usd             Σ result.cost_usd.totalUsd over SUCCEEDED harvest runs — the
--                                run-level COGS (search + LLM + fetch). NOTE: failed runs' partial
--                                spend is NOT in job results (logged only) → this slightly
--                                UNDERSTATES true COGS; failed_runs is surfaced so the operator
--                                sees how much is unaccounted.
--   search_cost_usd              Σ research_search_log.cost_usd — a SUBSET of harvest_cost_usd
--                                (the tracker feeds search cost into the run total); shown as its
--                                own line for provider reconciliation, do NOT add the two.
--   icp_runs                     succeeded icp:generate jobs (Opus setup cost, not yet metered
--                                into results — placeholder for the setup-cost line).
--   billed_leads                 billable_events in the window (revenue units).
--   credits_balance/reserved     current ledger SUM(delta) / open holds outstanding.
--   cost_per_lead_usd            harvest_cost_usd / billed_leads (NULL when nothing billed).
-- ============================================================================
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
           count(*) FILTER (WHERE j.type = 'icp:generate' AND j.status = 'succeeded') AS icp_runs
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

-- Cheap support for run-history reads (admin panel: newest harvest runs first).
CREATE INDEX IF NOT EXISTS idx_research_jobs_type_created
  ON research_jobs(type, created_at DESC);
