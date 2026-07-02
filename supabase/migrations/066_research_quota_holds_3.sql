-- ==========================================
-- TG-Research v2 — Quota holds hardening, round 2 (codex VERIFICATION of 065)
-- ------------------------------------------------------------------------------
-- 065's hold-consumption + lease-fence were verified correct, but the verification pass found that
-- the enforcement was still bypassable and the fence non-atomic. This closes both:
--
--   P0  Fresh charges could bypass the hold. p_hold_id/p_worker/p_lease all default NULL, so a
--       hold-less research_bill_match(...) call (any future/admin/buggy caller) would bill a fresh
--       match with NO reservation consumption and NO fence — re-breaking "Σ open reserved ≤ balance".
--       FIX (structural, not by convention): a FRESH charge now REQUIRES a hold (p_hold_id NOT NULL),
--       and a job-attributed charge REQUIRES worker+lease. The only legitimate hold-less call is a
--       dedup (already billed — returns before the gate and consumes nothing).
--
--   P1  The lease fence was TOCTOU: it read research_jobs WITHOUT locking, so research_reap_stale_jobs
--       (a plain UPDATE that does NOT take the per-tenant advisory lock) or a reclaim could flip/seize
--       the job between the check and the COMMIT, letting a reaped attempt commit one charge. FIX: the
--       fence now SELECTs the job row FOR UPDATE, so reap/reclaim serialize against the charge — the
--       check-and-bill is atomic. (Lock order: advisory → verdict/company/icp → job → hold; reap/claim
--       touch only job rows and take no advisory lock, so no cycle is possible.)
--
--   P2  ReservationExhaustedError was distinguished by matching the English SQLERRM. FIX: the exhaustion
--       refusal now carries a structured DETAIL = 'RESERVATION_EXHAUSTED' (still check_violation), and
--       the TS wrapper keys off that stable marker instead of free-form message text.
--
-- Only research_bill_match changes (same 7-arg signature as 065 → CREATE OR REPLACE, no DROP).
-- reserve/settle/release/reaper/available are unchanged. Additive + re-runnable.
-- ==========================================

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

  -- (P1) ATOMIC LEASE FENCE. A charge attributed to a job MUST prove it still holds that job's running
  -- lease, and the proof must be atomic against reap/reclaim: row-LOCK the job (FOR UPDATE) so
  -- research_reap_stale_jobs / research_claim_job cannot flip or seize it between this check and the
  -- charge. A job-attributed bill with no worker+lease is rejected (no unfenced job billing). This also
  -- validates the job belongs to the tenant, so v_job can be set from the locked row.
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

  -- Bill once, ever.
  INSERT INTO research_billable_events
    (tenant_id, company_id, canonical_key, pricing_version, unit, amount_usd, job_id)
  VALUES
    (v_tenant, v_company, v_canon, p_pricing_version, 'match_lead', p_amount_usd, v_job)
  ON CONFLICT (tenant_id, canonical_key) DO NOTHING
  RETURNING * INTO v_event;

  IF NOT FOUND THEN
    -- Dedup: already billed once-ever. No new charge, no ledger decrement, no hold consumption.
    -- This is the ONLY legitimate hold-less outcome (returned before the fresh-charge gate below).
    SELECT * INTO v_event FROM research_billable_events
      WHERE tenant_id = v_tenant AND canonical_key = v_canon;
    RETURN v_event;
  END IF;

  -- (P0) A FRESH charge is STRUCTURALLY gated on a reservation hold — never billable by convention
  -- alone. Row-lock the hold and require open capacity. Exhaustion carries a structured DETAIL marker
  -- so the wrapper maps it to "stop the run" (vs the floor/ineligible refusals which mean "skip").
  -- RAISE here rolls back the event INSERT above (no orphan event, no hold consumption).
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

  -- (064) HARD FLOOR backstop: with correct hold accounting reserved ≤ available, so this is
  -- unreachable in normal operation — it only fires if the ledger somehow disagrees with the holds.
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
