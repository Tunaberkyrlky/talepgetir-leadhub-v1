-- ==========================================
-- TG-Research v2 — WP2: market structure → sub-ICP (geo-instantiation)  [086]
--
-- research_geographies (056, schema-only until now) becomes the SUB-ICP cell: the ICP
-- instantiated for ONE country — local-language terms, localized signals, key channels
-- (WP3 seed), certifications, buyer titles (persona seed), market-structure notes and
-- an E estimate. geo:analyze (worker) drafts it; the customer edits + approves (same
-- human-gate philosophy as the ICP itself). Harvest runs may then pass geo_id and the
-- engine consumes the spec for query building + validation context.
--
-- NO billing coupling: verdicts stay keyed to (icp, ruleset_version). A geo spec change
-- affects DISCOVERY quality only, so it carries no version/CAS machinery beyond
-- draft/approved status.
--   • spec      — the editable final (structured JSONB, zod-validated app-side)
--   • ai_draft  — frozen model output (eval: how much the human changed)
--   • one cell per (tenant, icp, country) — re-analyze updates the same row
--   • research_persist_geo_analysis — fenced writer (063 pattern); re-analysis demotes
--     an approved cell back to draft (a regenerated spec must be re-approved).
-- ==========================================

ALTER TABLE research_geographies
  ADD COLUMN IF NOT EXISTS spec JSONB,
  ADD COLUMN IF NOT EXISTS ai_draft JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS generated_by_job_id UUID REFERENCES research_jobs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_geographies_icp_country
  ON research_geographies(tenant_id, icp_id, lower(country)) WHERE icp_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_research_geographies_icp
  ON research_geographies(tenant_id, icp_id, status);

-- ------------------------------------------
-- Fenced analysis persistence (geo:analyze worker writer)
-- ------------------------------------------
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
  RETURN QUERY
  UPDATE research_geographies
     SET spec                = p_spec,
         ai_draft            = p_spec,
         estimate            = COALESCE(p_estimate, estimate),
         confidence          = COALESCE(p_confidence, confidence),
         rationale           = COALESCE(p_rationale, rationale),
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
