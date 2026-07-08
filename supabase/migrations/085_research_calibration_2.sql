-- ==========================================
-- TG-Research v2 — WP1 calibration hardening (2-lens review findings)  [085]
--
-- 1. A revision proposal is now BOUND to the ruleset it was computed from:
--    research_persist_icp_revision takes p_base_ruleset and refuses to land a
--    proposal once the live ruleset moved (manual edit mid-job) — DETAIL 'RULESET_MOVED'.
--    A proposal computed from feedback against rules that no longer exist could
--    otherwise overwrite newer manual refinements (review P2).
-- 2. 'calibrated' is terminal until the customer RE-OPENS the loop by sampling again:
--    a queued icp:revise landing after mark-calibrated is refused (DETAIL 'CALIBRATED')
--    instead of silently regressing the badge and resurrecting a stale proposal.
-- 3. The 062 ruleset-guard trigger now also CLEARS a pending revision_draft whenever
--    the ruleset arrays change — any ruleset change invalidates the pending proposal
--    (apply-revision writes both together; a manual PATCH edit now cleans up too).
-- ==========================================

-- ------------------------------------------
-- 1+2. Rebind the fenced revision writer (new signature; drop the 084 one)
-- ------------------------------------------
DROP FUNCTION IF EXISTS research_persist_icp_revision(UUID, UUID, UUID, TEXT, UUID, JSONB);

CREATE OR REPLACE FUNCTION research_persist_icp_revision(
  p_tenant        UUID,
  p_icp_id        UUID,
  p_job_id        UUID,
  p_worker        TEXT,
  p_lease         UUID,
  p_revision      JSONB,
  p_base_ruleset  INTEGER
)
RETURNS SETOF research_icps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state   TEXT;
  v_version INTEGER;
BEGIN
  -- Fence (063 pattern): only the attempt that currently holds the lease may persist.
  PERFORM 1 FROM research_jobs
   WHERE id = p_job_id AND tenant_id = p_tenant
     AND status = 'running' AND locked_by = p_worker AND lease IS NOT DISTINCT FROM p_lease
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_persist_icp_revision: lease lost for job % (worker=%, fenced)', p_job_id, p_worker
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_revision IS NULL OR jsonb_typeof(p_revision) <> 'object' THEN
    RAISE EXCEPTION 'research_persist_icp_revision: revision must be a JSON object';
  END IF;
  IF p_base_ruleset IS NULL OR p_base_ruleset < 1 THEN
    RAISE EXCEPTION 'research_persist_icp_revision: base ruleset required';
  END IF;

  SELECT calibration_state, ruleset_version INTO v_state, v_version
    FROM research_icps
   WHERE id = p_icp_id AND tenant_id = p_tenant
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_persist_icp_revision: ICP % not found for tenant %', p_icp_id, p_tenant;
  END IF;
  -- The proposal was computed from feedback at p_base_ruleset; once the live ruleset moved
  -- (manual edit mid-job), it describes rules that no longer exist — refuse, structurally.
  IF v_version <> p_base_ruleset THEN
    RAISE EXCEPTION 'research_persist_icp_revision: ruleset moved (% -> %)', p_base_ruleset, v_version
      USING ERRCODE = 'check_violation', DETAIL = 'RULESET_MOVED';
  END IF;
  -- 'calibrated' is terminal until re-opened by a new sample run (calibrate route).
  IF v_state = 'calibrated' THEN
    RAISE EXCEPTION 'research_persist_icp_revision: ICP is calibrated; re-open by sampling first'
      USING ERRCODE = 'check_violation', DETAIL = 'CALIBRATED';
  END IF;

  RETURN QUERY
  UPDATE research_icps
     SET revision_draft    = p_revision,
         revision_job_id   = p_job_id,
         calibration_state = 'revised'
   WHERE id = p_icp_id AND tenant_id = p_tenant
  RETURNING *;
END;
$$;
REVOKE ALL ON FUNCTION research_persist_icp_revision(UUID, UUID, UUID, TEXT, UUID, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_persist_icp_revision(UUID, UUID, UUID, TEXT, UUID, JSONB, INTEGER) TO service_role;

-- ------------------------------------------
-- 3. Ruleset change invalidates any pending proposal (extend the 062 trigger)
-- ------------------------------------------
CREATE OR REPLACE FUNCTION research_icps_ruleset_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.signals           IS DISTINCT FROM OLD.signals)
  OR (NEW.negative_signals  IS DISTINCT FROM OLD.negative_signals)
  OR (NEW.neutral_signals   IS DISTINCT FROM OLD.neutral_signals)
  OR (NEW.elimination_rules IS DISTINCT FROM OLD.elimination_rules) THEN
    NEW.ruleset_version := OLD.ruleset_version + 1;
    -- An edited ruleset can never remain approved on the strength of the OLD rules.
    IF OLD.status = 'approved' AND NEW.status = 'approved' THEN
      NEW.status := 'draft';
    END IF;
    -- A pending revision proposal was computed against the OLD rules — clear it (085).
    NEW.revision_draft := NULL;
    NEW.revision_job_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;
