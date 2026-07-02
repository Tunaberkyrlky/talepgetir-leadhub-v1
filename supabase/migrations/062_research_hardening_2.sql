-- ==========================================
-- TG-Research v2 — Engine hardening, round 2 (pre-engine, run while tables are empty)
-- Folds in the second codex re-review (gpt-5.5 xhigh, FIX-FIRST, 11 findings). Items
-- map to those findings:
--   #1 P0  SELECT-only RLS              — user clients lose all DML on research tables
--   #2 P0  Race-safe suppression        — suppress + company-upsert + billing share ONE
--                                         per-tenant advisory lock (no TOCTOU)
--   #3 P1  Bill only CURRENT-APPROVED    — bill RPC re-reads under lock; requires the ICP
--          MATCH                          approved AND verdict.ruleset_version = icp's
--   #4 P1  Billing is the SOLE writer    — REVOKE DML on billable/ledger from service_role;
--                                         all writes go through SECURITY DEFINER RPCs
--   #5 P1  Tenant-pinned job refs        — UNIQUE(tenant_id,id) on jobs + RPC validates p_job_id
--   #6 P1  Atomic approval/versioning    — trigger bumps ruleset_version + reverts approved→draft
--   #7 P1  Queue lease fencing           — per-claim lease UUID; finalizers match on it
--   #8 P1  (doc) populated-migration safety — empty DB now; split add/backfill for prod replay
--   #9 P1  Registry is truly PII-free    — contact identity_key MUST be sha256 hex
--
-- Additive + re-runnable (IF NOT EXISTS / guarded DO blocks). Conventions mirror 055–061.
-- The billing/quota tables are written ONLY by the SECURITY DEFINER RPCs below (owned by
-- the migration role, which bypasses the service_role REVOKE) — never by app/worker code.
-- ==========================================


-- ============================================================================
-- #1 P0 — SELECT-ONLY RLS ON ALL RESEARCH TENANT TABLES
-- ----------------------------------------------------------------------------
-- 055/056/057 created self-serve INSERT/UPDATE/DELETE policies so an authenticated
-- client_admin could write research rows directly via PostgREST. That bypasses every
-- API guard: it could flip research_icps.status='approved' with no score, mutate the
-- frozen ai_draft, edit a ruleset without a version bump, or rewrite a billed company's
-- canonical_key (which a later bill retry would then charge again under the new key).
-- The LOCKED design is "user clients SELECT-only; the API + worker (service_role) do all
-- writes and scope tenant manually". Every research route already uses researchSupabaseAdmin
-- (service_role), so dropping these policies changes NOTHING for the app — it only closes
-- the direct-write hole. Belt AND suspenders: also REVOKE table DML from anon/authenticated
-- (RLS is the lock; the revoke means there is no privilege to even attempt a write).
-- ============================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'research_projects','research_hs_codes','research_markets','research_icps',
    'research_geographies','research_channels','research_chunks',
    'research_companies','research_contacts','research_trade_imports','research_messages'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_delete', t);
    -- SELECT policy stays. Remove any DML privilege the PostgREST roles were granted.
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I FROM anon, authenticated', t);
  END LOOP;
END $$;


-- ============================================================================
-- #5 P1 — TENANT-PINNED JOB REFERENCES
-- ----------------------------------------------------------------------------
-- Composite-FK target so a future child can reference (tenant_id, job_id). The billing
-- RPC (below) additionally validates p_job_id belongs to the resolved tenant (a job_id
-- provenance column is nullable, so a composite FK with ON DELETE SET NULL is impossible
-- — tenant_id is NOT NULL — hence the in-RPC check rather than a structural FK there).
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_research_jobs_tenant_id') THEN
    ALTER TABLE research_jobs ADD CONSTRAINT uq_research_jobs_tenant_id UNIQUE (tenant_id, id);
  END IF;
END $$;


-- ============================================================================
-- #7 P1 — QUEUE LEASE FENCING
-- ----------------------------------------------------------------------------
-- locked_by is a stable per-worker id, not a per-attempt token: if a job is reaped and
-- reclaimed, the old worker's late heartbeat/complete is rejected only because the new
-- claim changed locked_by — but two workers that happen to share an id (or a reclaim by
-- the SAME worker after a reap) could still collide. `lease` is a fresh UUID minted on
-- every claim; every finalizer (heartbeat/complete/fail) must match it, so only the
-- attempt that currently holds the lease can mutate the job. A stale attempt is fenced.
-- ============================================================================
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS lease UUID;


