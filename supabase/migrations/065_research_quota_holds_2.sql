-- ==========================================
-- TG-Research v2 — Quota holds hardening, round 1 (codex review of 064, FIX-FIRST)
-- ------------------------------------------------------------------------------
-- 064 added pre-run holds + a bill floor. The codex review (gpt-5.5 xhigh) found that the
-- reservation was only an admission GATE, not continuously enforced, plus a zombie-billing
-- race. This makes the hold the real, atomic enforcement point:
--
--   #1 (P0) Hold consumed only at final settle → mid-run Σ(open reserved) > balance, and
--           available_credits went transiently NEGATIVE. FIX: research_bill_match now CONSUMES
--           one unit of the hold (settled += 1) atomically with the ledger decrement, under the
--           same per-tenant advisory lock. So available_credits = balance − Σ(reserved−settled−
--           released) is invariant across the run (it stays at the post-reservation level until
--           the hold closes and frees the unused remainder). The bill REFUSES once the hold is
--           exhausted (settled = reserved) — the reservation cap is now enforced by the DB, not a
--           best-effort engine counter. (Also fixes the P1 dedup over-count and the P1 per-run
--           newly_billed drift: settled is the exact fresh-charge count for THIS run's hold.)
--
--   #2 (P0) A heartbeat-stale-but-still-running harvest could be reaped to 'failed', have its hold
--           released, then keep billing while another run reserves the same credits. FIX: a billed
--           charge is now LEASE-FENCED — when a (job, worker, lease) is supplied, the fresh charge
--           requires that job to still be 'running' under that exact lease (the 062 fencing token).
--           A reaped/reclaimed attempt is refused, so a zombie handler cannot bill after it has
--           been declared dead. The stale-hold reaper is then safe.
--
--   #5 (P1) research_release_stale_holds took blocking xact advisory locks in an unordered row
--           loop → two reapers could deadlock across tenants. FIX: pg_try_advisory_xact_lock
--           (skip a tenant currently busy; the next tick catches it) + deterministic ordering.
--
-- settle/release no longer take a count — the hold's `settled` is maintained by bill_match, so
-- they just close the hold and free the remainder (released = reserved − settled). Additive +
-- re-runnable; SECURITY DEFINER, search_path pinned, service_role-only EXECUTE. (reserve_hold and
-- available_credits from 064 are unchanged and intentionally not re-declared here.)
-- ==========================================


-- ============================================================================
-- research_bill_match — hold-aware (consume the reservation) + lease-fenced
-- Signature change (adds p_hold_id, p_worker, p_lease) → DROP the 064 4-arg form first.
-- ============================================================================
DROP FUNCTION IF EXISTS research_bill_match(UUID, TEXT, NUMERIC, UUID);

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

  -- (#2) LEASE FENCE: a billed charge attributed to a (job, worker, lease) requires that attempt to
  -- still hold the running lock. A reaped/reclaimed attempt (different or cleared lease, or no longer
  -- 'running') is refused — a zombie handler cannot bill after being declared dead. Plain RAISE
  -- (not check_violation) so the wrapper treats it as a hard error and aborts the run. Only enforced
  -- when all three are supplied (manual/reconciliation callers without a live lease skip the fence).
  IF p_job_id IS NOT NULL AND p_worker IS NOT NULL AND p_lease IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM research_jobs
      WHERE id = p_job_id AND tenant_id = v_tenant
        AND status = 'running' AND locked_by = p_worker AND lease = p_lease
    ) THEN
      RAISE EXCEPTION 'research_bill_match: lease lost for job % (worker=%, fenced — not billing)',
        p_job_id, p_worker;
    END IF;
  END IF;

  -- Tenant-validate the provenance job_id (drop it rather than store a cross-tenant ref).
  v_job := NULL;
  IF p_job_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM research_jobs WHERE id = p_job_id AND tenant_id = v_tenant
  ) THEN
    v_job := p_job_id;
  END IF;

  -- Bill once, ever.
  INSERT INTO research_billable_events
    (tenant_id, company_id, canonical_key, pricing_version, unit, amount_usd, job_id)
  VALUES
    (v_tenant, v_company, v_canon, p_pricing_version, 'match_lead', p_amount_usd, v_job)
  ON CONFLICT (tenant_id, canonical_key) DO NOTHING
  RETURNING * INTO v_event;

  IF NOT FOUND THEN
    -- Dedup: already billed once-ever. No new charge, no ledger decrement, and NO hold consumption
    -- (a dedup does not spend a credit, so it must not consume the reservation). Returned before the
    -- hold/floor checks.
    SELECT * INTO v_event FROM research_billable_events
      WHERE tenant_id = v_tenant AND canonical_key = v_canon;
    RETURN v_event;
  END IF;

  -- (#1) HOLD CONSUMPTION GATE: this is a FRESH charge. If a hold is supplied it must have remaining
  -- capacity; consuming it is what enforces the reservation cap. Row-lock the hold (also serialized
  -- by the advisory lock). A closed or exhausted hold REFUSES the charge with a recognizable
  -- 'reservation exhausted' message (check_violation) — the wrapper maps that to "stop the run"
  -- (distinct from the floor/ineligible refusals, which mean "skip this candidate"). RAISE rolls back
  -- the event INSERT above, so a refused charge leaves no orphan billable_event.
  IF p_hold_id IS NOT NULL THEN
    SELECT * INTO v_hold FROM research_usage_holds
      WHERE id = p_hold_id AND tenant_id = v_tenant
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'research_bill_match: hold % not found for tenant %', p_hold_id, v_tenant;
    END IF;
    IF v_hold.status <> 'open' OR (v_hold.reserved - v_hold.settled) <= 0 THEN
      RAISE EXCEPTION
        'research_bill_match: reservation exhausted (hold=%, reserved=%, settled=%, status=%)',
        p_hold_id, v_hold.reserved, v_hold.settled, v_hold.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- (064) HARD FLOOR: a fresh charge may not drive the balance negative (last-resort backstop;
  -- with correct hold accounting reserved ≤ available so this should not trip). RAISE rolls back the
  -- event. check_violation, but WITHOUT the 'reservation exhausted' token → wrapper treats it as a
  -- per-candidate ineligibility (skip), and the match awaits a top-up via reconciliation.
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
  IF p_hold_id IS NOT NULL THEN
    UPDATE research_usage_holds SET settled = settled + 1 WHERE id = p_hold_id;
  END IF;

  UPDATE research_billable_events SET ledger_id = v_ledger
    WHERE id = v_event.id
    RETURNING * INTO v_event;

  RETURN v_event;
END;
$$;
REVOKE ALL ON FUNCTION research_bill_match(UUID, TEXT, NUMERIC, UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_bill_match(UUID, TEXT, NUMERIC, UUID, UUID, TEXT, UUID) TO service_role;


-- ============================================================================
-- research_settle_hold(hold) — close a hold normally; free the unused remainder
-- The realized count lives in `settled` (maintained by research_bill_match). Drop the 064 2-arg
-- form (it took an external count) and replace with a 1-arg finalizer. Idempotent.
-- ============================================================================
DROP FUNCTION IF EXISTS research_settle_hold(UUID, INTEGER);

CREATE OR REPLACE FUNCTION research_settle_hold(
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
    RAISE EXCEPTION 'research_settle_hold: hold % not found', p_hold_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || v_tenant::text));

  SELECT * INTO v_hold FROM research_usage_holds WHERE id = p_hold_id FOR UPDATE;
  IF v_hold.status <> 'open' THEN
    RETURN v_hold; -- idempotent: already settled/released
  END IF;

  UPDATE research_usage_holds
    SET released = v_hold.reserved - v_hold.settled,
        status   = 'settled'
    WHERE id = p_hold_id
    RETURNING * INTO v_hold;

  RETURN v_hold;
END;
$$;
REVOKE ALL ON FUNCTION research_settle_hold(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_settle_hold(UUID) TO service_role;


-- ============================================================================
-- research_release_stale_holds — deadlock-free reaper (#5)
-- pg_try_advisory_xact_lock so a tenant currently busy (an active reserve/bill) is SKIPPED rather
-- than blocked on — the next reaper tick frees it. Deterministic ordering for good measure. The
-- per-charge lease fence (#2) means a zombie handler can no longer bill once reaped, so releasing
-- its hold here is safe.
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
    ORDER BY h.tenant_id, h.id
  LOOP
    -- Skip a tenant whose lock is held right now (active reserve/bill/settle) — no blocking, no
    -- cross-tenant deadlock between concurrent reapers. The hold is picked up next tick.
    IF pg_try_advisory_xact_lock(hashtext('research_bill:' || r.tenant_id::text)) THEN
      UPDATE research_usage_holds
        SET released = reserved - settled,
            status   = 'released'
        WHERE id = r.id AND status = 'open';
      IF FOUND THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION research_release_stale_holds(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_release_stale_holds(INTERVAL) TO service_role;
