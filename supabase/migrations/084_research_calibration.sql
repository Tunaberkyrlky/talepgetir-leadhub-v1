-- ==========================================
-- TG-Research v2 — WP1: Calibration loop (plan C1–C2)  [084]
--
-- Before scaling, the customer runs a SMALL sample harvest for an (ICP × geography),
-- rates each sampled company good/bad, asks the strategy model to propose an ICP
-- revision from that feedback, applies it (ruleset bump via the existing 062 trigger),
-- re-approves, re-samples — and finally marks the research logic "calibrated".
--
--   • research_company_feedback — per-company human rating for one ICP at one ruleset.
--     User clients SELECT-only (062 pattern); the API writes with service role,
--     tenant-scoped. One rating per (tenant, icp, company, ruleset) — re-rating updates.
--   • research_icps.calibration_state / revision_draft / revision_job_id / calibrated_at —
--     advisory flow state + the model's PROPOSED revision. The proposal NEVER touches the
--     live ruleset columns; apply-revision (route) patches them explicitly, which bumps
--     ruleset_version + reverts approved→draft atomically via research_icps_ruleset_guard.
--   • research_persist_icp_revision — fenced writer (063 research_persist_icp_drafts
--     pattern): only the icp:revise attempt that still holds the job lease may persist,
--     so a reaped/zombie attempt can't clobber a newer proposal.
--
-- Billing is UNTOUCHED: calibration samples run the normal fenced harvest spine and
-- bill MATCHes once-ever like any run (trial credits absorb the sample).
-- ==========================================

-- ------------------------------------------
-- 1. Per-company calibration feedback
-- ------------------------------------------
CREATE TABLE research_company_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  icp_id          UUID NOT NULL REFERENCES research_icps(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL REFERENCES research_companies(id) ON DELETE CASCADE,
  -- The verdict the customer was looking at when rating (provenance; survives re-scores).
  verdict_id      UUID REFERENCES research_company_verdicts(id) ON DELETE SET NULL,
  -- Ruleset the rating was given AGAINST — feedback for an old ruleset must not silently
  -- count toward revising a newer one (the revise route filters on the current version).
  ruleset_version INTEGER NOT NULL CHECK (ruleset_version >= 1),
  rating          TEXT NOT NULL CHECK (rating IN ('good','bad')),
  note            TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_research_company_feedback UNIQUE (tenant_id, icp_id, company_id, ruleset_version)
);
CREATE INDEX idx_research_company_feedback_icp
  ON research_company_feedback(tenant_id, icp_id, ruleset_version, created_at DESC);

ALTER TABLE research_company_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_company_feedback_select ON research_company_feedback
  FOR SELECT USING (tenant_id = get_user_tenant_id() OR is_superadmin());
REVOKE INSERT, UPDATE, DELETE ON research_company_feedback FROM PUBLIC, anon, authenticated;

CREATE TRIGGER research_company_feedback_updated_at
  BEFORE UPDATE ON research_company_feedback
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ------------------------------------------
-- 2. Calibration flow state on the ICP
-- ------------------------------------------
-- calibration_state is advisory UX state (routes/worker move it); ruleset integrity is
-- still owned by the 062 trigger + approve CAS — a wrong state can never mis-bill.
ALTER TABLE research_icps
  ADD COLUMN IF NOT EXISTS calibration_state TEXT NOT NULL DEFAULT 'none'
    CHECK (calibration_state IN ('none','sampling','feedback','revised','calibrated')),
  ADD COLUMN IF NOT EXISTS revision_draft JSONB,
  ADD COLUMN IF NOT EXISTS revision_job_id UUID REFERENCES research_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS calibrated_at TIMESTAMPTZ;

-- ------------------------------------------
-- 3. Fenced revision persistence (icp:revise worker writer)
-- ------------------------------------------
CREATE OR REPLACE FUNCTION research_persist_icp_revision(
  p_tenant   UUID,
  p_icp_id   UUID,
  p_job_id   UUID,
  p_worker   TEXT,
  p_lease    UUID,
  p_revision JSONB
)
RETURNS SETOF research_icps
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
    RAISE EXCEPTION 'research_persist_icp_revision: lease lost for job % (worker=%, fenced)', p_job_id, p_worker
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_revision IS NULL OR jsonb_typeof(p_revision) <> 'object' THEN
    RAISE EXCEPTION 'research_persist_icp_revision: revision must be a JSON object';
  END IF;

  -- Store the PROPOSAL only. Live ruleset columns are untouched here, so the 062
  -- ruleset trigger does not fire — the bump happens when the customer applies it.
  RETURN QUERY
  UPDATE research_icps
     SET revision_draft   = p_revision,
         revision_job_id  = p_job_id,
         calibration_state = 'revised'
   WHERE id = p_icp_id AND tenant_id = p_tenant
  RETURNING *;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_persist_icp_revision: ICP % not found for tenant %', p_icp_id, p_tenant;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION research_persist_icp_revision(UUID, UUID, UUID, TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_persist_icp_revision(UUID, UUID, UUID, TEXT, UUID, JSONB) TO service_role;
