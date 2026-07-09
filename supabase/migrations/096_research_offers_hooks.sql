-- ==========================================
-- TG-Research v2 — WP4: offer/angle layer + per-company hooks + export enrichment  [096]
--
-- research_offers = per-ICP value-prop/angle cards (message TEXT stays in TG-Core — these are
-- the evidence-bound ANGLE MAP): offer:generate (strategy role) drafts 3-5 angles from the
-- project profile + differentiators + market notes + real MATCH evidence; the customer edits
-- + approves (same human gate as ICPs/geographies).
--
-- research_company_verdicts gains hooks JSONB (≤3 short page-grounded personalization facts)
-- and angle_suggestion TEXT (best-fit APPROVED angle code) — both written by the SAME
-- reading-role validation pass (no extra LLM call), entering ONLY at verdict-write time.
--
-- BILLED-MATCH IMMUTABILITY PRESERVED: research_persist_verdict's early `RETURN v_existing`
-- for a billed match happens BEFORE any write, exactly as in 069 — hooks can never mutate a
-- billed row; the caller keeps counting from the returned row of record.
--
-- research_exportable_companies widens to carry ICP name + hooks + angle (code + approved
-- value_prop) so the CRM handoff lands them in custom_fields.
-- ==========================================

-- ------------------------------------------
-- Offers (angle cards) — advisory drafts, human-approved; NO billing coupling.
-- ------------------------------------------
CREATE TABLE IF NOT EXISTS research_offers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id          UUID NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  icp_id              UUID NOT NULL REFERENCES research_icps(id) ON DELETE CASCADE,
  geo_id              UUID REFERENCES research_geographies(id) ON DELETE SET NULL,
  angle_code          TEXT NOT NULL,
  pain_hypothesis     TEXT NOT NULL,
  value_prop          TEXT NOT NULL,
  proof_points        JSONB NOT NULL DEFAULT '[]',
  objections          JSONB NOT NULL DEFAULT '[]',
  language            TEXT,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  human_score         INTEGER CHECK (human_score BETWEEN 0 AND 10),
  note                TEXT,
  ai_draft            JSONB NOT NULL DEFAULT '{}',
  generated_by_job_id UUID REFERENCES research_jobs(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One angle code per ICP (geo-variants suffix their code) — regeneration upserts, not duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_offers_icp_code
  ON research_offers(tenant_id, icp_id, lower(angle_code));
CREATE INDEX IF NOT EXISTS idx_research_offers_icp
  ON research_offers(tenant_id, icp_id, status);

-- Standard tenant-scoped RLS + updated_at trigger (056 loop semantics, single table).
ALTER TABLE research_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_offers_select ON research_offers FOR SELECT
  USING (tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY research_offers_insert ON research_offers FOR INSERT
  WITH CHECK ((tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin')) OR is_superadmin());
CREATE POLICY research_offers_update ON research_offers FOR UPDATE
  USING ((tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin')) OR is_superadmin());
CREATE POLICY research_offers_delete ON research_offers FOR DELETE
  USING ((tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','client_admin')) OR is_superadmin());
CREATE TRIGGER research_offers_updated_at BEFORE UPDATE ON research_offers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ------------------------------------------
-- Verdict personalization columns (additive, NULL for all existing rows)
-- ------------------------------------------
ALTER TABLE research_company_verdicts
  ADD COLUMN IF NOT EXISTS hooks            JSONB,
  ADD COLUMN IF NOT EXISTS angle_suggestion TEXT;

-- ------------------------------------------
-- Fenced verdict writer: 12 → 14 args (p_hooks, p_angle_suggestion appended).
-- Body identical to 069 except the two new columns ride the SAME insert/update —
-- the billed-match early return stays BEFORE any write.
-- ------------------------------------------
DROP FUNCTION IF EXISTS research_persist_verdict(UUID, UUID, UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, TEXT, UUID);

CREATE OR REPLACE FUNCTION research_persist_verdict(
  p_tenant             UUID,
  p_company_id         UUID,
  p_icp_id             UUID,
  p_ruleset_version    INTEGER,
  p_verdict            TEXT,
  p_score              INTEGER,
  p_evidence           TEXT,
  p_elimination_reason TEXT,
  p_model              TEXT,
  p_job_id             UUID,
  p_worker             TEXT,
  p_lease              UUID,
  p_hooks              JSONB DEFAULT NULL,
  p_angle_suggestion   TEXT  DEFAULT NULL
)
RETURNS research_company_verdicts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_canon    TEXT;
  v_existing research_company_verdicts;
  v_row      research_company_verdicts;
BEGIN
  IF p_verdict IS NULL OR p_verdict NOT IN ('match','partial','eliminated','review') THEN
    RAISE EXCEPTION 'research_persist_verdict: invalid verdict %', p_verdict;
  END IF;
  IF p_ruleset_version IS NULL OR p_ruleset_version < 1 THEN
    RAISE EXCEPTION 'research_persist_verdict: invalid ruleset_version %', p_ruleset_version;
  END IF;
  IF p_job_id IS NULL OR p_worker IS NULL OR p_lease IS NULL THEN
    RAISE EXCEPTION 'research_persist_verdict: a verdict write requires (job, worker, lease) — unfenced writes are not allowed';
  END IF;
  IF p_hooks IS NOT NULL AND jsonb_typeof(p_hooks) <> 'array' THEN
    RAISE EXCEPTION 'research_persist_verdict: hooks must be a JSON array';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || p_tenant::text));

  PERFORM 1 FROM research_jobs
    WHERE id = p_job_id AND tenant_id = p_tenant
      AND status = 'running' AND locked_by = p_worker AND lease = p_lease
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_persist_verdict: lease lost for job % (worker=%, fenced — not persisting)',
      p_job_id, p_worker;
  END IF;

  SELECT canonical_key INTO v_canon
    FROM research_companies
    WHERE id = p_company_id AND tenant_id = p_tenant AND suppressed = false
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_persist_verdict: company % not found (or suppressed) for tenant %',
      p_company_id, p_tenant USING ERRCODE = 'check_violation', DETAIL = 'SUPPRESSED_OR_MISSING';
  END IF;

  IF EXISTS (
    SELECT 1 FROM research_suppression
    WHERE tenant_id = p_tenant AND entity_type = 'company' AND identity_key = v_canon
  ) THEN
    RAISE EXCEPTION 'research_persist_verdict: company is suppressed (tenant=%, key=%)',
      p_tenant, v_canon USING ERRCODE = 'check_violation', DETAIL = 'SUPPRESSED';
  END IF;

  SELECT * INTO v_existing FROM research_company_verdicts
    WHERE tenant_id = p_tenant AND company_id = p_company_id
      AND icp_id = p_icp_id AND ruleset_version = p_ruleset_version
    FOR UPDATE;
  IF FOUND AND v_existing.verdict = 'match' AND EXISTS (
    SELECT 1 FROM research_billable_events e
    WHERE e.tenant_id = p_tenant AND e.canonical_key = v_canon
      AND (e.verdict_id = v_existing.id OR e.verdict_id IS NULL)
  ) THEN
    RETURN v_existing;
  END IF;

  INSERT INTO research_company_verdicts
    (tenant_id, company_id, icp_id, ruleset_version, verdict, score, evidence, elimination_reason,
     model, hooks, angle_suggestion)
  VALUES
    (p_tenant, p_company_id, p_icp_id, p_ruleset_version, p_verdict, p_score, p_evidence,
     p_elimination_reason, p_model, p_hooks, p_angle_suggestion)
  ON CONFLICT (tenant_id, company_id, icp_id, ruleset_version) DO UPDATE SET
    verdict            = EXCLUDED.verdict,
    score              = EXCLUDED.score,
    evidence           = EXCLUDED.evidence,
    elimination_reason = EXCLUDED.elimination_reason,
    model              = EXCLUDED.model,
    hooks              = EXCLUDED.hooks,
    angle_suggestion   = EXCLUDED.angle_suggestion
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION research_persist_verdict(UUID, UUID, UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, TEXT, UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION research_persist_verdict(UUID, UUID, UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, TEXT, UUID, JSONB, TEXT) TO service_role;

-- ------------------------------------------
-- Export view widens: ICP name + hooks + angle (code + approved value_prop).
-- Same suppression/unexported/current-ruleset semantics as 074.
-- ------------------------------------------
DROP FUNCTION IF EXISTS research_exportable_companies(UUID, UUID, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION research_exportable_companies(
  p_tenant UUID, p_icp_id UUID, p_ruleset INTEGER, p_limit INTEGER DEFAULT 200
)
RETURNS TABLE(
  company_id UUID, name TEXT, domain TEXT, website TEXT, country TEXT, city TEXT,
  site_summary TEXT, score INTEGER, evidence TEXT,
  icp_name TEXT, hooks JSONB, angle_suggestion TEXT, angle_value_prop TEXT
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.name, c.domain, c.website, c.country, c.city, c.site_summary,
         v.score, v.evidence,
         i.name AS icp_name, v.hooks, v.angle_suggestion,
         o.value_prop AS angle_value_prop
  FROM research_company_verdicts v
  JOIN research_companies c
    ON c.id = v.company_id AND c.tenant_id = v.tenant_id
  JOIN research_icps i
    ON i.id = v.icp_id AND i.tenant_id = v.tenant_id
  LEFT JOIN research_offers o
    ON o.tenant_id = v.tenant_id AND o.icp_id = v.icp_id
   AND lower(o.angle_code) = lower(v.angle_suggestion) AND o.status = 'approved'
  WHERE v.tenant_id = p_tenant
    AND v.icp_id = p_icp_id
    AND v.ruleset_version = p_ruleset
    AND v.verdict = 'match'
    AND c.crm_company_id IS NULL
    AND c.suppressed = false
    AND NOT EXISTS (
      SELECT 1 FROM research_suppression s
      WHERE s.tenant_id = v.tenant_id AND s.entity_type = 'company'
        AND s.identity_key = c.canonical_key
    )
  ORDER BY v.score DESC NULLS LAST, v.created_at ASC, v.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
$$;
REVOKE ALL ON FUNCTION research_exportable_companies(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_exportable_companies(UUID, UUID, INTEGER, INTEGER) TO service_role;
