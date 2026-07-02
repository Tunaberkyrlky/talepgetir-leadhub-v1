-- ==========================================
-- TG-Research v2 — Engine hardening, round 3 (pre-engine, empty tables)
-- Closes the residual P1s from the codex VERIFICATION pass on 062. 062's #1/#2-race/#4/#5/#6/#9
-- verified PASS; this fixes what was STILL-BROKEN or newly found:
--   #3   research_bill_match locked v,c but not the ICP row → a concurrent ruleset edit could
--        commit between the read and the bill. Lock the ICP too (FOR UPDATE OF v,c,i) and pin
--        v.tenant_id = the resolved tenant.
--   NEW  research_upsert_company ON CONFLICT reset status/score (default 'review') → clobbered an
--        existing MATCH/ELIMINATED rollup. Preserve on NULL; only overwrite when explicitly given.
--   NEW  research_upsert_company trusted project/icp/geo IDs → validate they belong to p_tenant.
--   NEW  research_grant_credits was not retry-idempotent (NULL ref bypassed the unique ref index)
--        → accept an idempotency key and ON CONFLICT DO NOTHING.
--   #7   ICP draft persistence was an unfenced delete+insert across two txns → one fenced,
--        atomic RPC keyed on (job, locked_by, lease).
-- Additive + re-runnable. All SECURITY DEFINER, search_path pinned, service_role-only EXECUTE.
-- ==========================================


-- ============================================================================
-- #3 — research_bill_match: lock the ICP row too + pin verdict tenant
-- ============================================================================
CREATE OR REPLACE FUNCTION research_bill_match(
  p_verdict_id      UUID,
  p_pricing_version TEXT    DEFAULT 'v1',
  p_amount_usd      NUMERIC DEFAULT 0,
  p_job_id          UUID    DEFAULT NULL
)
RETURNS research_billable_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant   UUID;
  v_company  UUID;
  v_canon    TEXT;
  v_event    research_billable_events;
  v_balance  INTEGER;
  v_ledger   UUID;
  v_job      UUID;
BEGIN
  SELECT tenant_id INTO v_tenant FROM research_company_verdicts WHERE id = p_verdict_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_bill_match: verdict % not found', p_verdict_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || v_tenant::text));

  -- Authoritative re-read UNDER the lock, row-locking verdict + company + ICP so a concurrent
  -- ruleset edit (a plain UPDATE on research_icps, which does NOT take the advisory lock) can't
  -- commit between this read and the bill. Pin v.tenant_id to the resolved tenant.
  SELECT v.company_id, c.canonical_key
    INTO v_company, v_canon
  FROM research_company_verdicts v
  JOIN research_companies c ON c.id = v.company_id AND c.tenant_id = v.tenant_id
  JOIN research_icps       i ON i.id = v.icp_id     AND i.tenant_id = v.tenant_id
  WHERE v.id = p_verdict_id
    AND v.tenant_id = v_tenant
    AND v.verdict = 'match'
    AND i.status = 'approved'
    AND v.ruleset_version = i.ruleset_version
    AND c.suppressed = false
  FOR UPDATE OF v, c, i;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'research_bill_match: verdict % is not a current, approved, unsuppressed MATCH (refusing to bill)',
      p_verdict_id USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM research_suppression
    WHERE tenant_id = v_tenant AND entity_type = 'company' AND identity_key = v_canon
  ) THEN
    RAISE EXCEPTION 'research_bill_match: refusing to bill suppressed company (tenant=%, key=%)',
      v_tenant, v_canon USING ERRCODE = 'check_violation';
  END IF;

  v_job := NULL;
  IF p_job_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM research_jobs WHERE id = p_job_id AND tenant_id = v_tenant
  ) THEN
    v_job := p_job_id;
  END IF;

  INSERT INTO research_billable_events
    (tenant_id, company_id, canonical_key, pricing_version, unit, amount_usd, job_id)
  VALUES
    (v_tenant, v_company, v_canon, p_pricing_version, 'match_lead', p_amount_usd, v_job)
  ON CONFLICT (tenant_id, canonical_key) DO NOTHING
  RETURNING * INTO v_event;

  IF NOT FOUND THEN
    SELECT * INTO v_event FROM research_billable_events
      WHERE tenant_id = v_tenant AND canonical_key = v_canon;
    RETURN v_event;
  END IF;

  v_balance := COALESCE((SELECT sum(delta) FROM research_usage_ledger WHERE tenant_id = v_tenant), 0) - 1;

  INSERT INTO research_usage_ledger (tenant_id, delta, reason, ref_type, ref_id, balance_after)
  VALUES (v_tenant, -1, 'match_lead', 'billable_event', v_event.id, v_balance)
  RETURNING id INTO v_ledger;

  UPDATE research_billable_events SET ledger_id = v_ledger
    WHERE id = v_event.id
    RETURNING * INTO v_event;

  RETURN v_event;
