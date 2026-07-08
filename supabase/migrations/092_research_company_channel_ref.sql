-- ==========================================
-- TG-Research v2 — WP3: company → source channel provenance  [092]
--
-- channels:harvest (Y1 list harvest) feeds member companies through the SAME fenced spine;
-- the company row should record WHICH channel produced it (research_companies.channel_id has
-- existed since 057, but the fenced upsert RPC — the only writer since 072's DML revoke —
-- never set it). Same extension pattern as 075 (phone/address): drop + recreate the fenced
-- research_upsert_company with one trailing DEFAULT NULL arg. COALESCE semantics on update:
-- a later non-channel run (re-score, Y3) never clears an existing channel ref.
--
-- Billing/verdict semantics untouched: this RPC still only writes the company rollup row;
-- verdict/billing RPCs (067-069) are unchanged.
-- ==========================================

DROP FUNCTION IF EXISTS research_upsert_company(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, UUID, TEXT, UUID, TEXT, UUID);

CREATE OR REPLACE FUNCTION research_upsert_company(
  p_tenant             UUID,
  p_canonical_key      TEXT,
  p_project_id         UUID,
  p_domain             TEXT,
  p_name               TEXT,
  p_website            TEXT,
  p_country            TEXT,
  p_city               TEXT,
  p_phone              TEXT,
  p_address            TEXT,
  p_status             TEXT,
  p_score              INTEGER,
  p_site_summary       TEXT,
  p_evidence           TEXT,
  p_elimination_reason TEXT,
  p_icp_id             UUID,
  p_geo_id             UUID,
  p_source_path        TEXT,
  p_job_id             UUID,
  p_worker             TEXT,
  p_lease              UUID,
  p_channel            UUID DEFAULT NULL
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
  IF p_job_id IS NULL OR p_worker IS NULL OR p_lease IS NULL THEN
    RAISE EXCEPTION 'research_upsert_company: a rollup write requires (job, worker, lease) - unfenced writes are not allowed';
  END IF;

  IF p_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM research_projects WHERE id = p_project_id AND tenant_id = p_tenant
  ) THEN
    RAISE EXCEPTION 'research_upsert_company: project % not in tenant %', p_project_id, p_tenant;
  END IF;
  IF p_icp_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM research_icps WHERE id = p_icp_id AND tenant_id = p_tenant
  ) THEN
    RAISE EXCEPTION 'research_upsert_company: icp % not in tenant %', p_icp_id, p_tenant;
  END IF;
  IF p_geo_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM research_geographies WHERE id = p_geo_id AND tenant_id = p_tenant
  ) THEN
    RAISE EXCEPTION 'research_upsert_company: geo % not in tenant %', p_geo_id, p_tenant;
  END IF;
  IF p_channel IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM research_channels WHERE id = p_channel AND tenant_id = p_tenant
  ) THEN
    RAISE EXCEPTION 'research_upsert_company: channel % not in tenant %', p_channel, p_tenant;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || p_tenant::text));

  PERFORM 1 FROM research_jobs
    WHERE id = p_job_id AND tenant_id = p_tenant
      AND status = 'running' AND locked_by = p_worker AND lease = p_lease
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_upsert_company: lease lost for job % (worker=%, fenced - not writing)',
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
    (tenant_id, canonical_key, project_id, domain, name, website, country, city, phone, address,
     status, score, site_summary, evidence, elimination_reason, icp_id, geo_id, source_path,
     channel_id, last_checked_at)
  VALUES
    (p_tenant, p_canonical_key, p_project_id, p_domain, p_name, p_website, p_country, p_city,
     p_phone, p_address, COALESCE(p_status, 'review'), p_score, p_site_summary, p_evidence,
     p_elimination_reason, p_icp_id, p_geo_id, p_source_path, p_channel, now())
  ON CONFLICT (tenant_id, canonical_key) DO UPDATE SET
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
     phone              = COALESCE(p_phone, research_companies.phone),
     address            = COALESCE(p_address, research_companies.address),
     channel_id         = COALESCE(p_channel, research_companies.channel_id),
     last_checked_at    = now(),
     updated_at         = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION research_upsert_company(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, UUID, TEXT, UUID, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_upsert_company(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, UUID, TEXT, UUID, TEXT, UUID, UUID) TO service_role;