-- ============================================================================
-- #8 P1 (partial) — honest provenance for legacy ICPs
-- 061 defaulted research_icps.source to 'ai'; on a populated prod DB that would mislabel
-- pre-existing rows. Allow an explicit 'legacy' value so a prod backfill can mark them
-- truthfully (the test DB is empty, so nothing is mislabeled here).
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'research_icps_source_check') THEN
    ALTER TABLE research_icps DROP CONSTRAINT research_icps_source_check;
  END IF;
  ALTER TABLE research_icps
    ADD CONSTRAINT research_icps_source_check CHECK (source IN ('ai','manual','legacy'));
END $$;

-- #7 idempotent ICP persistence: a stable per-job draft index so a retry UPSERTs its own
-- rows instead of inserting a second full set. Partial-unique (job-generated rows only).
ALTER TABLE research_icps ADD COLUMN IF NOT EXISTS draft_index INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_icps_job_draft
  ON research_icps(generated_by_job_id, draft_index)
  WHERE generated_by_job_id IS NOT NULL AND draft_index IS NOT NULL;


-- ============================================================================
-- #9 P1 — SUPPRESSION REGISTRY IS TRULY PII-FREE
-- ----------------------------------------------------------------------------
-- entity_type='contact' identity_key MUST be a sha256 hex digest of the email, never the
-- raw address. Company keys are canonical_key (a business identity, not personal data).
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'research_suppression_identity_format') THEN
    ALTER TABLE research_suppression
      ADD CONSTRAINT research_suppression_identity_format CHECK (
        entity_type = 'company'
        OR (entity_type = 'contact' AND identity_key ~ '^[a-f0-9]{64}$')
      );
  END IF;
END $$;


-- ============================================================================
-- #4 P1 — BILLING TABLES ARE WRITTEN ONLY BY RPCs
-- ----------------------------------------------------------------------------
-- Make "research_bill_match is the sole billing entry point" structural, not a comment.
-- A direct INSERT into research_billable_events would make the RPC's ON CONFLICT DO NOTHING
-- find a row and return it WITHOUT a ledger decrement (a free MATCH); a DELETE would let it
-- re-bill. So revoke INSERT/UPDATE/DELETE on both billing tables from every PostgREST role
-- AND from service_role. The SECURITY DEFINER RPCs below run as the function owner (the
-- migration role) and so still write them. (Verified: no app/worker code writes these two
-- tables directly — all billing/quota mutation goes through the RPCs.)
-- ============================================================================
REVOKE INSERT, UPDATE, DELETE ON research_billable_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON research_usage_ledger    FROM PUBLIC, anon, authenticated, service_role;


-- ============================================================================
-- #6 P1 — ATOMIC RULESET VERSIONING + APPROVAL INTEGRITY (trigger)
-- ----------------------------------------------------------------------------
-- Moving the version bump into the DB removes the route's read-modify-write race (two
-- concurrent edits both computing N+1). On UPDATE, if any ruleset array actually changed:
--   • ruleset_version := OLD.ruleset_version + 1   (so prior verdicts are re-scorable), and
--   • if it was approved, revert to 'draft'        (an edited ruleset must be re-approved —
--     otherwise a stale, no-longer-current ruleset stays "approved" and billable via #3).
-- Comparing the JSONB columns directly is exact (no text-normalization drift).
-- ============================================================================
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
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS research_icps_ruleset_guard ON research_icps;
CREATE TRIGGER research_icps_ruleset_guard
  BEFORE UPDATE ON research_icps
  FOR EACH ROW EXECUTE FUNCTION research_icps_ruleset_guard();


-- ============================================================================
-- #2 P0 + #4 — CREDIT GRANT RPC (the only way to add credits; takes the bill lock)
-- ----------------------------------------------------------------------------
-- Every writer of research_usage_ledger must serialize on the same per-tenant lock the
-- billing RPC uses, or balance_after races. Grants/top-ups go through here. Returns the
-- new balance. (Also the pilot's funding path.)
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
  v_balance INTEGER;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'research_grant_credits: amount must be positive (got %)', p_amount;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || p_tenant::text));

  -- balance_after is the running total = SUM(delta). Compute it from the SUM, NOT by
  -- reading the previous row's balance_after: within one transaction now() (and hence
  -- created_at) is constant, so "ORDER BY created_at DESC, id DESC LIMIT 1" tiebreaks on a
  -- random uuid and can read the wrong row. Under the advisory lock SUM(delta) is exact.
  v_balance := COALESCE((SELECT sum(delta) FROM research_usage_ledger WHERE tenant_id = p_tenant), 0) + p_amount;

  INSERT INTO research_usage_ledger (tenant_id, delta, reason, ref_type, ref_id, balance_after)
  VALUES (p_tenant, p_amount, COALESCE(p_reason, 'grant'), p_ref_type, p_ref_id, v_balance);

  RETURN v_balance;
END;
$$;

