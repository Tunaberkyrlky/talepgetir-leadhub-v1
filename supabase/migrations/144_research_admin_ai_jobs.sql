-- ============================================================================
-- 144 — research_admin_ai_jobs: raw per-job LLM usage for the step/model breakdown
-- ============================================================================
-- The existing research_admin_cost_summary only surfaces THREE cost buckets
-- (harvest:run, icp:generate, search_log). Every OTHER AI step — profile:crawl
-- (the "AI visited the site" step), geo:analyze, offer:generate, hs:match,
-- icp:revise — records its spend into result.usage_raw + result.cost_usd but was
-- invisible on the panel, so a wizard run that clearly used AI showed $0 COGS.
--
-- This RPC returns the RAW meter tally (usage_raw) per succeeded metered job so the
-- API can (a) sum a per-STEP breakdown and (b) recompute a per-MODEL/provider dollar
-- rollup at the CURRENT rate book (pricing.ts) — uniform across every job type,
-- including harvest which stores usage_raw alongside its tracker cost_usd.
--
-- Only succeeded jobs that actually metered LLM calls are returned (usage_raw
-- present). Failed-but-paid partials are surfaced elsewhere (failed_cost_usd) and
-- deliberately excluded here to keep the step/model totals a clean successful-COGS
-- picture. Additive + re-runnable. SECURITY DEFINER, search_path pinned,
-- service_role-only EXECUTE (the admin API is the only caller).

DROP FUNCTION IF EXISTS research_admin_ai_jobs(TIMESTAMPTZ, TIMESTAMPTZ, UUID);

CREATE OR REPLACE FUNCTION research_admin_ai_jobs(
  p_from   TIMESTAMPTZ DEFAULT NULL,
  p_to     TIMESTAMPTZ DEFAULT NULL,
  p_tenant UUID        DEFAULT NULL
)
RETURNS TABLE (
  job_type    TEXT,
  tenant_id   UUID,
  tenant_name TEXT,
  usage_raw   JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Return only usage_raw (the raw meter tally). The API recomputes every dollar figure
  -- from it at the current rate book, so we deliberately do NOT cast result.cost_usd here:
  -- one malformed historical totalUsd would otherwise fail the whole RPC and deny the panel.
  SELECT
    j.type                                         AS job_type,
    j.tenant_id,
    t.name                                         AS tenant_name,
    j.result->'usage_raw'                          AS usage_raw
  FROM research_jobs j
  LEFT JOIN tenants t ON t.id = j.tenant_id
  WHERE j.status = 'succeeded'
    AND j.result ? 'usage_raw'
    AND jsonb_typeof(j.result->'usage_raw') = 'object'
    AND (p_from   IS NULL OR j.created_at >= p_from)
    AND (p_to     IS NULL OR j.created_at <  p_to)
    AND (p_tenant IS NULL OR j.tenant_id = p_tenant);
$$;

REVOKE ALL ON FUNCTION research_admin_ai_jobs(TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_admin_ai_jobs(TIMESTAMPTZ, TIMESTAMPTZ, UUID) TO service_role;
