-- ==========================================
-- TG-Research v2 — Hunter enrichment COGS visibility (admin margin panel)
-- ------------------------------------------------------------------------------
-- Closes the P3 gap named in 04_ILERLEME.md §4.15 / 05_SONRAKI_ADIMLAR.md: the admin
-- margin panel had no Hunter-request COGS line. Every enrich:run domain-search request is
-- one Hunter credit; the handler already records the per-run request count in the job
-- result (summary.hunter_requests, top-level). This surfaces it per tenant.
--
--   • enrich_runs      — succeeded enrich:run jobs in the window
--   • hunter_requests  — Σ result->>'hunter_requests' over enrich:run jobs (ANY status: a
--                        request spends a credit even if the job later failed; only
--                        succeeded runs actually write the summary, so failed partials that
--                        never returned a summary contribute 0 — a documented under-count,
--                        same shape as failed harvest COGS)
--   • hunter_cost_usd  — hunter_requests × p_hunter_usd (per-request USD rate; the caller
--                        passes RESEARCH_PRICE_HUNTER_REQUEST — 0 on the free/trial plan, so
--                        the raw request COUNT stays the meaningful figure until a paid
--                        Hunter plan sets a real rate). Clamped ≥ 0.
--
-- This is a REPORTING RPC only — it touches no billing/ledger/hold state, and enrichment is
-- billed separately (research_enrichment_events + research_bill_enrichment). The per-lead
-- harvest COGS (cost_per_lead_usd) deliberately does NOT fold in Hunter cost: enrichment is a
-- distinct product line, not part of producing one MATCH.
--
-- Signature CHANGE (added p_hunter_usd) → DROP the old 2-arg overload first so a 2-arg call
-- can't become ambiguous against the new default-bearing 3-arg. RETURNS TABLE also grows →
-- DROP + CREATE regardless. Additive + re-runnable. SECURITY DEFINER, search_path pinned,
-- service_role-only EXECUTE.
-- ==========================================

DROP FUNCTION IF EXISTS research_admin_cost_summary(TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION research_admin_cost_summary(
  p_from       TIMESTAMPTZ DEFAULT NULL,
  p_to         TIMESTAMPTZ DEFAULT NULL,
  p_hunter_usd NUMERIC     DEFAULT 0
)
RETURNS TABLE (
  tenant_id         UUID,
  tenant_name       TEXT,
  harvest_runs      BIGINT,
  failed_runs       BIGINT,
  harvest_cost_usd  NUMERIC,
  failed_cost_usd   NUMERIC,
  search_cost_usd   NUMERIC,
  icp_runs          BIGINT,
  icp_cost_usd      NUMERIC,
  enrich_runs       BIGINT,
  hunter_requests   BIGINT,
  hunter_cost_usd   NUMERIC,
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
    UNION SELECT DISTINCT tenant_id FROM research_projects
    UNION SELECT DISTINCT tenant_id FROM research_search_log
    UNION SELECT DISTINCT tenant_id FROM research_usage_holds
    UNION SELECT DISTINCT tenant_id FROM research_tenant_settings
  ),
  jobs AS (
    SELECT j.tenant_id,
           count(*) FILTER (WHERE j.type = 'harvest:run' AND j.status = 'succeeded') AS harvest_runs,
           count(*) FILTER (WHERE j.type = 'harvest:run' AND j.status = 'failed')    AS failed_runs,
           COALESCE(sum(
             CASE WHEN j.type = 'harvest:run' AND j.status = 'succeeded'
                  THEN NULLIF(j.result->'cost_usd'->>'totalUsd','')::numeric END
           ), 0)                                                                     AS harvest_cost_usd,
           -- Başarısız attempt'lerin kısmi COGS'u (LLM+grounding; runner failJob'a yazar).
           COALESCE(sum(
             CASE WHEN j.status = 'failed'
                  THEN NULLIF(j.result->'cost_recheck'->>'totalUsd','')::numeric END
           ), 0)                                                                     AS failed_cost_usd,
           count(*) FILTER (WHERE j.type = 'icp:generate' AND j.status = 'succeeded') AS icp_runs,
           COALESCE(sum(
             CASE WHEN j.type = 'icp:generate' AND j.status = 'succeeded'
                  THEN NULLIF(j.result->'cost_usd'->>'totalUsd','')::numeric END
           ), 0)                                                                     AS icp_cost_usd,
           count(*) FILTER (WHERE j.type = 'enrich:run' AND j.status = 'succeeded') AS enrich_runs,
           -- Hunter request count is a TOP-LEVEL result key (not under cost_usd). Sum over ALL
           -- enrich:run statuses; only succeeded runs return a summary, so failed partials add 0.
           COALESCE(sum(
             CASE WHEN j.type = 'enrich:run'
                  THEN NULLIF(j.result->>'hunter_requests','')::numeric END
           ), 0)::bigint                                                             AS hunter_requests
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
    COALESCE(j.failed_cost_usd, 0)           AS failed_cost_usd,
    COALESCE(s.search_cost_usd, 0)           AS search_cost_usd,
    COALESCE(j.icp_runs, 0)                  AS icp_runs,
    COALESCE(j.icp_cost_usd, 0)              AS icp_cost_usd,
    COALESCE(j.enrich_runs, 0)               AS enrich_runs,
    COALESCE(j.hunter_requests, 0)           AS hunter_requests,
    round(COALESCE(j.hunter_requests, 0) * GREATEST(COALESCE(p_hunter_usd, 0), 0), 6) AS hunter_cost_usd,
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
REVOKE ALL ON FUNCTION research_admin_cost_summary(TIMESTAMPTZ, TIMESTAMPTZ, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_admin_cost_summary(TIMESTAMPTZ, TIMESTAMPTZ, NUMERIC) TO service_role;
