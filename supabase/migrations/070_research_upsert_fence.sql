-- ==========================================
-- TG-Research v2 — Rollup writer fence (Workflow adversarial review of 067/069: 1×P1 + support for 1×P2)
-- ------------------------------------------------------------------------------
--   P1  research_upsert_company was the LAST unfenced writer in the harvest path. The domainless
--       and fetch-error "park as review" branches complete a whole loop iteration through it with
--       NO fenced RPC at all — so a reaped-but-alive attempt (worker stalls past the reap timeout,
--       then resumes; its fenced heartbeats silently no-op, so it never learns it lost the lease)
--       keeps writing research_companies rows concurrently with the replacement run, last-writer-
--       wins on status/score/site_summary (invariant 5: a dead attempt could clobber the rollup —
--       e.g. flip a re-run's billed MATCH to 'review' in the customer-facing list).
--       FIX: research_upsert_company now REQUIRES (job, worker, lease), with the same atomic
--       row-locked fence as persist/bill (066/067 pattern: enforce by shape — the old signature is
--       DROPPED, no unfenced overload left). The harvest handler is its only caller.
--
--   (The companion P2 — the fresh path wrote the rollup with the COMPUTED verdict before learning
--   the row of record, leaving a billed MATCH looking 'eliminated' when the immutability guard
--   fired — is fixed app-side: the handler now repairs the rollup from the RETURNED verdict when
--   they diverge. And the route now refuses to enqueue a second harvest for an ICP that already
--   has one queued/running, killing the same-ICP concurrent-run class the review's remaining
--   findings depended on.)
--
-- Additive + re-runnable. SECURITY DEFINER, search_path pinned, service_role-only EXECUTE.
-- ==========================================

DROP FUNCTION IF EXISTS research_upsert_company(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, UUID, TEXT);

CREATE OR REPLACE FUNCTION research_upsert_company(
  p_tenant            UUID,
  p_canonical_key     TEXT,
  p_project_id        UUID,
  p_domain            TEXT,
  p_name              TEXT,
  p_website           TEXT,
  p_country           TEXT,
  p_city              TEXT,
  p_status            TEXT,
  p_score             INTEGER,
  p_site_summary      TEXT,
  p_evidence          TEXT,
  p_elimination_reason TEXT,
  p_icp_id            UUID,
  p_geo_id            UUID,
  p_source_path       TEXT,
  p_job_id            UUID,
  p_worker            TEXT,
  p_lease             UUID
)
RETURNS research_companies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row research_companies;
BEGIN
  IF p_canonical_key IS NULL OR length(trim(p_canonical_key)) = 0 THEN
    RAISE EXCEPTION 'research_upsert_company: canonical_key is required';
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'research_upsert_company: name is required';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('match','partial','eliminated','review') THEN
    RAISE EXCEPTION 'research_upsert_company: invalid status %', p_status;
  END IF;
  -- STRUCTURAL fence (070): the only rollup writer is a running, leased job attempt.
  IF p_job_id IS NULL OR p_worker IS NULL OR p_lease IS NULL THEN
    RAISE EXCEPTION 'research_upsert_company: a rollup write requires (job, worker, lease) — unfenced writes are not allowed';
  END IF;

  -- Reject cross-tenant foreign references (a bug, not a normal path — fail loudly).
  IF p_project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM research_projects WHERE id = p_project_id AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'research_upsert_company: project % not in tenant %', p_project_id, p_tenant;
  END IF;
  IF p_icp_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM research_icps WHERE id = p_icp_id AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'research_upsert_company: icp % not in tenant %', p_icp_id, p_tenant;
  END IF;
  IF p_geo_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM research_geographies WHERE id = p_geo_id AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'research_upsert_company: geo % not in tenant %', p_geo_id, p_tenant;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || p_tenant::text));

  -- ATOMIC LEASE FENCE (066/067 pattern): row-lock the job; require it still RUNNING under this
  -- exact (worker, lease). A reaped/reclaimed attempt writes NOTHING — including the park paths.
  PERFORM 1 FROM research_jobs
    WHERE id = p_job_id AND tenant_id = p_tenant
      AND status = 'running' AND locked_by = p_worker AND lease = p_lease
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_upsert_company: lease lost for job % (worker=%, fenced — not writing)',
      p_job_id, p_worker;
  END IF;

  IF EXISTS (
    SELECT 1 FROM research_suppression
    WHERE tenant_id = p_tenant AND entity_type = 'company' AND identity_key = p_canonical_key
  ) THEN
    RAISE EXCEPTION 'research_upsert_company: company is suppressed (tenant=%, key=%)',
      p_tenant, p_canonical_key USING ERRCODE = 'check_violation', DETAIL = 'SUPPRESSED';
  END IF;

  INSERT INTO research_companies
    (tenant_id, canonical_key, project_id, domain, name, website, country, city,
     status, score, site_summary, evidence, elimination_reason, icp_id, geo_id,
     source_path, last_checked_at)
  VALUES
    (p_tenant, p_canonical_key, p_project_id, p_domain, p_name, p_website, p_country, p_city,
     COALESCE(p_status, 'review'), p_score, p_site_summary, p_evidence, p_elimination_reason,
     p_icp_id, p_geo_id, p_source_path, now())
  ON CONFLICT (tenant_id, canonical_key) DO UPDATE SET
     -- Preserve existing rollup when the caller omits a value (NULL) — never downgrade. Use the
     -- raw p_* params, NOT EXCLUDED (063).
     status             = COALESCE(p_status, research_companies.status),
     score              = COALESCE(p_score, research_companies.score),
     site_summary       = COALESCE(p_site_summary, research_companies.site_summary),
     evidence           = COALESCE(p_evidence, research_companies.evidence),
     elimination_reason = COALESCE(p_elimination_reason, research_companies.elimination_reason),
     icp_id             = COALESCE(p_icp_id, research_companies.icp_id),
     geo_id             = COALESCE(p_geo_id, research_companies.geo_id),
     domain             = COALESCE(p_domain, research_companies.domain),
     website            = COALESCE(p_website, research_companies.website),
     country            = COALESCE(p_country, research_companies.country),
     city               = COALESCE(p_city, research_companies.city),
     last_checked_at    = now(),
     updated_at         = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION research_upsert_company(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, UUID, TEXT, UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_upsert_company(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, UUID, TEXT, UUID, TEXT, UUID)
  TO service_role;
