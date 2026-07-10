-- ==========================================
-- 112_linkedin_session_epoch.sql
-- TG-LinkedIn — session epoch (closes the documented "stale-401 vs fresh-reauth" residual, see
-- applyWriteHealth's KNOWN RESIDUAL comment in server/src/lib/linkedin/actions.ts).
--
-- THE RESIDUAL: an in-flight job loads epoch-N cookies; the operator re-auths (capture writes fresh
-- li_at_enc/jsessionid_enc); the in-flight job's 401 — produced by the OLD cookies — then flips the
-- freshly-valid account to NEEDS_REAUTH and cancels its queued jobs, killing a good session. The fix
-- is a monotonically-increasing session_epoch bumped on every cookie write: a NEEDS_REAUTH transition
-- carries the epoch its creds came from, and the DB refuses the transition if the account's epoch has
-- since advanced (a re-auth landed).
--
-- WHY EPOCH GATES *ONLY* NEEDS_REAUTH: a 401 is a COOKIE-level signal (this session's creds are dead),
-- so it is meaningfully "stale" once the cookies were replaced. RESTRICTED (403) and CHALLENGED (999)
-- are ACCOUNT-level signals (LinkedIn flagged the member/IP, not the cookie) — a fresh re-auth does NOT
-- clear them, so they must apply regardless of epoch. This split lives in the RPC below (p_expected_epoch
-- is consulted ONLY when p_target_status = 'NEEDS_REAUTH').
--
-- Two changes:
--   1. linkedin_accounts.session_epoch INTEGER NOT NULL DEFAULT 1 (existing rows start at epoch 1).
--   2. linkedin_apply_proxy_health(): new trailing param p_expected_epoch INTEGER DEFAULT NULL. When
--      p_target_status='NEEDS_REAUTH' AND p_expected_epoch IS NOT NULL AND account.session_epoch <>
--      p_expected_epoch → skip the ENTIRE transition (no status change, no job cancel, no proxy touch)
--      and return {ok:true, changed:false, epoch_stale:true}. Signature change → DROP the old 5-arg
--      def, re-assert REVOKE/GRANT on the 6-arg one. Body is copied byte-for-byte from mig 110 with
--      ONLY the epoch read + the epoch-stale guard added.
--   3. linkedin_capture_reauth(): the atomic cookie re-write for an EXISTING account — folds the
--      status-preservation read the capture route used to do in TS into ONE txn that also bumps
--      session_epoch = session_epoch + 1, so the bump can never race a concurrent read-then-write.
--
-- Atomic mutations go through SECURITY DEFINER RPCs (Supabase can't hold BEGIN/COMMIT across client
-- calls). Deny-all RLS; service-role only. Additive + re-runnable.
-- ==========================================

-- ── (1) The epoch column: every account starts at 1; each cookie write bumps it. ──
ALTER TABLE linkedin_accounts
  ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 1;

-- ── (2) RPC: apply a health transition + (static) proxy lifecycle, atomically ─────
-- Copied from mig 110's linkedin_apply_proxy_health. The ONLY additions vs mig 110 are:
--   * p_expected_epoch INTEGER DEFAULT NULL (6th param),
--   * reading session_epoch into v_epoch under the account lock, and
--   * the epoch-stale guard (NEEDS_REAUTH only) that skips the whole transition.
-- Everything else — the PAUSED guard, idempotency, queue-cancel, and the C1 static-proxy lifecycle
-- with the p_expected_proxy fence — is preserved verbatim.
CREATE OR REPLACE FUNCTION linkedin_apply_proxy_health(
  p_tenant         UUID,
  p_account        UUID,
  p_target_status  TEXT,
  p_classifier     TEXT DEFAULT NULL,
  p_expected_proxy UUID DEFAULT NULL,
  p_expected_epoch INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status    TEXT;
  v_mode      TEXT;
  v_epoch     INTEGER;
  v_changed   BOOLEAN := FALSE;
  v_proxy_id  UUID;
  v_lease     TIMESTAMPTZ;
  v_repu      TEXT;
  v_new_gen   INTEGER;
  v_retired   BOOLEAN := FALSE;
  v_lease_live BOOLEAN := FALSE;
  v_quarant   BOOLEAN := FALSE;
  v_canceled  INTEGER := 0;
  v_skipped   TEXT := NULL;   -- C1: set to 'assignment_changed' when the fence skips the lifecycle
BEGIN
  IF p_target_status IS NULL OR p_target_status NOT IN ('RESTRICTED','CHALLENGED','NEEDS_REAUTH') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_target_status');
  END IF;

  -- Lock the account row, tenant-scoped. Missing/foreign → reject (no cross-tenant health apply).
  SELECT status, proxy_mode, session_epoch INTO v_status, v_mode, v_epoch
    FROM linkedin_accounts WHERE id = p_account AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_not_found');
  END IF;

  -- Never lift an operator PAUSE (mirrors applyWriteHealth's PAUSE guard).
  IF v_status = 'PAUSED' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'PAUSED', 'changed', false, 'paused_not_overridden', true);
  END IF;

  -- Idempotent: already in the target state → no status change AND no re-retire/re-bump.
  IF v_status = p_target_status THEN
    RETURN jsonb_build_object('ok', true, 'status', v_status, 'changed', false, 'idempotent', true);
  END IF;

  -- Session-epoch guard (mig 112): a NEEDS_REAUTH transition is a COOKIE-level signal that carries the
  -- epoch its creds came from (applyWriteHealth passes account.session_epoch). If the account's epoch
  -- has since advanced, a re-auth landed and this 401 was produced by now-superseded cookies → skip the
  -- ENTIRE transition (no status change, no job cancel, no proxy touch). RESTRICTED/CHALLENGED are
  -- account-level (not cookie-level) and are NEVER epoch-gated. NULL p_expected_epoch = no guard
  -- (back-compat / non-cookie callers).
  IF p_target_status = 'NEEDS_REAUTH' AND p_expected_epoch IS NOT NULL AND v_epoch <> p_expected_epoch THEN
    RETURN jsonb_build_object('ok', true, 'status', v_status, 'changed', false,
                              'epoch_stale', true, 'session_epoch', v_epoch);
  END IF;

  -- Apply the transition (the AND status <> 'PAUSED' keeps a concurrent PAUSE winning).
  UPDATE linkedin_accounts SET status = p_target_status
    WHERE id = p_account AND tenant_id = p_tenant AND status <> 'PAUSED';
  IF NOT FOUND THEN
    -- A PAUSE landed between our lock read and here (shouldn't under the row lock, but fail-safe).
    RETURN jsonb_build_object('ok', true, 'status', 'PAUSED', 'changed', false, 'paused_not_overridden', true);
  END IF;
  v_changed := TRUE;

  -- Auto-pause queue drain: cancel this account's still-QUEUED linkedin:* jobs (same set as
  -- cancelPendingAccountJobs). Fires for every hard state (incl. NEEDS_REAUTH).
  UPDATE research_jobs
    SET status = 'canceled', finished_at = now(),
        error = left('auto-paused: health:' || COALESCE(p_classifier, p_target_status), 2000)
    WHERE tenant_id = p_tenant AND status = 'queued' AND type LIKE 'linkedin:%'
      AND payload->>'account_id' = p_account::text;
  GET DIAGNOSTICS v_canceled = ROW_COUNT;

  -- Proxy lifecycle ONLY for a static_required account entering a hard RESTRICT state. NEEDS_REAUTH
  -- is a cookie/session failure, not an IP failure → the proxy is left untouched (P1.16 split).
  IF p_target_status IN ('RESTRICTED','CHALLENGED') AND v_mode = 'static_required' THEN
    SELECT proxy_id INTO v_proxy_id FROM linkedin_proxy_assignments
      WHERE account_id = p_account AND tenant_id = p_tenant AND released_at IS NULL;
    -- C1 fence: if the caller pinned an expected proxy and the CURRENT assignment has moved off it,
    -- this classifier is stale for the new proxy → skip the whole lifecycle (status + cancel already
    -- landed above). NULL p_expected_proxy = no fence (back-compat).
    IF p_expected_proxy IS NOT NULL AND v_proxy_id IS DISTINCT FROM p_expected_proxy THEN
      v_skipped := 'assignment_changed';
    ELSIF v_proxy_id IS NOT NULL THEN
      -- SAME advisory key + SAME order (lock, THEN proxy FOR UPDATE) as linkedin_burn_proxy /
      -- linkedin_acquire_send_lease, so a concurrent burn/acquire on this proxy can't interleave.
      PERFORM pg_advisory_xact_lock(hashtextextended(v_proxy_id::text, 42));
      SELECT reputation_state INTO v_repu FROM linkedin_proxies WHERE id = v_proxy_id FOR UPDATE;

      -- Re-read the assignment's lease under the lock, for OBSERVABILITY only (lease_was_live).
      -- Unlike a permanent burn (linkedin_burn_proxy stays deferral-based), the health retire runs
      -- UNCONDITIONALLY — even under a live send-lease. The account is already entering a hard state
      -- so no NEW send starts; retiring the DB row does not touch the in-flight socket; and the lease
      -- holder's token-matched release (linkedin_release_send_lease) then no-ops harmlessly on the
      -- already-released assignment. Deferring instead left the proxy clean+assigned forever (the
      -- idempotency guard + TS early-return blocked every re-apply), so a later successful re-validate
      -- could resume sends on the flagged IP — the exact hole this fix closes.
      SELECT lease_expires_at INTO v_lease FROM linkedin_proxy_assignments
        WHERE account_id = p_account AND tenant_id = p_tenant AND released_at IS NULL;
      v_lease_live := (v_lease IS NOT NULL AND v_lease > now());

      UPDATE linkedin_proxy_assignments
        SET released_at = now(), lease_token = NULL, lease_expires_at = NULL, lease_job_id = NULL
        WHERE account_id = p_account AND tenant_id = p_tenant AND released_at IS NULL;
      UPDATE linkedin_proxies
        SET endpoint_generation = endpoint_generation + 1,
            -- quarantine (recoverable) — NOT burned. A burned proxy stays burned.
            reputation_state = CASE WHEN reputation_state = 'burned' THEN 'burned' ELSE 'quarantined' END,
            updated_at = now()
        WHERE id = v_proxy_id
        RETURNING endpoint_generation, reputation_state INTO v_new_gen, v_repu;
      -- Clear the account's validated pointers so no stale send-gate can open on the old IP.
      UPDATE linkedin_accounts
        SET last_validated_proxy_generation = NULL, last_validated_proxy_id = NULL
        WHERE id = p_account AND tenant_id = p_tenant;
      v_retired := TRUE;
      v_quarant := (v_repu = 'quarantined');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'status', p_target_status, 'changed', v_changed,
    'jobs_canceled', v_canceled,
    'proxy_id', v_proxy_id,
    'proxy_retired', v_retired, 'quarantined', v_quarant,
    'proxy_skipped', v_skipped,   -- C1: 'assignment_changed' when the fence skipped the lifecycle
    'lease_was_live', v_lease_live,
    'new_generation', v_new_gen
  );
END;
$$;

-- ── (3) RPC: atomic cookie re-write for an EXISTING account (capture re-auth path) ──
-- The capture route used to (a) read the account's current status in TS, (b) compute the preserved
-- next status, (c) plain-UPDATE the cookies + status. That read→write pair can't atomically bump the
-- epoch (session_epoch = <loaded>+1 is racy). This RPC folds all three into ONE txn under the account
-- row lock and bumps session_epoch = session_epoch + 1 in the SAME UPDATE that writes the new cookies.
--
-- Status preservation (unchanged from the TS): a bare cookie re-upload optimistically clears a soft
-- NEEDS_REAUTH (and a benign ACTIVE stays ACTIVE), but must NEVER lift a hard RESTRICTED/CHALLENGED/
-- PAUSED — the validate the capture route enqueues re-classifies those. Missing account → account_not_found
-- (the route maps it to 404). The epoch is bumped for EVERY successful cookie write (even when the
-- status is preserved) — the whole point is that any fresh-cookie write invalidates in-flight 401s.
CREATE OR REPLACE FUNCTION linkedin_capture_reauth(
  p_tenant          UUID,
  p_account         UUID,
  p_li_at_enc       TEXT,
  p_jsessionid_enc  TEXT,
  p_user_agent      TEXT,
  p_geo             TEXT DEFAULT NULL,
  p_timezone        TEXT DEFAULT NULL,
  p_accept_language TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_next   TEXT;
  v_epoch  INTEGER;
BEGIN
  SELECT status INTO v_status
    FROM linkedin_accounts WHERE id = p_account AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_not_found');
  END IF;

  v_next := CASE WHEN v_status IN ('NEEDS_REAUTH','ACTIVE') THEN 'ACTIVE' ELSE v_status END;

  UPDATE linkedin_accounts SET
      li_at_enc       = p_li_at_enc,
      jsessionid_enc  = p_jsessionid_enc,
      user_agent      = p_user_agent,
      geo             = p_geo,
      timezone        = p_timezone,
      accept_language = p_accept_language,
      status          = v_next,
      session_epoch   = session_epoch + 1
    WHERE id = p_account AND tenant_id = p_tenant
    RETURNING session_epoch INTO v_epoch;

  RETURN jsonb_build_object('ok', true, 'account_id', p_account, 'status', v_next, 'session_epoch', v_epoch);
END;
$$;

-- ── Grants: service-role only (no anon/authenticated execute) ─────────────────────
-- The epoch param changed linkedin_apply_proxy_health's signature (5-arg → 6-arg). CREATE OR REPLACE
-- cannot change a signature, so DROP the old 5-arg definition (idempotent) — otherwise both overloads
-- would linger and an unqualified call could bind the wrong one. Re-runnable: DROP IF EXISTS no-ops
-- once dropped.
DROP FUNCTION IF EXISTS linkedin_apply_proxy_health(UUID,UUID,TEXT,TEXT,UUID);
REVOKE ALL ON FUNCTION linkedin_apply_proxy_health(UUID,UUID,TEXT,TEXT,UUID,INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_apply_proxy_health(UUID,UUID,TEXT,TEXT,UUID,INTEGER) TO service_role;

REVOKE ALL ON FUNCTION linkedin_capture_reauth(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_capture_reauth(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO service_role;
