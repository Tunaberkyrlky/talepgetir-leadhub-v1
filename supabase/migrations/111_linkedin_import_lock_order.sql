-- ==========================================
-- 111_linkedin_import_lock_order.sql
-- TG-LinkedIn P2 — (1) deadlock fix: unify the account->proxy lock order across all mutators, (2) C2:
-- refuse a re-import/reassign that would clear a LIVE send-lease out from under an in-flight send, and
-- (3) canonical current/target proxy advisory-lock order to remove a second deadlock between two
-- concurrent imports. CREATE OR REPLACE linkedin_import_and_assign_proxy re-run over its mig-109 body.
--
-- (1) Lock-order inversion (adversarial review, P3): the mig-109 definition locks the PROXY row first
-- (SELECT ... FROM linkedin_proxies ... FOR UPDATE) and only touches the account in a trailing UPDATE,
-- while linkedin_apply_proxy_health (mig 110) locks the ACCOUNT row first and then the proxy. When a
-- re-import of the same proxy races a hard classifier on the SAME account, the two acquire the rows in
-- opposite orders → a real A-B / B-A deadlock. Fix: lock the account row (tenant-scoped SELECT ...
-- FOR UPDATE) at the TOP, before any proxy-row locking, so every account+proxy mutator shares the
-- account->advisory->row order and can never deadlock.
--
-- (2) C2 (codex P1.2): import/reassign releases the account's current assignment (clearing its
-- lease_token/lease_expires_at). If a static send holds a LIVE send-lease (mig 109) on that
-- assignment, clearing it mid-flight reopens the exact gate<->network TOCTOU the lease closes. So —
-- mirroring linkedin_burn_proxy's live-lease REFUSAL — after the account lock we take the SAME
-- proxy-keyed advisory lock (account->advisory->row order) on the CURRENT assignment's proxy, re-read
-- lease_expires_at under it, and RETURN {ok:false,error:'lease_active'} if a live lease is held; the
-- operator simply retries once the short TTL lapses. The TARGET proxy row is likewise advisory-locked
-- before its FOR UPDATE, keeping every proxy touch in the same key+order. Every other check and
-- semantic is preserved byte-for-byte (this function is live-proven). Additive + re-runnable.
--
-- (3) Current<->target lock-order deadlock (post-mig-110 review): the mig-110 body above always took
-- the CURRENT-assignment proxy's advisory lock before the TARGET proxy's. Two concurrent imports that
-- swap proxies between two accounts — A: P1->P2 (current=P1, target=P2) racing B: P2->P1 (current=P2,
-- target=P1) — then acquire in opposite orders (A: P1 then P2; B: P2 then P1) and deadlock exactly like
-- (1). Fix: resolve BOTH the current-assignment proxy id and the target proxy id up front (plain reads,
-- no row lock yet — advisory locks don't require holding the row), then take the two
-- pg_advisory_xact_lock calls in ASCENDING uuid-text order. When both ids are the same proxy, only lock
-- once (a harmless no-op duplicate was previously tolerated but is now avoided outright); when there is
-- no current assignment, only the target is locked. The lease_active re-read/refusal (2) and the
-- target's advisory-lock-before-FOR-UPDATE (2) still happen exactly as before — only the ACQUISITION
-- ORDER of the two advisory locks changed, not what each protects.
-- ==========================================

CREATE OR REPLACE FUNCTION linkedin_import_and_assign_proxy(
  p_tenant        UUID,
  p_account       UUID,
  p_provider      TEXT,
  p_ext_id        TEXT,
  p_proxy_address TEXT,
  p_exit_ip       INET,
  p_host          TEXT,
  p_port          INTEGER,
  p_username_enc  TEXT,
  p_password_enc  TEXT,
  p_country       TEXT,
  p_plan_id       TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proxy     linkedin_proxies%ROWTYPE;
  v_prev      linkedin_proxies%ROWTYPE;
  v_bumped    BOOLEAN := FALSE;
  v_holder    UUID;
  v_cur_proxy UUID;          -- C2: the account's CURRENT active assignment's proxy
  v_cur_lease TIMESTAMPTZ;   -- C2: that assignment's lease_expires_at (re-read under the advisory lock)
  v_tgt_id    UUID;          -- C2: the target proxy row id (advisory-locked before its FOR UPDATE)
BEGIN
  -- (1) Change vs mig 109: lock the account row FIRST (was a plain existence PERFORM), before any
  -- proxy-row FOR UPDATE below, so this shares the account->advisory->proxy lock order with
  -- linkedin_apply_proxy_health (mig 110) and the two can never deadlock on a re-import racing a
  -- hard classifier for the same account.
  PERFORM 1 FROM linkedin_accounts WHERE id = p_account AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'account_not_found'); END IF;

  IF p_exit_ip IS NOT NULL AND EXISTS (SELECT 1 FROM linkedin_burned_exit_ips WHERE exit_ip = p_exit_ip) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'burned_ip');
  END IF;

  -- (2)+(3): resolve BOTH the current-assignment proxy id and the target proxy id up front (plain
  -- reads — an advisory lock does not require holding the row), then take the two
  -- pg_advisory_xact_lock calls in ASCENDING uuid-text order so two concurrent imports that swap
  -- proxies between accounts (A: P1->P2 racing B: P2->P1) can never acquire in opposite orders.
  SELECT proxy_id INTO v_cur_proxy FROM linkedin_proxy_assignments
    WHERE account_id = p_account AND tenant_id = p_tenant AND released_at IS NULL;
  SELECT id INTO v_tgt_id FROM linkedin_proxies WHERE provider = p_provider AND ext_id = p_ext_id;

  IF v_cur_proxy IS NOT NULL AND v_tgt_id IS NOT NULL AND v_cur_proxy <> v_tgt_id THEN
    IF v_cur_proxy::text < v_tgt_id::text THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(v_cur_proxy::text, 42));
      PERFORM pg_advisory_xact_lock(hashtextextended(v_tgt_id::text, 42));
    ELSE
      PERFORM pg_advisory_xact_lock(hashtextextended(v_tgt_id::text, 42));
      PERFORM pg_advisory_xact_lock(hashtextextended(v_cur_proxy::text, 42));
    END IF;
  ELSIF v_cur_proxy IS NOT NULL THEN
    -- Either no target row yet, or target == current (dedup: lock once).
    PERFORM pg_advisory_xact_lock(hashtextextended(v_cur_proxy::text, 42));
  ELSIF v_tgt_id IS NOT NULL THEN
    -- No current assignment: only the target needs the advisory lock.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_tgt_id::text, 42));
  END IF;

  -- (2) C2: refuse if the account's CURRENT active assignment carries a LIVE send-lease — clearing it
  -- on the reassign below would race an in-flight send. Re-read the lease UNDER the advisory lock taken
  -- above so a concurrent acquire can't slip a lease in after this check.
  IF v_cur_proxy IS NOT NULL THEN
    SELECT lease_expires_at INTO v_cur_lease FROM linkedin_proxy_assignments
      WHERE account_id = p_account AND tenant_id = p_tenant AND released_at IS NULL;
    IF v_cur_lease IS NOT NULL AND v_cur_lease > now() THEN
      RETURN jsonb_build_object('ok', false, 'error', 'lease_active', 'lease_expires_at', v_cur_lease);
    END IF;
  END IF;

  SELECT * INTO v_prev FROM linkedin_proxies
    WHERE provider = p_provider AND ext_id = p_ext_id FOR UPDATE;
  IF FOUND THEN
    IF v_prev.reputation_state = 'burned' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'proxy_burned');
    END IF;
    IF v_prev.owner_tenant_id IS NOT NULL AND v_prev.owner_tenant_id <> p_tenant THEN
      RETURN jsonb_build_object('ok', false, 'error', 'proxy_foreign_owner');
    END IF;
    SELECT account_id INTO v_holder FROM linkedin_proxy_assignments
      WHERE proxy_id = v_prev.id AND released_at IS NULL;
    IF v_holder IS NOT NULL AND v_holder <> p_account THEN
      RETURN jsonb_build_object('ok', false, 'error', 'proxy_in_use');
    END IF;
    v_bumped := (v_prev.host <> p_host OR v_prev.port <> p_port
                 OR v_prev.username_enc <> p_username_enc OR v_prev.password_enc <> p_password_enc
                 OR v_prev.exit_ip IS DISTINCT FROM p_exit_ip);
    UPDATE linkedin_proxies SET
      owner_tenant_id = COALESCE(owner_tenant_id, p_tenant),
      provider_plan_id = COALESCE(p_plan_id, provider_plan_id),
      proxy_address = p_proxy_address, exit_ip = p_exit_ip, host = p_host, port = p_port,
      username_enc = p_username_enc, password_enc = p_password_enc, country = lower(p_country),
      endpoint_generation = endpoint_generation + (CASE WHEN v_bumped THEN 1 ELSE 0 END),
      provider_health = 'healthy', updated_at = now()
    WHERE id = v_prev.id
    RETURNING * INTO v_proxy;
  ELSE
    INSERT INTO linkedin_proxies (
      owner_tenant_id, provider, provider_plan_id, ext_id, proxy_address, exit_ip,
      host, port, username_enc, password_enc, country, provider_health
    ) VALUES (
      p_tenant, p_provider, p_plan_id, p_ext_id, p_proxy_address, p_exit_ip,
      p_host, p_port, p_username_enc, p_password_enc, lower(p_country), 'healthy'
    ) RETURNING * INTO v_proxy;
  END IF;

  UPDATE linkedin_proxy_assignments SET released_at = now(),
      lease_token = NULL, lease_expires_at = NULL, lease_job_id = NULL
    WHERE account_id = p_account AND released_at IS NULL AND proxy_id <> v_proxy.id;
  INSERT INTO linkedin_proxy_assignments (account_id, proxy_id, tenant_id)
    VALUES (p_account, v_proxy.id, p_tenant)
  ON CONFLICT (account_id) DO UPDATE SET
    proxy_id = EXCLUDED.proxy_id, tenant_id = EXCLUDED.tenant_id, assigned_at = now(), released_at = NULL,
    lease_token = NULL, lease_expires_at = NULL, lease_job_id = NULL;

  UPDATE linkedin_accounts
    SET proxy_mode = 'static_required',
        last_validated_proxy_generation = NULL, last_validated_proxy_id = NULL
    WHERE id = p_account AND tenant_id = p_tenant;

  RETURN jsonb_build_object('ok', true, 'proxy_id', v_proxy.id,
                            'endpoint_generation', v_proxy.endpoint_generation, 'reassigned', v_bumped);
END;
$$;

-- ── Grants: service-role only (CREATE OR REPLACE keeps the grant; re-assert defensively) ──
REVOKE ALL ON FUNCTION linkedin_import_and_assign_proxy(UUID,UUID,TEXT,TEXT,TEXT,INET,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_import_and_assign_proxy(UUID,UUID,TEXT,TEXT,TEXT,INET,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT) TO service_role;
