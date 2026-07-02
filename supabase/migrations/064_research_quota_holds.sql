-- ==========================================
-- TG-Research v2 — Pre-run quota holds + enforcement (05 §A.2 / D3-D4)
-- ------------------------------------------------------------------------------
-- Until now research_bill_match settled a realized MATCH (ledger −1) but NOTHING gated
-- a run before it spent COGS, so a tenant at 0 credits could enqueue a harvest, burn
-- search+LLM+fetch money, and drive the balance NEGATIVE; two concurrent runs could each
-- assume the full balance and collectively overspend. This adds the missing admission
-- control as three serialized layers, all on the SAME per-tenant advisory lock the
-- billing/suppression/upsert RPCs already use ('research_bill:'||tenant):
--
--   (A) HARD FLOOR  — research_bill_match refuses a FRESH charge when the balance would go
--                     below 0 (rolls back the just-inserted event via RAISE; a dedup hit is
--                     exempt — it was already paid). Makes "balance never negative" a
--                     structural invariant at the single billing chokepoint, not merely an
--                     engine-discipline property. The refusal is a check_violation (23514),
--                     which ledger.billMatch already treats as a non-fatal ineligibility, so
--                     the match is simply left unbilled for the reconciliation pass to settle
--                     once the tenant tops up (same path as a crash-gap match).
--   (B) AVAILABILITY READ — research_available_credits(tenant) = balance − Σ(open holds'
--                     outstanding). Cheap STABLE read for the route's pre-enqueue gate + UI.
--   (C) HOLDS       — reserve/settle/release on research_usage_holds (created empty in 055).
--                     reserve caps the reservation to what's actually available and refuses
--                     when available < min_required, so Σ reserved ≤ balance is serialized.
--                     settle records the realized count + releases the remainder; release
--                     frees the whole outstanding reservation on the failure path. A stale-
--                     hold reaper frees reservations stranded by a crashed worker.
--
-- research_usage_holds becomes RPC-only (DML revoked from every PostgREST role AND
-- service_role), mirroring the billing tables — the worker/route touch it only through
-- these SECURITY DEFINER functions. Additive + re-runnable. Conventions mirror 062/063.
-- ==========================================


-- ============================================================================
-- (A) HARD FLOOR — research_bill_match refuses to charge a FRESH match below 0 balance
-- ----------------------------------------------------------------------------
-- Identical to 063 except for ONE guard: after the once-ever event INSERT and the dedup
-- early-return, when this is a first charge we compute the post-charge balance and, if it
-- would be negative (i.e. the tenant has no credit left), RAISE — which aborts this RPC's
-- implicit transaction and ROLLS BACK the event we just inserted, so there is no orphan
-- billable_event without a ledger decrement. The dedup path returns BEFORE this guard, so
-- an already-billed company is always returned (it was charged when credit existed).
-- Everything else is byte-for-byte the 063 body.
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
    -- Dedup: already billed once-ever for this key. Return the existing event, no new charge,
    -- no floor check (it was charged when credit existed — re-discovery stays free).
    SELECT * INTO v_event FROM research_billable_events
      WHERE tenant_id = v_tenant AND canonical_key = v_canon;
    RETURN v_event;
  END IF;

  -- First charge → quota decrement. balance_after = running SUM(delta) under the lock (NOT the
  -- previous row's cached value; created_at ties within a txn make last-row ordering
  -- non-deterministic).
  v_balance := COALESCE((SELECT sum(delta) FROM research_usage_ledger WHERE tenant_id = v_tenant), 0) - 1;

  -- (A) HARD FLOOR: a fresh charge may not drive the balance negative. RAISE aborts this RPC's
  -- transaction, rolling back the event INSERT above (no orphan event). check_violation is the
  -- deliberate-refusal code ledger.billMatch maps to "ineligible → null" (not a transport error),
  -- so the match is left unbilled and the reconciliation pass settles it after a top-up.
  IF v_balance < 0 THEN
    RAISE EXCEPTION
      'research_bill_match: insufficient credits to bill match (tenant=%, key=%, balance_would_be=%)',
      v_tenant, v_canon, v_balance USING ERRCODE = 'check_violation';
  END IF;

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
-- research_usage_holds is RPC-ONLY (mirror the billing tables)
-- ----------------------------------------------------------------------------
-- 055 created only a SELECT policy (no DML policy), so PostgREST users already can't write.
-- Make "holds are written ONLY by the reserve/settle/release RPCs" structural by revoking
-- DML from service_role too — the worker/route must never write holds directly, only via the
-- SECURITY DEFINER functions below (which take the shared per-tenant lock). The functions run
-- as the owning migration role and so still write the table.
-- ============================================================================
REVOKE INSERT, UPDATE, DELETE ON research_usage_holds FROM PUBLIC, anon, authenticated, service_role;