REVOKE ALL ON FUNCTION research_grant_credits(UUID, INTEGER, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_grant_credits(UUID, INTEGER, TEXT, TEXT, UUID) TO service_role;


-- Cheap balance read (latest ledger snapshot). For pre-run quota checks. SELECT-side, but
-- exposed as a DEFINER fn so the worker reads it uniformly even after the table REVOKE.
CREATE OR REPLACE FUNCTION research_credit_balance(p_tenant UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Authoritative balance = SUM(delta) (order-independent; balance_after is a denormalized
  -- audit cache, not the source of truth — see research_grant_credits for why).
  SELECT COALESCE((SELECT sum(delta)::int FROM research_usage_ledger WHERE tenant_id = p_tenant), 0);
$$;
REVOKE ALL ON FUNCTION research_credit_balance(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_credit_balance(UUID) TO service_role;


-- ============================================================================
-- #2 P0 — RACE-SAFE COMPANY UPSERT (engine's only company writer)
-- ----------------------------------------------------------------------------
-- Closes the insert-vs-suppress TOCTOU: the engine creates/updates companies ONLY through
-- this RPC, which takes the SAME per-tenant lock as research_suppress_company and
-- research_bill_match. So a suppression can never interleave between this function's
-- suppression check and its insert — all three serialize. The BEFORE INSERT trigger from
-- 060 remains as a backstop. ON CONFLICT refreshes the scoring fields (re-scoring from the
-- cached summary under a new ruleset is allowed) but never touches first_seen_at/billed_at.
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
  p_status            TEXT    DEFAULT 'review',
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

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || p_tenant::text));

  -- Suppression > dedup (re-checked under the shared lock; trigger is the backstop).
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
     status             = EXCLUDED.status,
     score              = EXCLUDED.score,
     site_summary       = COALESCE(EXCLUDED.site_summary, research_companies.site_summary),
     evidence           = COALESCE(EXCLUDED.evidence, research_companies.evidence),
     elimination_reason = EXCLUDED.elimination_reason,
     icp_id             = COALESCE(EXCLUDED.icp_id, research_companies.icp_id),
     geo_id             = COALESCE(EXCLUDED.geo_id, research_companies.geo_id),
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
-- #2 P0 — TRANSACTIONAL SUPPRESSION / ERASURE (one RPC, shared lock)
-- ----------------------------------------------------------------------------
-- The single entry point to suppress a company. Takes the shared bill lock so it
-- serializes against billing AND company upsert; records the PII-free registry row;
-- flips the suppressed flag on any existing company rows (the UPDATE path the
-- INSERT-only trigger can't cover); and, for a KVKK erasure, hard-deletes the PII rows
-- (billable_events.company_id ON DELETE SET NULL keeps the bill-once guard alive, so
-- re-discovery stays free). Returns the number of company rows affected.
-- ============================================================================
CREATE OR REPLACE FUNCTION research_suppress_company(
  p_tenant        UUID,
  p_canonical_key TEXT,
  p_source        TEXT    DEFAULT 'manual',
  p_hard_erase    BOOLEAN DEFAULT false
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_affected INTEGER;
BEGIN
  IF p_source NOT IN ('erasure_request','opt_out','bounce','manual') THEN
    RAISE EXCEPTION 'research_suppress_company: invalid source %', p_source;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || p_tenant::text));

  INSERT INTO research_suppression (tenant_id, entity_type, identity_key, source)
  VALUES (p_tenant, 'company', p_canonical_key, p_source)
  ON CONFLICT (tenant_id, entity_type, identity_key) DO NOTHING;

  IF p_hard_erase THEN
    DELETE FROM research_companies
      WHERE tenant_id = p_tenant AND canonical_key = p_canonical_key;
    GET DIAGNOSTICS v_affected = ROW_COUNT;
  ELSE
    UPDATE research_companies
      SET suppressed = true, suppressed_at = now(), suppressed_reason = p_source
      WHERE tenant_id = p_tenant AND canonical_key = p_canonical_key;
    GET DIAGNOSTICS v_affected = ROW_COUNT;
  END IF;

  RETURN v_affected;
END;
$$;

REVOKE ALL ON FUNCTION research_suppress_company(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_suppress_company(UUID, TEXT, TEXT, BOOLEAN) TO service_role;


-- ============================================================================
-- #3 P1 + #2 + #5 — research_bill_match() rewrite: bill only a CURRENT, APPROVED,
--                   UNSUPPRESSED MATCH; re-read authoritatively UNDER the lock.
-- ----------------------------------------------------------------------------
-- Round-1 read the verdict before locking and proved only verdict='match'. That let a
-- stale-ruleset verdict, or a MATCH under an unapproved/edited ICP, be billed. Now:
--   1. resolve tenant (cheap) → take the per-tenant lock
--   2. re-read verdict JOIN company JOIN icp FOR UPDATE under the lock and REQUIRE:
--        verdict.verdict = 'match'
--        icp.status = 'approved'
--        verdict.ruleset_version = icp.ruleset_version   (not a superseded ruleset)
--        company NOT suppressed (registry AND the row flag)
--   3. validate p_job_id belongs to this tenant (else NULL it — no cross-tenant provenance)
--   4. bill once-ever (tenant, canonical_key); on dedup return the existing event, no ledger
--   5. first charge → ledger decrement + link
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
  -- (1) Cheap resolve of tenant so we can take the lock before the authoritative read.
  SELECT tenant_id INTO v_tenant FROM research_company_verdicts WHERE id = p_verdict_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_bill_match: verdict % not found', p_verdict_id;
  END IF;

  -- (2) Serialize all billing/suppression/upsert for this tenant.
  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || v_tenant::text));

  -- Authoritative re-read UNDER the lock with row locks. Require a current, approved MATCH.
  SELECT v.company_id, c.canonical_key
    INTO v_company, v_canon
  FROM research_company_verdicts v
  JOIN research_companies c ON c.id = v.company_id AND c.tenant_id = v.tenant_id
  JOIN research_icps       i ON i.id = v.icp_id     AND i.tenant_id = v.tenant_id
  WHERE v.id = p_verdict_id
    AND v.verdict = 'match'
    AND i.status = 'approved'
    AND v.ruleset_version = i.ruleset_version
    AND c.suppressed = false
  FOR UPDATE OF v, c;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'research_bill_match: verdict % is not a current, approved, unsuppressed MATCH (refusing to bill)',
      p_verdict_id USING ERRCODE = 'check_violation';
  END IF;

  -- Suppression registry guard (identity may be suppressed even if a row flag lagged).
  IF EXISTS (
    SELECT 1 FROM research_suppression
    WHERE tenant_id = v_tenant AND entity_type = 'company' AND identity_key = v_canon
  ) THEN
    RAISE EXCEPTION 'research_bill_match: refusing to bill suppressed company (tenant=%, key=%)',
      v_tenant, v_canon USING ERRCODE = 'check_violation';
  END IF;

  -- (3) Tenant-validate the provenance job_id (drop it rather than store a cross-tenant ref).
  v_job := NULL;
  IF p_job_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM research_jobs WHERE id = p_job_id AND tenant_id = v_tenant
  ) THEN
    v_job := p_job_id;
  END IF;

  -- (4) Bill once, ever.
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

  -- (5) First charge → decrement quota (idempotent via uq_research_usage_ledger_ref).
  -- balance_after = running SUM(delta) under the lock (NOT the previous row's cached value;
  -- created_at ties within a txn make last-row ordering non-deterministic).
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

