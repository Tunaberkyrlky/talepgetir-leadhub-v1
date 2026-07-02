-- ==========================================
-- TG-Research v2 — Verdict hardening round 2 (codex review of 067, FIX-FIRST: 1×P0 + 1×P1 + 2×P2)
-- ------------------------------------------------------------------------------
--   P0  research_company_verdicts DML was never revoked from service_role — the app could still
--       INSERT/UPDATE/DELETE verdicts directly, bypassing the 067 fence/suppression/immutability
--       (invariant 4: state-machine tables are written ONLY by SECURITY DEFINER RPCs). FIX: revoke,
--       mirroring the billing/holds tables. research_persist_verdict (definer = migration owner)
--       remains the sole writer.
--
--   P1  research_unbilled_match_verdicts included SUPPRESSED matches. Billing refuses them, so they
--       stay "unbilled" forever — 500 suppressed rows could permanently occupy the deterministic
--       LIMIT batch and STARVE eligible matches (lost revenue, the exact failure reconciliation
--       exists to prevent). FIX: filter both the rollup flag and the suppression registry.
--
--   P2a persistVerdict's TS wrapper mapped EVERY check_violation (23514) to SuppressedError — the
--       verdict table's own score CHECK could masquerade as suppression and silently skip a
--       candidate. FIX (structural, like 066's RESERVATION_EXHAUSTED): both suppression refusals
--       now carry DETAIL markers ('SUPPRESSED' / 'SUPPRESSED_OR_MISSING'); the wrapper keys off
--       DETAIL, and any OTHER 23514 is a hard error.
--
--   P2b The billed-match immutability guard correlated billing by canonical_key only: a charge
--       billed under ICP A froze a same-company match row under ICP B that was never the billing
--       basis (stale per-ICP evidence, though never revenue loss — billing is once-ever). FIX:
--       research_billable_events now records the billed verdict_id; the guard freezes ONLY the row
--       the charge actually points at. Legacy events (verdict_id NULL, pre-069) keep the
--       conservative canonical-key freeze.
--
-- Additive + re-runnable. SECURITY DEFINER, search_path pinned, service_role-only EXECUTE.
-- ==========================================


-- ============================================================================
-- P0 — research_company_verdicts is RPC-ONLY now (mirror billing/holds)
-- ============================================================================
REVOKE INSERT, UPDATE, DELETE ON research_company_verdicts FROM PUBLIC, anon, authenticated, service_role;


-- ============================================================================
-- P2b — record the billed verdict on the event (billing basis, for the precise freeze)
-- ============================================================================
ALTER TABLE research_billable_events
  ADD COLUMN IF NOT EXISTS verdict_id UUID REFERENCES research_company_verdicts(id) ON DELETE SET NULL;

-- Same 7-arg signature as 066 → CREATE OR REPLACE. Body identical except the INSERT now records
-- p_verdict_id as the billing basis.
CREATE OR REPLACE FUNCTION research_bill_match(
  p_verdict_id      UUID,
  p_pricing_version TEXT    DEFAULT 'v1',
  p_amount_usd      NUMERIC DEFAULT 0,
  p_job_id          UUID    DEFAULT NULL,
  p_hold_id         UUID    DEFAULT NULL,
  p_worker          TEXT    DEFAULT NULL,
  p_lease           UUID    DEFAULT NULL
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
  v_hold     research_usage_holds;
BEGIN
  SELECT tenant_id INTO v_tenant FROM research_company_verdicts WHERE id = p_verdict_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_bill_match: verdict % not found', p_verdict_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || v_tenant::text));

  -- Authoritative re-read UNDER the lock, row-locking verdict + company + ICP (063 #3).
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

  -- (066 P1) ATOMIC LEASE FENCE: row-LOCK the job so reap/reclaim serialize against the charge.
  v_job := NULL;
  IF p_job_id IS NOT NULL THEN
    IF p_worker IS NULL OR p_lease IS NULL THEN
      RAISE EXCEPTION 'research_bill_match: a job-attributed charge requires worker+lease (job=%)', p_job_id;
    END IF;
    PERFORM 1 FROM research_jobs
      WHERE id = p_job_id AND tenant_id = v_tenant
        AND status = 'running' AND locked_by = p_worker AND lease = p_lease
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'research_bill_match: lease lost for job % (worker=%, fenced — not billing)',
        p_job_id, p_worker;
    END IF;
    v_job := p_job_id;
  END IF;

  -- Bill once, ever — recording the verdict this charge is based on (069, the precise
  -- immutability anchor for research_persist_verdict).
  INSERT INTO research_billable_events
    (tenant_id, company_id, canonical_key, pricing_version, unit, amount_usd, job_id, verdict_id)
  VALUES
    (v_tenant, v_company, v_canon, p_pricing_version, 'match_lead', p_amount_usd, v_job, p_verdict_id)
  ON CONFLICT (tenant_id, canonical_key) DO NOTHING
  RETURNING * INTO v_event;

  IF NOT FOUND THEN
    -- Dedup: already billed once-ever. No new charge, no ledger decrement, no hold consumption.
    SELECT * INTO v_event FROM research_billable_events
      WHERE tenant_id = v_tenant AND canonical_key = v_canon;
    RETURN v_event;
  END IF;

  -- (066 P0) A FRESH charge is STRUCTURALLY gated on a reservation hold.
  IF p_hold_id IS NULL THEN
    RAISE EXCEPTION 'research_bill_match: a fresh charge requires a reservation hold (p_hold_id is null)';
  END IF;
  SELECT * INTO v_hold FROM research_usage_holds
    WHERE id = p_hold_id AND tenant_id = v_tenant
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_bill_match: hold % not found for tenant %', p_hold_id, v_tenant;
  END IF;
  IF v_hold.status <> 'open' OR (v_hold.reserved - v_hold.settled) <= 0 THEN
    RAISE EXCEPTION
      'research_bill_match: reservation exhausted (hold=%, reserved=%, settled=%, status=%)',
      p_hold_id, v_hold.reserved, v_hold.settled, v_hold.status
      USING ERRCODE = 'check_violation', DETAIL = 'RESERVATION_EXHAUSTED';
  END IF;

  -- (064) HARD FLOOR backstop.
  v_balance := COALESCE((SELECT sum(delta) FROM research_usage_ledger WHERE tenant_id = v_tenant), 0) - 1;
  IF v_balance < 0 THEN
    RAISE EXCEPTION
      'research_bill_match: insufficient credits to bill match (tenant=%, key=%, balance_would_be=%)',
      v_tenant, v_canon, v_balance USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO research_usage_ledger (tenant_id, delta, reason, ref_type, ref_id, balance_after)
  VALUES (v_tenant, -1, 'match_lead', 'billable_event', v_event.id, v_balance)
  RETURNING id INTO v_ledger;

  -- Consume one unit of the reservation atomically with the decrement (capacity checked above).
  UPDATE research_usage_holds SET settled = settled + 1 WHERE id = p_hold_id;

  UPDATE research_billable_events SET ledger_id = v_ledger
    WHERE id = v_event.id
    RETURNING * INTO v_event;

  RETURN v_event;
END;
$$;
REVOKE ALL ON FUNCTION research_bill_match(UUID, TEXT, NUMERIC, UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_bill_match(UUID, TEXT, NUMERIC, UUID, UUID, TEXT, UUID) TO service_role;


-- ============================================================================
-- P2a + P2b — research_persist_verdict: structured suppression DETAIL + precise freeze
-- Same signature as 067 → CREATE OR REPLACE.
-- ============================================================================
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
  p_lease              UUID
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

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || p_tenant::text));

  -- ATOMIC LEASE FENCE (mirrors 066 billing).
  PERFORM 1 FROM research_jobs
    WHERE id = p_job_id AND tenant_id = p_tenant
      AND status = 'running' AND locked_by = p_worker AND lease = p_lease
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_persist_verdict: lease lost for job % (worker=%, fenced — not persisting)',
      p_job_id, p_worker;
  END IF;

  -- Resolve + row-lock the company UNDER the lock. Both suppression refusals carry a structured
  -- DETAIL marker (069 P2a) — the wrapper keys off DETAIL, never the message or bare SQLSTATE.
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

  -- BILLED-MATCH IMMUTABILITY (069 P2b — precise): freeze ONLY the verdict row a charge actually
  -- points at (billable_events.verdict_id). Legacy events (verdict_id NULL, pre-069) keep the
  -- conservative canonical-key freeze: any existing match row for a billed key stays immutable.
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
    (tenant_id, company_id, icp_id, ruleset_version, verdict, score, evidence, elimination_reason, model)
  VALUES
    (p_tenant, p_company_id, p_icp_id, p_ruleset_version, p_verdict, p_score, p_evidence,
     p_elimination_reason, p_model)
  ON CONFLICT (tenant_id, company_id, icp_id, ruleset_version) DO UPDATE SET
    verdict            = EXCLUDED.verdict,
    score              = EXCLUDED.score,
    evidence           = EXCLUDED.evidence,
    elimination_reason = EXCLUDED.elimination_reason,
    model              = EXCLUDED.model
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION research_persist_verdict(UUID, UUID, UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_persist_verdict(UUID, UUID, UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, TEXT, UUID, TEXT, UUID)
  TO service_role;


-- ============================================================================
-- P1 — reconciliation excludes suppressed matches (no batch starvation)
-- A suppressed match can NEVER bill (the RPC refuses), so surfacing it as "unbilled" only burns
-- the bounded batch. Filter both the rollup flag and the durable registry.
-- ============================================================================
CREATE OR REPLACE FUNCTION research_unbilled_match_verdicts(
  p_tenant  UUID,
  p_icp_id  UUID,
  p_ruleset INTEGER,
  p_limit   INTEGER DEFAULT 500
)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT v.id
  FROM research_company_verdicts v
  JOIN research_companies c
    ON c.id = v.company_id AND c.tenant_id = v.tenant_id
  WHERE v.tenant_id = p_tenant
    AND v.icp_id = p_icp_id
    AND v.ruleset_version = p_ruleset
    AND v.verdict = 'match'
    AND c.suppressed = false
    AND NOT EXISTS (
      SELECT 1 FROM research_suppression sup
      WHERE sup.tenant_id = v.tenant_id AND sup.entity_type = 'company'
        AND sup.identity_key = c.canonical_key
    )
    AND NOT EXISTS (
      SELECT 1 FROM research_billable_events e
      WHERE e.tenant_id = v.tenant_id AND e.canonical_key = c.canonical_key
    )
  ORDER BY v.created_at ASC, v.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000);
$$;
REVOKE ALL ON FUNCTION research_unbilled_match_verdicts(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_unbilled_match_verdicts(UUID, UUID, INTEGER, INTEGER) TO service_role;