-- ============================================================================
-- (B) AVAILABILITY READ — balance minus outstanding open reservations
-- ----------------------------------------------------------------------------
-- Cheap STABLE read for the route's pre-enqueue gate and the UI. NOT lock-protected (it is an
-- advisory snapshot); the authoritative admission decision is made by research_reserve_hold
-- under the lock. "Outstanding" on an open hold = reserved − settled − released (always =
-- reserved while open, but written defensively so a partially-settled-yet-open row is correct).
-- ============================================================================
CREATE OR REPLACE FUNCTION research_available_credits(p_tenant UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT sum(delta)::int FROM research_usage_ledger WHERE tenant_id = p_tenant), 0)
       - COALESCE((SELECT sum(reserved - settled - released)::int FROM research_usage_holds
                   WHERE tenant_id = p_tenant AND status = 'open'), 0);
$$;
REVOKE ALL ON FUNCTION research_available_credits(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_available_credits(UUID) TO service_role;


-- ============================================================================
-- (C) RESERVE — admission control: reserve up to `estimate` of the available pool
-- ----------------------------------------------------------------------------
-- Under the shared lock: available = balance − Σ(open holds' outstanding). Refuse (check_violation)
-- when available < min_required (a run with no spendable credit must not start and burn COGS).
-- Otherwise create an OPEN hold reserving LEAST(estimate, available) — capping to available keeps
-- Σ reserved ≤ balance, so even if every concurrent run bills its full reservation the balance
-- cannot go negative. Idempotent per job: a second reserve for the same (tenant, job) returns the
-- existing open hold rather than stacking a second reservation.
-- ============================================================================
CREATE OR REPLACE FUNCTION research_reserve_hold(
  p_tenant       UUID,
  p_job_id       UUID,
  p_estimate     INTEGER,
  p_min_required INTEGER DEFAULT 1
)
RETURNS research_usage_holds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance   INTEGER;
  v_reserved  INTEGER;
  v_available INTEGER;
  v_min       INTEGER := GREATEST(COALESCE(p_min_required, 1), 1);
  v_hold      research_usage_holds;
BEGIN
  IF p_estimate IS NULL OR p_estimate < 1 THEN
    RAISE EXCEPTION 'research_reserve_hold: estimate must be >= 1 (got %)', p_estimate;
  END IF;

  -- Reject a cross-tenant / unknown job reference (a bug, not a normal path — fail loudly).
  IF p_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM research_jobs WHERE id = p_job_id AND tenant_id = p_tenant
  ) THEN
    RAISE EXCEPTION 'research_reserve_hold: job % not in tenant %', p_job_id, p_tenant;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || p_tenant::text));

  -- Idempotency: one open reservation per job. A retry/re-entry returns the existing hold.
  IF p_job_id IS NOT NULL THEN
    SELECT * INTO v_hold FROM research_usage_holds
      WHERE tenant_id = p_tenant AND job_id = p_job_id AND status = 'open'
      ORDER BY created_at ASC
      LIMIT 1;
    IF FOUND THEN
      RETURN v_hold;
    END IF;
  END IF;

  -- Both sums are exact under the advisory lock (the same way research_grant_credits /
  -- research_bill_match read SUM(delta) without row-locking the ledger — the lock is the
  -- serialization point, so no concurrent reserve/settle can interleave for this tenant).
  v_balance := COALESCE((SELECT sum(delta) FROM research_usage_ledger WHERE tenant_id = p_tenant), 0);
  v_reserved := COALESCE((
    SELECT sum(reserved - settled - released) FROM research_usage_holds
    WHERE tenant_id = p_tenant AND status = 'open'
  ), 0);
  v_available := v_balance - v_reserved;

  IF v_available < v_min THEN
    RAISE EXCEPTION
      'research_reserve_hold: insufficient credits (available=%, required>=%)', v_available, v_min
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO research_usage_holds (tenant_id, job_id, reserved, status)
  VALUES (p_tenant, p_job_id, LEAST(p_estimate, v_available), 'open')
  RETURNING * INTO v_hold;

  RETURN v_hold;
