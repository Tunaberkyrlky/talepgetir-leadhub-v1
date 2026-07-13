-- ==========================================
-- TG-Research v2 — WP12/13 re-review R1: geo-reject race — DB-level atomic CAS  [131]
--
-- research_persist_geo_analysis (086 → 090) UPDATEs the cell to status='draft'
-- UNCONDITIONALLY. geo:analyze bolted on two application-level status='rejected' reads
-- (a pre-spend guard and a post-spend / pre-persist re-check) to avoid resurrecting a
-- cell the customer rejected after the job was enqueued. Those are check-then-act:
-- a reject that COMMITS in the window between the second read and this RPC's UPDATE is
-- missed, and the RPC then writes 'draft' over 'rejected' — silently resurrecting the
-- cell. A TOCTOU window no application-level read can close.
--
-- The only race-free guard lives INSIDE the write. Add `status IS DISTINCT FROM
-- 'rejected'` to the UPDATE's WHERE. Under READ COMMITTED the UPDATE re-evaluates its
-- predicate against the LATEST committed row version at row-lock time (EvalPlanQual), so
-- a reject that lands at any point before the lock excludes the row atomically — one
-- statement, no application read-then-write. This is a compare-and-swap: "write the
-- draft only if the cell is not (still/now) rejected".
--
-- A 0-row result now carries two meanings, disambiguated below:
--   * the row exists but is 'rejected'  → graceful skip, no resurrection, NO error;
--   * the row genuinely does not exist  → the original hard error (unchanged).
--
-- Same signature as 090 → CREATE OR REPLACE; the caller (geoAnalyze.ts) needs no change.
-- The two app-level checks stay purely as early-exit optimizations (skip the LLM spend /
-- the RPC round-trip in the common case); they are NO LONGER the correctness guarantee.
-- Everything else is copied verbatim from 090 (fence, spec-shape guard, direct NULL-aware
-- projection of estimate/confidence/rationale).
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
  -- Projection is direct assignment — the columns track THIS spec, nulls and all (090).
  -- Reject guard (131) lives IN the WHERE: a cell the customer rejected after enqueue must
  -- NOT be resurrected to 'draft'. `status IS DISTINCT FROM 'rejected'` makes the check
  -- atomic with the write (CAS at row-lock time) — closing the read-then-write TOCTOU that
  -- the worker's app-level status re-reads could not.
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
     AND status IS DISTINCT FROM 'rejected'
  RETURNING *;

  -- 0 rows updated: distinguish "rejected → skip" from "does not exist → error".
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM research_geographies WHERE id = p_geo_id AND tenant_id = p_tenant) THEN
      -- Row is present but 'rejected' — leave it untouched, return the empty set, no error.
      -- The worker's rpc() call sees no error; state stays 'rejected' (not resurrected).
      RAISE NOTICE 'research_persist_geo_analysis: geography % rejected — persist skipped, not resurrected', p_geo_id;
      RETURN;
    END IF;
    RAISE EXCEPTION 'research_persist_geo_analysis: geography % not found for tenant %', p_geo_id, p_tenant;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION research_persist_geo_analysis(UUID, UUID, UUID, TEXT, UUID, JSONB, INTEGER, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_persist_geo_analysis(UUID, UUID, UUID, TEXT, UUID, JSONB, INTEGER, NUMERIC, TEXT) TO service_role;
