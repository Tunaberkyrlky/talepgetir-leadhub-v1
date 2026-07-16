-- Forward-only hardening for Maps rollout. 148 may already be applied; keep this migration idempotent.
ALTER TABLE research_company_verdicts
  ADD COLUMN IF NOT EXISTS evidence_source TEXT,
  ADD COLUMN IF NOT EXISTS evidence_hash TEXT,
  ADD COLUMN IF NOT EXISTS evidence_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS evidence_observed_at TIMESTAMPTZ;

ALTER TABLE research_company_verdicts DROP CONSTRAINT IF EXISTS research_company_verdicts_evidence_source_check;
ALTER TABLE research_company_verdicts ADD CONSTRAINT research_company_verdicts_evidence_source_check
  CHECK (evidence_source IS NULL OR evidence_source IN ('website', 'maps'));

DROP FUNCTION IF EXISTS research_persist_verdict(UUID, UUID, UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, TEXT, UUID, JSONB, TEXT);

CREATE OR REPLACE FUNCTION research_persist_verdict(
  p_tenant UUID, p_company_id UUID, p_icp_id UUID, p_ruleset_version INTEGER,
  p_verdict TEXT, p_score INTEGER, p_evidence TEXT, p_elimination_reason TEXT,
  p_model TEXT, p_job_id UUID, p_worker TEXT, p_lease UUID,
  p_hooks JSONB DEFAULT NULL, p_angle_suggestion TEXT DEFAULT NULL,
  p_evidence_source TEXT DEFAULT NULL, p_evidence_hash TEXT DEFAULT NULL,
  p_evidence_snapshot TEXT DEFAULT NULL, p_evidence_observed_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS research_company_verdicts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_canon TEXT;
  v_existing research_company_verdicts;
  v_row research_company_verdicts;
BEGIN
  IF p_verdict IS NULL OR p_verdict NOT IN ('match','partial','eliminated','review') THEN
    RAISE EXCEPTION 'research_persist_verdict: invalid verdict %', p_verdict;
  END IF;
  IF p_ruleset_version IS NULL OR p_ruleset_version < 1 THEN
    RAISE EXCEPTION 'research_persist_verdict: invalid ruleset_version %', p_ruleset_version;
  END IF;
  IF p_job_id IS NULL OR p_worker IS NULL OR p_lease IS NULL THEN
    RAISE EXCEPTION 'research_persist_verdict: a verdict write requires (job, worker, lease) - unfenced writes are not allowed';
  END IF;
  IF p_hooks IS NOT NULL AND jsonb_typeof(p_hooks) <> 'array' THEN
    RAISE EXCEPTION 'research_persist_verdict: hooks must be a JSON array';
  END IF;
  IF p_evidence_source IS NOT NULL AND p_evidence_source NOT IN ('website','maps') THEN
    RAISE EXCEPTION 'research_persist_verdict: invalid evidence source %', p_evidence_source;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || p_tenant::text));
  PERFORM 1 FROM research_jobs
    WHERE id = p_job_id AND tenant_id = p_tenant
      AND status = 'running' AND locked_by = p_worker AND lease = p_lease
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_persist_verdict: lease lost for job % (worker=%, fenced - not persisting)', p_job_id, p_worker;
  END IF;

  SELECT canonical_key INTO v_canon FROM research_companies
    WHERE id = p_company_id AND tenant_id = p_tenant AND suppressed = false FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_persist_verdict: company % not found (or suppressed) for tenant %', p_company_id, p_tenant
      USING ERRCODE = 'check_violation', DETAIL = 'SUPPRESSED_OR_MISSING';
  END IF;
  IF EXISTS (SELECT 1 FROM research_suppression
    WHERE tenant_id = p_tenant AND entity_type = 'company' AND identity_key = v_canon) THEN
    RAISE EXCEPTION 'research_persist_verdict: company is suppressed (tenant=%, key=%)', p_tenant, v_canon
      USING ERRCODE = 'check_violation', DETAIL = 'SUPPRESSED';
  END IF;

  SELECT * INTO v_existing FROM research_company_verdicts
    WHERE tenant_id = p_tenant AND company_id = p_company_id
      AND icp_id = p_icp_id AND ruleset_version = p_ruleset_version FOR UPDATE;
  IF FOUND AND v_existing.verdict = 'match' AND EXISTS (
    SELECT 1 FROM research_billable_events e
    WHERE e.tenant_id = p_tenant AND e.canonical_key = v_canon
      AND (e.verdict_id = v_existing.id OR e.verdict_id IS NULL)
  ) THEN
    RETURN v_existing; -- billed verdict and its evidence snapshot are immutable
  END IF;

  INSERT INTO research_company_verdicts
    (tenant_id, company_id, icp_id, ruleset_version, verdict, score, evidence,
     elimination_reason, model, hooks, angle_suggestion, evidence_source, evidence_hash,
     evidence_snapshot, evidence_observed_at)
  VALUES
    (p_tenant, p_company_id, p_icp_id, p_ruleset_version, p_verdict, p_score, p_evidence,
     p_elimination_reason, p_model, p_hooks, p_angle_suggestion, p_evidence_source,
     p_evidence_hash, p_evidence_snapshot, COALESCE(p_evidence_observed_at, now()))
  ON CONFLICT (tenant_id, company_id, icp_id, ruleset_version) DO UPDATE SET
    verdict = EXCLUDED.verdict, score = EXCLUDED.score, evidence = EXCLUDED.evidence,
    elimination_reason = EXCLUDED.elimination_reason, model = EXCLUDED.model,
    hooks = EXCLUDED.hooks, angle_suggestion = EXCLUDED.angle_suggestion,
    evidence_source = EXCLUDED.evidence_source, evidence_hash = EXCLUDED.evidence_hash,
    evidence_snapshot = EXCLUDED.evidence_snapshot, evidence_observed_at = EXCLUDED.evidence_observed_at
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION research_persist_verdict(UUID, UUID, UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, TEXT, UUID, JSONB, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION research_persist_verdict(UUID, UUID, UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, TEXT, UUID, JSONB, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

CREATE OR REPLACE FUNCTION research_log_search_fenced(
  p_tenant UUID, p_project_id UUID, p_job_id UUID, p_worker TEXT, p_lease UUID,
  p_engine TEXT, p_query TEXT, p_query_hash TEXT, p_result_count INTEGER,
  p_cache_hit BOOLEAN, p_cost_usd NUMERIC
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM 1 FROM research_jobs
    WHERE id = p_job_id AND tenant_id = p_tenant
      AND status = 'running' AND locked_by = p_worker AND lease = p_lease
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_log_search_fenced: lease lost for job %', p_job_id;
  END IF;
  IF p_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM research_projects WHERE id = p_project_id AND tenant_id = p_tenant
  ) THEN
    RAISE EXCEPTION 'research_log_search_fenced: project not in tenant';
  END IF;
  INSERT INTO research_search_log
    (tenant_id, project_id, job_id, engine, query, query_hash, result_count, cache_hit, cost_usd)
  SELECT
    p_tenant, p_project_id, p_job_id, p_engine, p_query, p_query_hash, p_result_count, p_cache_hit, p_cost_usd
  WHERE NOT EXISTS (
    SELECT 1 FROM research_search_log
    WHERE tenant_id = p_tenant AND job_id = p_job_id
      AND engine = p_engine AND query_hash = p_query_hash
  );
END;
$$;
REVOKE ALL ON FUNCTION research_log_search_fenced(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, NUMERIC) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION research_log_search_fenced(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, NUMERIC) TO service_role;