END;
$$;
REVOKE ALL ON FUNCTION research_reserve_hold(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_reserve_hold(UUID, UUID, INTEGER, INTEGER) TO service_role;


-- ============================================================================
-- (C) SETTLE — record the realized count, release the remainder, close the hold
-- ----------------------------------------------------------------------------
-- Called once a run finishes. The realized matches were ALREADY billed (ledger −1 each) by
-- research_bill_match — the hold never touches the ledger; it is purely a reservation against
-- the available pool. Settling flips the hold to 'settled' so it stops counting against
-- availability. Idempotent: a hold already settled/released is returned unchanged. settled is
-- clamped to [0, reserved] defensively (the engine caps billing at reserved, so this is a guard).
-- ============================================================================
CREATE OR REPLACE FUNCTION research_settle_hold(
  p_hold_id  UUID,
  p_settled  INTEGER
)
RETURNS research_usage_holds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant   UUID;
  v_hold     research_usage_holds;
  v_settled  INTEGER;
BEGIN
  SELECT tenant_id INTO v_tenant FROM research_usage_holds WHERE id = p_hold_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_settle_hold: hold % not found', p_hold_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || v_tenant::text));

  SELECT * INTO v_hold FROM research_usage_holds WHERE id = p_hold_id FOR UPDATE;
  IF v_hold.status <> 'open' THEN
    RETURN v_hold; -- idempotent: already settled/released
  END IF;

  v_settled := LEAST(GREATEST(COALESCE(p_settled, 0), 0), v_hold.reserved);

  UPDATE research_usage_holds
    SET settled  = v_settled,
        released = v_hold.reserved - v_settled,
        status   = 'settled'
    WHERE id = p_hold_id
    RETURNING * INTO v_hold;

  RETURN v_hold;
END;
$$;
REVOKE ALL ON FUNCTION research_settle_hold(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_settle_hold(UUID, INTEGER) TO service_role;


-- ============================================================================
-- (C) RELEASE — free the whole outstanding reservation (failure / abort path)
-- ----------------------------------------------------------------------------
-- Used when a run throws before settling: release everything still reserved so the credits
-- return to the available pool. Keeps any already-settled amount (normally 0). Idempotent.
-- ============================================================================
CREATE OR REPLACE FUNCTION research_release_hold(
  p_hold_id UUID
)
RETURNS research_usage_holds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID;
  v_hold   research_usage_holds;
BEGIN
  SELECT tenant_id INTO v_tenant FROM research_usage_holds WHERE id = p_hold_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_release_hold: hold % not found', p_hold_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || v_tenant::text));

  SELECT * INTO v_hold FROM research_usage_holds WHERE id = p_hold_id FOR UPDATE;
  IF v_hold.status <> 'open' THEN
    RETURN v_hold; -- idempotent
  END IF;

  UPDATE research_usage_holds
    SET released = v_hold.reserved - v_hold.settled,
        status   = 'released'
    WHERE id = p_hold_id
    RETURNING * INTO v_hold;

  RETURN v_hold;
END;
$$;
REVOKE ALL ON FUNCTION research_release_hold(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_release_hold(UUID) TO service_role;


-- ============================================================================
-- (C) REAPER — release reservations stranded by a crashed worker
-- ----------------------------------------------------------------------------
-- The handler settles on success / releases on failure, but a hard process crash between
-- reserve and either finalizer would leave an OPEN hold forever subtracting from availability.
-- This frees any open hold whose linked job has reached a terminal state (succeeded/failed/
-- canceled) or whose job row is gone, plus orphan jobless open holds older than p_timeout.
-- Takes the per-tenant lock for each candidate (so it serializes with reserve/settle for that
-- tenant) and re-checks the hold is still open under the lock. Returns the number released.
-- Run periodically by the worker reaper tick alongside research_reap_stale_jobs.
-- ============================================================================
CREATE OR REPLACE FUNCTION research_release_stale_holds(
  p_timeout INTERVAL DEFAULT '15 minutes'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
  r       RECORD;
BEGIN
  FOR r IN
    SELECT h.id, h.tenant_id
    FROM research_usage_holds h
    LEFT JOIN research_jobs j ON j.id = h.job_id
    WHERE h.status = 'open'
      AND (
        (h.job_id IS NOT NULL AND (j.id IS NULL OR j.status IN ('succeeded','failed','canceled')))
        OR (h.job_id IS NULL AND h.created_at < now() - p_timeout)
      )
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || r.tenant_id::text));
    UPDATE research_usage_holds
      SET released = reserved - settled,
          status   = 'released'
      WHERE id = r.id AND status = 'open';
    IF FOUND THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION research_release_stale_holds(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_release_stale_holds(INTERVAL) TO service_role;
