-- ==========================================
-- TG-Research v2 — Verdict persistence hardening (codex A.3 re-review deferrals, pre-multi-worker)
-- ------------------------------------------------------------------------------
-- A.3 (cross-ICP re-score) shipped with three consciously-deferred findings. This closes them
-- BEFORE any multi-worker scale-out (single-worker maxAttempts=1 pilots never trip them):
--
--   (a) P0  insertVerdict was a mutable app-side UPSERT — not lease-fenced, not suppression-checked,
--           able to overwrite ANY existing verdict row. A concurrent/zombie attempt could clobber the
--           verdict a billable charge was based on (corrupting the billing evidence trail), and a firm
--           suppressed mid-run could still receive a fresh verdict (registry TOCTOU: the handler
--           pre-filters suppression at discovery time only). FIX: research_persist_verdict — a fenced,
--           atomic SECURITY DEFINER RPC. STRUCTURALLY requires (job, worker, lease) — there is no
--           unfenced verdict writer at all (the only writer is the harvest handler; 066's lesson:
--           enforce by shape, not convention). Under the shared per-tenant advisory lock it:
--             • row-LOCKS the job and requires status='running' under the exact lease (atomic fence,
--               FOR UPDATE — reap/reclaim serialize against the write, as 066 did for billing);
--             • refuses a suppressed company (registry + rollup flag, checked UNDER the lock —
--               suppression > dedup with no TOCTOU);
--             • NEVER overwrites a billed MATCH verdict: if the existing (tenant, company, icp,
--               ruleset) row is a 'match' and the company's canonical_key has a billable_event, the
--               existing row is returned untouched — the evidence a charge was billed from is
--               immutable. The caller must count/bill from the RETURNED row (the row of record).
--
--   (b) P1  unbilledMatchVerdicts (reconciliation) was a client-side anti-join: page-limited PostgREST
--           reads + a large .in() URL — a >1000-row tenant could silently HIDE an unbilled match
--           (lost revenue, the exact failure reconciliation exists to prevent). FIX:
--           research_unbilled_match_verdicts — one SQL anti-join, tenant-scoped, deterministic order,
--           bounded batch (the next run's reconciliation continues where this one stopped).
--
--   (c) P2  settle/release closed holds with NO fence — a zombie attempt could close (and free) the
--           reservation of a job it no longer owns. FIX: when the hold is job-attributed, closing it
--           requires proving the running lease on that job (FOR UPDATE, same fence as billing). A
--           jobless (manual/ops) hold stays fence-free. The stale-hold reaper is unchanged — it only
--           frees holds whose job is already terminal, which is exactly the case the fence rejects.
--
-- Signature changes drop the old forms (no unfenced overload left behind). Additive + re-runnable.
-- All SECURITY DEFINER, search_path pinned, service_role-only EXECUTE (user clients stay SELECT-only).
-- ==========================================


-- ============================================================================
-- (a) research_persist_verdict — fenced, atomic, clobber-safe verdict persistence
-- ----------------------------------------------------------------------------
-- Returns the verdict ROW OF RECORD for (tenant, company, icp, ruleset_version):
--   • normal path      → the freshly inserted/updated row (the caller's computed verdict);
--   • billed-match     → the PRESERVED existing 'match' row (immutable once a charge exists for the
--     guard               company's canonical_key) — callers must tally + bill from the returned row.
-- Refusals:
--   • lease lost                  → plain RAISE (hard error — the attempt is a zombie, abort the run);
--   • suppressed company          → check_violation with 'suppressed' in the message (expected skip,
--                                   the wrapper maps it to SuppressedError);
--   • invalid verdict/args        → plain RAISE (caller bug, fail loudly).
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
  -- STRUCTURAL fence requirement (066's lesson): the ONLY verdict writer is a running, leased job
  -- attempt. No default-NULL bypass — an unfenced caller is a bug, not a convention violation.
  IF p_job_id IS NULL OR p_worker IS NULL OR p_lease IS NULL THEN
    RAISE EXCEPTION 'research_persist_verdict: a verdict write requires (job, worker, lease) — unfenced writes are not allowed';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || p_tenant::text));

  -- ATOMIC LEASE FENCE (mirrors 066 billing): row-lock the job so reap/reclaim serialize against
  -- this write; require it to still be RUNNING under this exact (worker, lease).
  PERFORM 1 FROM research_jobs
    WHERE id = p_job_id AND tenant_id = p_tenant
      AND status = 'running' AND locked_by = p_worker AND lease = p_lease
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_persist_verdict: lease lost for job % (worker=%, fenced — not persisting)',
      p_job_id, p_worker;
  END IF;

  -- Resolve the company UNDER the lock (need its canonical_key for the suppression + billed guards).
  -- Row-lock it so a concurrent suppress/erase serializes against this write.
  SELECT canonical_key INTO v_canon
    FROM research_companies
    WHERE id = p_company_id AND tenant_id = p_tenant AND suppressed = false
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_persist_verdict: company % not found (or suppressed) for tenant %',
      p_company_id, p_tenant USING ERRCODE = 'check_violation', DETAIL = 'SUPPRESSED_OR_MISSING';
  END IF;

  -- Suppression registry is the durable KVKK guard (suppression > dedup) — checked UNDER the same
  -- lock research_suppress_company takes, so a mid-run suppression cannot race a verdict write.
  IF EXISTS (
    SELECT 1 FROM research_suppression
    WHERE tenant_id = p_tenant AND entity_type = 'company' AND identity_key = v_canon
  ) THEN
    RAISE EXCEPTION 'research_persist_verdict: company is suppressed (tenant=%, key=%)',
      p_tenant, v_canon USING ERRCODE = 'check_violation';
  END IF;

  -- BILLED-MATCH IMMUTABILITY: if the row of record is a 'match' AND this canonical_key has ever
  -- been billed, the verdict a charge was (or can be) settled from must not be rewritten — return
  -- it untouched. (An UNBILLED match may be overwritten freely: an idempotent re-run recomputes,
  -- and reconciliation bills from the latest row.)
  SELECT * INTO v_existing FROM research_company_verdicts
    WHERE tenant_id = p_tenant AND company_id = p_company_id
      AND icp_id = p_icp_id AND ruleset_version = p_ruleset_version
    FOR UPDATE;
  IF FOUND AND v_existing.verdict = 'match' AND EXISTS (
    SELECT 1 FROM research_billable_events
    WHERE tenant_id = p_tenant AND canonical_key = v_canon
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
-- (b) research_unbilled_match_verdicts — SQL reconciliation read (bounded anti-join)
-- ----------------------------------------------------------------------------
-- Current-ruleset MATCH verdicts for (tenant, icp) whose company canonical_key has NO billable
-- event — i.e. persisted-but-unbilled matches (crash gap / interrupted bill / credit floor).
-- One statement replaces the client-side three-query anti-join whose PostgREST row cap could
-- silently hide rows. Deterministic order + LIMIT keep each run's reconciliation bounded; a
-- remainder is picked up by the next run (verdicts persist). STABLE — a plain read; the billing
-- RPC re-checks everything under the lock anyway.
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
    AND NOT EXISTS (
      SELECT 1 FROM research_billable_events e
      WHERE e.tenant_id = v.tenant_id AND e.canonical_key = c.canonical_key
    )
  ORDER BY v.created_at ASC, v.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000);
$$;
REVOKE ALL ON FUNCTION research_unbilled_match_verdicts(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_unbilled_match_verdicts(UUID, UUID, INTEGER, INTEGER) TO service_role;


-- ============================================================================
-- (c) settle/release — lease-fenced hold closing (job-attributed holds only)
-- ----------------------------------------------------------------------------
-- A hold created for a job may only be CLOSED by the attempt that still holds that job's running
-- lease (same FOR UPDATE fence as billing/persist — atomic against reap/reclaim). This kills the
-- last zombie path: a reaped attempt could previously settle/release the reservation out from
-- under a live successor (which, via reserve's per-job idempotency, REUSES the same open hold).
-- A jobless hold (manual/ops/smoke) has no lease to prove and closes as before. The reaper RPC
-- (research_release_stale_holds) is deliberately NOT fenced — it frees only holds whose job is
-- already terminal, i.e. exactly the ones no running lease can vouch for.
-- Old 1-arg forms are DROPPED (no unfenced overload to reach for).
-- ============================================================================
DROP FUNCTION IF EXISTS research_settle_hold(UUID);
DROP FUNCTION IF EXISTS research_release_hold(UUID);

CREATE OR REPLACE FUNCTION research_settle_hold(
  p_hold_id UUID,
  p_job_id  UUID DEFAULT NULL,
  p_worker  TEXT DEFAULT NULL,
  p_lease   UUID DEFAULT NULL
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

  -- Fence: a job-attributed hold requires the closing caller to prove the running lease on THAT
  -- job. The caller-supplied job id must match the hold's own linkage (no closing hold A with a
  -- lease on job B).
  IF v_hold.job_id IS NOT NULL THEN
    IF p_job_id IS NULL OR p_worker IS NULL OR p_lease IS NULL THEN
      RAISE EXCEPTION 'research_settle_hold: hold % is job-attributed — closing it requires (job, worker, lease)', p_hold_id;
    END IF;
    IF p_job_id <> v_hold.job_id THEN
      RAISE EXCEPTION 'research_settle_hold: job % does not match hold %''s job %', p_job_id, p_hold_id, v_hold.job_id;
    END IF;
    PERFORM 1 FROM research_jobs
      WHERE id = v_hold.job_id AND tenant_id = v_tenant
        AND status = 'running' AND locked_by = p_worker AND lease = p_lease
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'research_settle_hold: lease lost for job % (worker=%, fenced — not settling)',
        v_hold.job_id, p_worker;
    END IF;
  END IF;

  UPDATE research_usage_holds
    SET released = v_hold.reserved - v_hold.settled,
        status   = 'settled'
    WHERE id = p_hold_id
    RETURNING * INTO v_hold;

  RETURN v_hold;
END;
$$;
REVOKE ALL ON FUNCTION research_settle_hold(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_settle_hold(UUID, UUID, TEXT, UUID) TO service_role;

CREATE OR REPLACE FUNCTION research_release_hold(
  p_hold_id UUID,
  p_job_id  UUID DEFAULT NULL,
  p_worker  TEXT DEFAULT NULL,
  p_lease   UUID DEFAULT NULL
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

  IF v_hold.job_id IS NOT NULL THEN
    IF p_job_id IS NULL OR p_worker IS NULL OR p_lease IS NULL THEN
      RAISE EXCEPTION 'research_release_hold: hold % is job-attributed — closing it requires (job, worker, lease)', p_hold_id;
    END IF;
    IF p_job_id <> v_hold.job_id THEN
      RAISE EXCEPTION 'research_release_hold: job % does not match hold %''s job %', p_job_id, p_hold_id, v_hold.job_id;
    END IF;
    PERFORM 1 FROM research_jobs
      WHERE id = v_hold.job_id AND tenant_id = v_tenant
        AND status = 'running' AND locked_by = p_worker AND lease = p_lease
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'research_release_hold: lease lost for job % (worker=%, fenced — not releasing)',
        v_hold.job_id, p_worker;
    END IF;
  END IF;

  UPDATE research_usage_holds
    SET released = v_hold.reserved - v_hold.settled,
        status   = 'released'
    WHERE id = p_hold_id
    RETURNING * INTO v_hold;

  RETURN v_hold;
END;
$$;
REVOKE ALL ON FUNCTION research_release_hold(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_release_hold(UUID, UUID, TEXT, UUID) TO service_role;
