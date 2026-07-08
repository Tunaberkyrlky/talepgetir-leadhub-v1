-- ==========================================
-- TG-Research v2 — WP3 hardening (2-lens review P3)  [093]
--
-- fully_covered was computed CALLER-SIDE from a prior chunk read taken minutes before the
-- write: a Y3 run and a concurrent channels job (different types — in-flight guards don't
-- exclude each other) could persist fully_covered=true next to saturation_a=false, or leave
-- a genuinely covered cell 'running' forever. The RPC knows both post-COALESCE flags at
-- UPDATE time — compute A && B there. p_fully_covered stays in the signature for call-site
-- compatibility but is now IGNORED.
-- ==========================================

CREATE OR REPLACE FUNCTION research_update_chunk_coverage(
  p_tenant             UUID,
  p_job_id             UUID,
  p_worker             TEXT,
  p_lease              UUID,
  p_project            UUID,
  p_icp                UUID,
  p_geo                UUID,
  p_angle_delta        JSONB   DEFAULT NULL,
  p_queries_delta      INTEGER DEFAULT 0,
  p_last_two_new_domains INTEGER DEFAULT NULL,
  p_found_count        INTEGER DEFAULT NULL,
  p_estimate           INTEGER DEFAULT NULL,
  p_channels_found     INTEGER DEFAULT NULL,
  p_channels_harvested INTEGER DEFAULT NULL,
  p_saturation_a       BOOLEAN DEFAULT NULL,
  p_saturation_b       BOOLEAN DEFAULT NULL,
  p_fully_covered      BOOLEAN DEFAULT NULL,  -- IGNORED since 093 (computed below)
  p_rounds_no_new      INTEGER DEFAULT NULL,
  p_coverage           JSONB   DEFAULT NULL
)
RETURNS SETOF research_chunks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key  TEXT;
  v_row  research_chunks;
BEGIN
  -- Fence (063 pattern): only the attempt that currently holds the lease may persist.
  PERFORM 1 FROM research_jobs
   WHERE id = p_job_id AND tenant_id = p_tenant
     AND status = 'running' AND locked_by = p_worker AND lease IS NOT DISTINCT FROM p_lease
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_update_chunk_coverage: lease lost for job % (worker=%, fenced)', p_job_id, p_worker
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_icp IS NULL OR p_geo IS NULL THEN
    RAISE EXCEPTION 'research_update_chunk_coverage: icp and geo are required (cell identity)';
  END IF;
  IF p_angle_delta IS NOT NULL AND jsonb_typeof(p_angle_delta) <> 'object' THEN
    RAISE EXCEPTION 'research_update_chunk_coverage: angle_delta must be a JSON object';
  END IF;
  IF p_coverage IS NOT NULL AND jsonb_typeof(p_coverage) <> 'object' THEN
    RAISE EXCEPTION 'research_update_chunk_coverage: coverage must be a JSON object';
  END IF;

  -- Ensure the cell chunk exists (cumulative row-of-record; 091 unique index keys the upsert).
  INSERT INTO research_chunks (tenant_id, project_id, icp_id, geo_id, status)
  VALUES (p_tenant, p_project, p_icp, p_geo, 'running')
  ON CONFLICT (tenant_id, icp_id, geo_id) WHERE icp_id IS NOT NULL AND geo_id IS NOT NULL
  DO NOTHING;

  SELECT * INTO v_row FROM research_chunks
   WHERE tenant_id = p_tenant AND icp_id = p_icp AND geo_id = p_geo
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_update_chunk_coverage: chunk row missing for cell (%, %)', p_icp, p_geo;
  END IF;

  -- Merge angle deltas: per-key numeric addition (missing key = 0).
  IF p_angle_delta IS NOT NULL THEN
    FOR v_key IN SELECT jsonb_object_keys(p_angle_delta) LOOP
      v_row.angle_stats := jsonb_set(
        v_row.angle_stats,
        ARRAY[v_key],
        to_jsonb(COALESCE((v_row.angle_stats ->> v_key)::numeric, 0) + COALESCE((p_angle_delta ->> v_key)::numeric, 0))
      );
    END LOOP;
  END IF;

  -- fully_covered = rule A AND rule B, evaluated on the POST-update flags under the row lock —
  -- never from a caller's stale prior read (093).
  RETURN QUERY
  UPDATE research_chunks c
     SET angle_stats          = v_row.angle_stats,
         queries_total        = c.queries_total + GREATEST(COALESCE(p_queries_delta, 0), 0),
         last_two_new_domains = COALESCE(p_last_two_new_domains, c.last_two_new_domains),
         found_count          = COALESCE(p_found_count, c.found_count),
         estimate             = COALESCE(p_estimate, c.estimate),
         channels_found       = COALESCE(p_channels_found, c.channels_found),
         channels_harvested   = COALESCE(p_channels_harvested, c.channels_harvested),
         saturation_a         = COALESCE(p_saturation_a, c.saturation_a),
         saturation_b         = COALESCE(p_saturation_b, c.saturation_b),
         fully_covered        = COALESCE(p_saturation_a, c.saturation_a) AND COALESCE(p_saturation_b, c.saturation_b),
         discovery_rounds_no_new = COALESCE(p_rounds_no_new, c.discovery_rounds_no_new),
         coverage             = CASE WHEN p_coverage IS NULL THEN c.coverage ELSE c.coverage || p_coverage END,
         status               = CASE WHEN COALESCE(p_saturation_a, c.saturation_a) AND COALESCE(p_saturation_b, c.saturation_b) THEN 'done' ELSE 'running' END
   WHERE c.id = v_row.id AND c.tenant_id = p_tenant
  RETURNING *;
END;
$$;
REVOKE ALL ON FUNCTION research_update_chunk_coverage(UUID, UUID, TEXT, UUID, UUID, UUID, UUID, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_update_chunk_coverage(UUID, UUID, TEXT, UUID, UUID, UUID, UUID, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, JSONB) TO service_role;
