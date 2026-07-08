-- ==========================================
-- TG-Research v2 — WP2 hardening 2 (codex P2)  [090]
--
-- research_persist_geo_analysis (086) projected estimate/confidence/rationale with
-- COALESCE(p_x, x): a re-analysis that VALIDLY concludes "no estimate" (NULL) kept the
-- stale previous values on the row, so the cells table / coverage math kept rendering an
-- E that no longer belongs to the spec of record. The spec is written whole-object; the
-- projected columns must track it the same way — direct assignment, NULL included.
-- (Same reasoning as the PATCH route, which already assigns directly on a human edit.)
-- ==========================================

CREATE OR REPLACE FUNCTION research_persist_geo_analysis(
  p_tenant     UUID,
  p_geo_id     UUID,
  p_job_id     UUID,
  p_worker     TEXT,
  p_lease      UUID,
  p_spec       JSONB,
  p_estimate   INTEGER DEFAULT NULL,
  p_confidence NUMERIC DEFAULT NULL,
  p_rationale  TEXT DEFAULT NULL
)
RETURNS SETOF research_geographies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Fence (063 pattern): only the attempt that currently holds the lease may persist.
  PERFORM 1 FROM research_jobs
   WHERE id = p_job_id AND tenant_id = p_tenant
     AND status = 'running' AND locked_by = p_worker AND lease IS NOT DISTINCT FROM p_lease
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_persist_geo_analysis: lease lost for job % (worker=%, fenced)', p_job_id, p_worker
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_spec IS NULL OR jsonb_typeof(p_spec) <> 'object' THEN
    RAISE EXCEPTION 'research_persist_geo_analysis: spec must be a JSON object';
  END IF;

  -- Re-analysis of an approved cell demotes it: a regenerated spec must be re-approved.
  -- Projection is direct assignment — the columns track THIS spec, nulls and all.
  RETURN QUERY
  UPDATE research_geographies
     SET spec                = p_spec,
         ai_draft            = p_spec,
         estimate            = p_estimate,
         confidence          = p_confidence,
         rationale           = p_rationale,
         generated_by_job_id = p_job_id,
         status              = 'draft'
   WHERE id = p_geo_id AND tenant_id = p_tenant
  RETURNING *;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_persist_geo_analysis: geography % not found for tenant %', p_geo_id, p_tenant;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION research_persist_geo_analysis(UUID, UUID, UUID, TEXT, UUID, JSONB, INTEGER, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_persist_geo_analysis(UUID, UUID, UUID, TEXT, UUID, JSONB, INTEGER, NUMERIC, TEXT) TO service_role;
