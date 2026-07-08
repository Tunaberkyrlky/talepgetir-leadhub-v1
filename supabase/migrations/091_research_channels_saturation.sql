-- ==========================================
-- TG-Research v2 — WP3: Y1 channel discovery + list harvest + PERSISTENT saturation  [091]
--
-- research_channels (056, schema-only until now) comes alive: channels:discover writes the
-- company-list sources it finds for one sub-ICP cell (geo_id = the WP2 cell), channels:harvest
-- marks them harvested/unreachable. research_chunks becomes the CUMULATIVE coverage record of
-- a cell across runs — the Y3 saturation flags stop being run-local job metadata and persist,
-- and the 32-query minimum is evaluated per CELL (cumulative), not per RUN.
--
-- NO billing coupling: chunk coverage is advisory analytics. Candidate money still flows only
-- through the fenced verdict/billing RPCs (067-070); research_update_chunk_coverage touches
-- research_chunks alone and is lease-fenced like every other worker writer (063 pattern).
-- ==========================================

-- ------------------------------------------
-- Channels: harvest bookkeeping + per-cell URL dedup
-- ------------------------------------------
ALTER TABLE research_channels
  ADD COLUMN IF NOT EXISTS discovered_by_job_id UUID REFERENCES research_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS harvest_job_id       UUID REFERENCES research_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS harvested_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS companies_found      INTEGER,
  ADD COLUMN IF NOT EXISTS harvest_error        TEXT;

-- One row per (cell, url): re-discovery upserts instead of duplicating. Cell-scoped (not
-- global) on purpose — the same directory legitimately serves multiple ICPs/countries.
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_channels_cell_url
  ON research_channels(tenant_id, icp_id, geo_id, lower(url))
  WHERE url IS NOT NULL AND icp_id IS NOT NULL AND geo_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_research_channels_cell
  ON research_channels(tenant_id, icp_id, geo_id, harvest_status);

-- ------------------------------------------
-- Chunks: ONE cumulative row per cell + persisted saturation
-- ------------------------------------------
ALTER TABLE research_chunks
  ADD COLUMN IF NOT EXISTS angle_stats        JSONB   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS queries_total      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_two_new_domains INTEGER,
  ADD COLUMN IF NOT EXISTS channels_found     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS channels_harvested INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS saturation_a       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS saturation_b       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS discovery_rounds_no_new INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_chunks_cell
  ON research_chunks(tenant_id, icp_id, geo_id)
  WHERE icp_id IS NOT NULL AND geo_id IS NOT NULL;

-- ------------------------------------------
-- Fenced cumulative coverage writer (worker-only)
--   • angle_stats delta is MERGED (per-key numeric add) atomically in the DB — two runs on
--     the same cell can't lose each other's counts to a read-modify-write race.
--   • NULL scalar params mean "leave as is" (intentional partial-update semantics, unlike the
--     090 projection which mirrors a whole-object spec).
--   • found_count/estimate are ABSOLUTE (caller computes the authoritative number).
-- ------------------------------------------
CREATE OR REPLACE FUNCTION research_update_chunk_coverage(
  p_tenant             UUID,
  p_job_id             UUID,
  p_worker             TEXT,
  p_lease              UUID,
  p_project            UUID,
  p_icp                UUID,
  p_geo                UUID,
  p_angle_delta        JSONB   DEFAULT NULL,  -- {"3:directory_site_filter": 2, ...} query-count deltas
  p_queries_delta      INTEGER DEFAULT 0,
  p_last_two_new_domains INTEGER DEFAULT NULL,
  p_found_count        INTEGER DEFAULT NULL,
  p_estimate           INTEGER DEFAULT NULL,
  p_channels_found     INTEGER DEFAULT NULL,
  p_channels_harvested INTEGER DEFAULT NULL,
  p_saturation_a       BOOLEAN DEFAULT NULL,
  p_saturation_b       BOOLEAN DEFAULT NULL,
  p_fully_covered      BOOLEAN DEFAULT NULL,
  p_rounds_no_new      INTEGER DEFAULT NULL,
  p_coverage           JSONB   DEFAULT NULL   -- merged shallow (per-key replace)
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
         fully_covered        = COALESCE(p_fully_covered, c.fully_covered),
         discovery_rounds_no_new = COALESCE(p_rounds_no_new, c.discovery_rounds_no_new),
         coverage             = CASE WHEN p_coverage IS NULL THEN c.coverage ELSE c.coverage || p_coverage END,
         status               = CASE WHEN COALESCE(p_fully_covered, c.fully_covered) THEN 'done' ELSE 'running' END
   WHERE c.id = v_row.id AND c.tenant_id = p_tenant
  RETURNING *;
END;
$$;
REVOKE ALL ON FUNCTION research_update_chunk_coverage(UUID, UUID, TEXT, UUID, UUID, UUID, UUID, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_update_chunk_coverage(UUID, UUID, TEXT, UUID, UUID, UUID, UUID, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, JSONB) TO service_role;
