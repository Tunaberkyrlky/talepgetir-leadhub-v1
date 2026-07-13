-- 132_research_market_evidence_cas.sql
-- WP11 re-review (R2, TOCTOU/atomicity): editing an approved HS code purged its cached
-- Comtrade evidence (research_markets), but the purge and the market:analyze worker's
-- delete-then-insert were BOTH non-atomic app-level sequences with a race between them:
--
--   worker: hsRowStillCurrent() check PASSES ─┐
--   PATCH : UPDATE code + DELETE evidence ────┼─ worker then DELETE+INSERT re-seeds the
--   worker: DELETE + INSERT (stale) ──────────┘  exact stale evidence the PATCH just purged.
--
-- hsRowStillCurrent() also FAILED-OPEN (a transient read error returned true = "still
-- current" and let the stale insert proceed). Two structural fixes here — no app-level
-- check-then-write gap survives:
--
--   1. research_update_hs_code  — the PATCH's code/status/description UPDATE *and* the
--      stale-evidence purge run in ONE transaction, holding a FOR UPDATE lock on the HS row
--      for the whole edit. Atomic: the code can never change without its evidence purge
--      committing in the same transaction (previously a crash between the two left stale rows).
--
--   2. research_persist_market_slice — the worker's per-(hs_code_id, kind) evidence
--      delete+insert goes through a CAS: it re-locks the HS row FOR UPDATE and requires it to
--      still carry the EXACT (code, updated_at, status='approved') the worker loaded before its
--      slow Comtrade calls. The FOR UPDATE serializes against research_update_hs_code, so a
--      concurrent edit either (a) already bumped updated_at → CAS fails, worker skips; or
--      (b) blocks on the lock until the worker's slice commits, then the edit's own purge runs
--      AFTER and clears it. Returns -1 on a CAS miss (skipped as stale) vs the inserted count.
--
-- research_markets is a derived Comtrade cache (not a billable record), so delete+re-insert
-- is safe. Both functions are SECURITY DEFINER + service_role-only (the route and worker both
-- call via researchSupabaseAdmin / service role).

-- ── 1. Atomic HS-code edit + stale-evidence purge (PATCH /research/hs/:id) ───────────
CREATE OR REPLACE FUNCTION research_update_hs_code(
  p_tenant          UUID,
  p_id              UUID,
  p_set_status      BOOLEAN,
  p_status          TEXT,
  p_set_code        BOOLEAN,
  p_code            TEXT,
  p_set_description BOOLEAN,
  p_description     TEXT
)
RETURNS SETOF research_hs_codes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_code     TEXT;
  v_code_changed BOOLEAN := false;
BEGIN
  -- Lock the target row for the whole transaction: the code edit + evidence purge become
  -- atomic AND serialize against research_persist_market_slice's FOR UPDATE CAS (a worker
  -- persist either commits before we lock — then our purge clears its rows — or blocks until
  -- we commit the bumped updated_at, after which its CAS fails and it skips).
  SELECT code INTO v_old_code
    FROM research_hs_codes
   WHERE id = p_id AND tenant_id = p_tenant
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;  -- empty set → caller maps to 404
  END IF;

  -- A code edit onto an existing (tenant, project, code) collides with the unique index
  -- (migration 122) and raises 23505 here; the route maps that SQLSTATE to a 409.
  v_code_changed := p_set_code AND (p_code IS DISTINCT FROM v_old_code);

  RETURN QUERY
  UPDATE research_hs_codes
     SET status      = CASE WHEN p_set_status      THEN p_status      ELSE status      END,
         code        = CASE WHEN p_set_code        THEN p_code        ELSE code        END,
         description = CASE WHEN p_set_description  THEN p_description ELSE description END
   WHERE id = p_id AND tenant_id = p_tenant
  RETURNING *;
  -- updated_at auto-bumps via the research_hs_codes_updated_at trigger (056) on any UPDATE.

  IF v_code_changed THEN
    -- The code moved → every research_markets row under this hs_code_id (world-import +
    -- bilateral) now describes the OLD product; drop it in the SAME transaction.
    DELETE FROM research_markets
     WHERE tenant_id = p_tenant AND hs_code_id = p_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION research_update_hs_code(UUID, UUID, BOOLEAN, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_update_hs_code(UUID, UUID, BOOLEAN, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT) TO service_role;

-- ── 2. CAS-guarded market-evidence slice writer (market:analyze worker) ──────────────
CREATE OR REPLACE FUNCTION research_persist_market_slice(
  p_tenant              UUID,
  p_project             UUID,
  p_hs_code_id          UUID,
  p_expected_code       TEXT,
  p_expected_updated_at TIMESTAMPTZ,
  p_kind                TEXT,
  p_rows                JSONB DEFAULT '[]'::jsonb
)
RETURNS INTEGER  -- rows inserted (>=0), or -1 when the CAS rejected the write (stale HS row)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted INTEGER := 0;
BEGIN
  IF p_kind NOT IN ('world_import', 'bilateral_export') THEN
    RAISE EXCEPTION 'research_persist_market_slice: invalid kind %', p_kind;
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'research_persist_market_slice: rows must be a JSON array';
  END IF;

  -- CAS + serialization. Lock the HS row and require it STILL carries the exact snapshot the
  -- worker loaded before its (slow) Comtrade calls. If a PATCH edited/rejected/removed the code
  -- in between, updated_at (or code/status) no longer matches → we skip without touching
  -- evidence, so the worker can never re-seed the rows the PATCH just purged.
  PERFORM 1 FROM research_hs_codes
   WHERE id = p_hs_code_id
     AND tenant_id = p_tenant
     AND project_id = p_project
     AND status = 'approved'
     AND code = p_expected_code
     AND updated_at IS NOT DISTINCT FROM p_expected_updated_at
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN -1;  -- stale: leave evidence untouched
  END IF;

  -- Atomic slice replacement — same (hs_code_id, kind) only, so a re-run cannot touch another
  -- code's ranking or this code's other-kind rows.
  DELETE FROM research_markets
   WHERE tenant_id = p_tenant
     AND project_id = p_project
     AND hs_code_id = p_hs_code_id
     AND kind = p_kind;

  INSERT INTO research_markets (
    tenant_id, project_id, hs_code_id, hs_code, country,
    import_value, growth_pct, rank, source, kind, reporter_country, raw
  )
  SELECT
    p_tenant, p_project, p_hs_code_id,
    r.hs_code, r.country, r.import_value, r.growth_pct, r.rank,
    COALESCE(r.source, 'comtrade'), p_kind, r.reporter_country,
    COALESCE(r.raw, '{}'::jsonb)
  FROM jsonb_to_recordset(p_rows) AS r(
    hs_code          TEXT,
    country          TEXT,
    import_value     NUMERIC,
    growth_pct       NUMERIC,
    rank             INTEGER,
    source           TEXT,
    reporter_country TEXT,
    raw              JSONB
  );
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN v_inserted;
END;
$$;
REVOKE ALL ON FUNCTION research_persist_market_slice(UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_persist_market_slice(UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, JSONB) TO service_role;