-- Re-assert the EXECUTE ACL (CREATE OR REPLACE keeps prior grants, but be explicit).
REVOKE ALL ON FUNCTION research_bill_match(UUID, TEXT, NUMERIC, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_bill_match(UUID, TEXT, NUMERIC, UUID) TO service_role;


-- ============================================================================
-- #7 P1 — research_claim_job() mints a per-attempt lease (fencing token)
-- ----------------------------------------------------------------------------
-- Same single-statement fair claim as 060, but it now also sets lease = gen_random_uuid()
-- and returns it. The worker threads that lease into every heartbeat/complete/fail
-- predicate, so a reaped-and-reclaimed job can't be finalized by the prior attempt.
-- ============================================================================
CREATE OR REPLACE FUNCTION research_claim_job(
  p_worker_id TEXT,
  p_types     TEXT[] DEFAULT NULL
)
RETURNS SETOF research_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH running AS (
    SELECT tenant_id, count(*) AS n
    FROM research_jobs
    WHERE status = 'running'
    GROUP BY tenant_id
  ),
  candidate AS (
    SELECT j.id
    FROM research_jobs j
    LEFT JOIN running r ON r.tenant_id = j.tenant_id
    WHERE j.status = 'queued'
      AND j.scheduled_at <= now()
      AND (p_types IS NULL OR j.type = ANY(p_types))
    ORDER BY COALESCE(r.n, 0) ASC,
             j.priority DESC,
             j.scheduled_at ASC,
             j.created_at ASC
    FOR UPDATE OF j SKIP LOCKED
    LIMIT 1
  )
  UPDATE research_jobs j
  SET status       = 'running',
      attempts     = attempts + 1,
      locked_by    = p_worker_id,
      lease        = gen_random_uuid(),
      locked_at    = now(),
      heartbeat_at = now(),
      started_at   = COALESCE(started_at, now()),
      updated_at   = now()
  FROM candidate
  WHERE j.id = candidate.id
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION research_claim_job(TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_claim_job(TEXT, TEXT[]) TO service_role;