END;
$$;
REVOKE ALL ON FUNCTION research_bill_match(UUID, TEXT, NUMERIC, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_bill_match(UUID, TEXT, NUMERIC, UUID) TO service_role;


-- ============================================================================
-- NEW — research_upsert_company: preserve rollup on re-upsert + tenant-validate refs
-- p_status defaults NULL now: a dedup re-upsert that omits a status/score keeps the existing
-- value (so a later pass can't silently downgrade a MATCH to 'review'); a fresh insert with no
-- status defaults to 'review'. project/icp/geo IDs are validated against p_tenant.
-- ============================================================================
CREATE OR REPLACE FUNCTION research_upsert_company(
  p_tenant            UUID,
  p_canonical_key     TEXT,
  p_project_id        UUID    DEFAULT NULL,
  p_domain            TEXT    DEFAULT NULL,
  p_name              TEXT    DEFAULT NULL,
  p_website           TEXT    DEFAULT NULL,
  p_country           TEXT    DEFAULT NULL,
  p_city              TEXT    DEFAULT NULL,
  p_status            TEXT    DEFAULT NULL,
  p_score             INTEGER DEFAULT NULL,
  p_site_summary      TEXT    DEFAULT NULL,
  p_evidence          TEXT    DEFAULT NULL,
  p_elimination_reason TEXT   DEFAULT NULL,
  p_icp_id            UUID    DEFAULT NULL,
  p_geo_id            UUID    DEFAULT NULL,
  p_source_path       TEXT    DEFAULT NULL
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

  IF EXISTS (
    SELECT 1 FROM research_suppression
    WHERE tenant_id = p_tenant AND entity_type = 'company' AND identity_key = p_canonical_key
  ) THEN
    RAISE EXCEPTION 'research_upsert_company: company is suppressed (tenant=%, key=%)',
      p_tenant, p_canonical_key USING ERRCODE = 'check_violation';
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
     -- raw p_* params, NOT EXCLUDED: EXCLUDED.status is the post-default insert value ('review'),
     -- so COALESCE(EXCLUDED.status, …) would clobber an existing MATCH on every omitted status.
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
REVOKE ALL ON FUNCTION research_upsert_company(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_upsert_company(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, UUID, TEXT)
  TO service_role;


-- ============================================================================
-- NEW — research_grant_credits: retry-idempotent via an optional idempotency key
-- When p_ref_id is provided, a retry conflicts on uq_research_usage_ledger_ref and is a no-op
-- (returns the already-granted balance). Without a key it stays a plain (non-idempotent) grant.
-- ============================================================================
CREATE OR REPLACE FUNCTION research_grant_credits(
  p_tenant   UUID,
  p_amount   INTEGER,
  p_reason   TEXT DEFAULT 'grant',
  p_ref_type TEXT DEFAULT NULL,
  p_ref_id   UUID DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance  INTEGER;
  v_inserted INTEGER;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'research_grant_credits: amount must be positive (got %)', p_amount;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || p_tenant::text));

  v_balance := COALESCE((SELECT sum(delta) FROM research_usage_ledger WHERE tenant_id = p_tenant), 0) + p_amount;

  INSERT INTO research_usage_ledger (tenant_id, delta, reason, ref_type, ref_id, balance_after)
  VALUES (p_tenant, p_amount, COALESCE(p_reason, 'grant'), p_ref_type, p_ref_id, v_balance)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Idempotent retry (the same ref already granted): report the actual current balance.
  IF v_inserted = 0 THEN
    v_balance := COALESCE((SELECT sum(delta) FROM research_usage_ledger WHERE tenant_id = p_tenant), 0);
  END IF;

  RETURN v_balance;
END;
$$;
REVOKE ALL ON FUNCTION research_grant_credits(UUID, INTEGER, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_grant_credits(UUID, INTEGER, TEXT, TEXT, UUID) TO service_role;


-- ============================================================================
-- #7 — research_persist_icp_drafts: fenced, atomic ICP draft persistence
-- One transaction, gated on (job, tenant, status='running', locked_by, lease): a stale attempt
-- whose lease no longer matches writes NOTHING (so it can't delete/clobber the live attempt's
-- drafts). Replaces the handler's unfenced delete-then-insert. Returns the inserted ids.
-- ============================================================================
CREATE OR REPLACE FUNCTION research_persist_icp_drafts(
  p_tenant     UUID,
  p_project_id UUID,
  p_job_id     UUID,
  p_worker     TEXT,
  p_lease      UUID,
  p_drafts     JSONB
)
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Fence: only the attempt that currently holds the lease may persist. Row-lock the job.
  PERFORM 1 FROM research_jobs
   WHERE id = p_job_id AND tenant_id = p_tenant
     AND status = 'running' AND locked_by = p_worker AND lease IS NOT DISTINCT FROM p_lease
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_persist_icp_drafts: lease lost for job % (worker=%, fenced)', p_job_id, p_worker
      USING ERRCODE = 'check_violation';
  END IF;

  -- Idempotent: clear this job's prior drafts, then insert the current set, atomically.
  DELETE FROM research_icps WHERE tenant_id = p_tenant AND generated_by_job_id = p_job_id;

  RETURN QUERY
  INSERT INTO research_icps
    (tenant_id, project_id, name, code, segment, signals, negative_signals, neutral_signals,
     elimination_rules, lookalike_companies, ai_draft, source, status, generated_by_job_id, draft_index)
  SELECT
    p_tenant, p_project_id,
    d->>'name', d->>'code', d->>'segment',
    COALESCE(d->'signals', '[]'::jsonb),
    COALESCE(d->'negative_signals', '[]'::jsonb),
    COALESCE(d->'neutral_signals', '[]'::jsonb),
    COALESCE(d->'elimination_rules', '[]'::jsonb),
    COALESCE(d->'lookalike_companies', '[]'::jsonb),
    d, 'ai', 'draft', p_job_id, (ord - 1)::int
  FROM jsonb_array_elements(p_drafts) WITH ORDINALITY AS t(d, ord)
  RETURNING id;
END;
$$;
REVOKE ALL ON FUNCTION research_persist_icp_drafts(UUID, UUID, UUID, TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_persist_icp_drafts(UUID, UUID, UUID, TEXT, UUID, JSONB) TO service_role;
