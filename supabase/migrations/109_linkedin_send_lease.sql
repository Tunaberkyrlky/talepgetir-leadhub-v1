-- ==========================================
-- 109_linkedin_send_lease.sql
-- TG-LinkedIn — assignment-scoped send-lease closing the gate<->network TOCTOU.
-- Design: Tg-LinkedIn/04_STATIC_PROXY_POOL.md §9 (P1.4, "P0 KABUL SINIRI") + §10 row P1.4.
--
-- P0 (mig 106/107) accepted a known gap: `resolveDispatcher` (server/src/lib/linkedin/actions.ts)
-- re-reads proxy_mode + the validated (proxy_id, generation) pointers fresh from the DB and
-- decides a static send may proceed — but between THAT check and the actual outbound LinkedIn
-- HTTP request, a concurrent burn/health-apply/replacement could retire or re-point the
-- assignment. The send then tunnels through an IP the caller believed was validated but which
-- was just pulled. The design doc's own accepted-limit text: "full çözüm = assignment-scoped
-- send-lease/advisory-lock (P1 follow-up). Generation-gate pencereyi daraltır."
--
-- This migration closes that window with a short-TTL lease row + a proxy-row advisory lock
-- shared with the one retire path this module has today (`linkedin_burn_proxy`, mig 106):
--
--   * linkedin_acquire_send_lease(tenant, account, job_id?, ttl_seconds?) — SECURITY DEFINER,
--     ONE RPC (Supabase can't hold BEGIN/COMMIT across client calls, so every check + the mutate
--     must happen inside a single PL/pgSQL function, exactly like linkedin_try_consume_quota and
--     linkedin_stamp_validated_proxy). Re-derives proxy_mode + validated pointers FRESH (never
--     trusts a caller snapshot — same discipline as resolveDispatcher's P1.2 fix), re-verifies
--     the assignment is still active + unchanged, the proxy is clean+healthy+non-burned, and the
--     validated (proxy_id, generation) still matches the CURRENT assignment (the same P1.3 ABA
--     guard resolveDispatcher enforces). Only on ALL of that passing does it write a lease_token
--     + lease_expires_at onto the assignment row and return a host/port/generation/assignment_id
--     projection. Credentials are NEVER touched by this RPC (no decrypt, nothing username/
--     password-shaped in the return) — the sender already has its own decrypted dispatcher from
--     resolveDispatcher; this RPC is purely the atomic last-instant gate + lease.
--
--   * linkedin_release_send_lease(tenant, account, lease_token) — best-effort early release
--     (token-matched, so a late/duplicate release can never clobber a NEWER lease). If the
--     caller never releases (crash, timeout), the lease simply self-expires — no cleanup job
--     needed.
--
--   * linkedin_burn_proxy (mig 106) is ALTERED to participate: it takes the SAME proxy-keyed
--     advisory lock, in the SAME relative order (lock, then the proxy row's FOR UPDATE) as
--     acquire, so the two can never interleave on one proxy. And it now checks for a LIVE
--     (non-expired) lease on the proxy's active assignment: if one is held, burn REFUSES to
--     mutate (`{ok:false,error:'lease_active'}`) instead of racing an in-flight send — the
--     caller (operator / a scheduled retry) simply calls again once the short lease TTL lapses.
--
-- HONEST BOUNDARY (read before assuming this is airtight): Supabase RPCs are each ONE
-- transaction that commits when the function returns — there is no live DB transaction/
-- connection held open for the duration of the subsequent outbound LinkedIn HTTP request (that
-- would mean holding a Postgres row lock across slow external I/O, which this codebase
-- deliberately avoids everywhere else too). So the advisory lock/row lock only guarantees
-- ACQUIRE and BURN can never interleave AT THE INSTANT either one runs; it is the lease ROW
-- (lease_expires_at) — checked by burn — that gives the durable guarantee across the send
-- itself: a burn cannot succeed while a lease is live, full stop, for up to the lease TTL. The
-- residual risk is bounded to "acquire granted a lease, but the send exceeds the TTL and the
-- lease lapses before release" (mitigated: TTL default 45s is comfortably above client.ts's
-- own 30s TOTAL_DEADLINE_MS hard wall-clock cap) — an expired lease does not un-send anything;
-- it only means a burn requested AFTER the TTL lapses is no longer held back by this send.
-- Additive + re-runnable.
-- ==========================================

-- ── Lease columns on the (already 1:1) assignment row ────────────────────────────
ALTER TABLE linkedin_proxy_assignments
  ADD COLUMN IF NOT EXISTS lease_token      UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_job_id     TEXT;

-- ── RPC: acquire an assignment-scoped send-lease (atomic last-instant re-check) ───
CREATE OR REPLACE FUNCTION linkedin_acquire_send_lease(
  p_tenant      UUID,
  p_account     UUID,
  p_job_id      TEXT DEFAULT NULL,
  p_ttl_seconds INTEGER DEFAULT 45
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mode      TEXT;
  v_val_proxy UUID;
  v_val_gen   INTEGER;
  v_proxy_id  UUID;
  v_proxy     linkedin_proxies%ROWTYPE;
  v_cur_proxy UUID;
  v_released  TIMESTAMPTZ;
  v_live_lease TIMESTAMPTZ;
  v_token     UUID := gen_random_uuid();
  v_ttl       INTEGER := LEAST(GREATEST(COALESCE(p_ttl_seconds, 45), 5), 120);
  v_expires   TIMESTAMPTZ;
BEGIN
  -- Re-derive proxy_mode + validated pointers FRESH from the account row — never a caller
  -- snapshot (mirrors resolveDispatcher's P1.2 discipline). A legacy_rotating account needs no
  -- lease at all (the caller shouldn't even call this for one; fail-closed here too regardless).
  SELECT proxy_mode, last_validated_proxy_id, last_validated_proxy_generation
    INTO v_mode, v_val_proxy, v_val_gen
    FROM linkedin_accounts WHERE id = p_account AND tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'account_gone'); END IF;
  IF v_mode <> 'static_required' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_static_required');
  END IF;

  -- Unlocked read just to learn WHICH proxy row to lock next; re-verified below once the lock
  -- (+ FOR UPDATE) is held, so a reassignment racing this lookup can't slip through.
  SELECT proxy_id INTO v_proxy_id FROM linkedin_proxy_assignments
    WHERE account_id = p_account AND tenant_id = p_tenant AND released_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'no_static_proxy'); END IF;

  -- Advisory xact lock keyed on the PROXY id — the SAME key + SAME relative order (lock, THEN
  -- the proxy row's FOR UPDATE) that linkedin_burn_proxy takes below, so an acquire and a
  -- concurrent burn of this exact proxy can never interleave: whichever reaches the lock first
  -- runs its whole check+mutate before the other proceeds. Only held for THIS function's own
  -- single-RPC transaction (see file header) — it does not span the network send that follows.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_proxy_id::text, 42));

  SELECT * INTO v_proxy FROM linkedin_proxies WHERE id = v_proxy_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'no_static_proxy'); END IF;

  -- Re-check the assignment is STILL bound to this exact proxy and still active (a reassignment
  -- could have raced the unlocked lookup above and the lock acquisition).
  SELECT proxy_id, released_at, lease_expires_at INTO v_cur_proxy, v_released, v_live_lease
    FROM linkedin_proxy_assignments
    WHERE account_id = p_account AND tenant_id = p_tenant;
  IF v_cur_proxy IS DISTINCT FROM v_proxy_id OR v_released IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_static_proxy');
  END IF;

  -- A LIVE (non-expired) lease means ANOTHER send for this account is already mid-flight through
  -- this proxy. Overwriting its token here would let a burn that lands AFTER this second send
  -- releases retire the proxy while the FIRST send is still in flight — reopening the exact
  -- gate<->network TOCTOU this migration closes (codex P1). Refuse the concurrent acquire; the
  -- caller SKIPs fail-closed (sends for one account are paced/serialized, so this is rare and
  -- self-clears within the short TTL). An expired lease is NOT live and is freely overwritten.
  IF v_live_lease IS NOT NULL AND v_live_lease > now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lease_held', 'lease_expires_at', v_live_lease);
  END IF;

  IF v_proxy.reputation_state <> 'clean' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'proxy_unhealthy', 'reputation_state', v_proxy.reputation_state);
  END IF;
  IF v_proxy.provider_health <> 'healthy' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'proxy_unhealthy', 'provider_health', v_proxy.provider_health);
  END IF;
  IF v_proxy.exit_ip IS NOT NULL AND EXISTS (SELECT 1 FROM linkedin_burned_exit_ips WHERE exit_ip = v_proxy.exit_ip) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exit_ip_burned');
  END IF;
  -- validate == send same IP (P1.3 ABA guard) — the account's CAS-stamped validated pointers
  -- must match this exact (proxy_id, generation), same comparison resolveDispatcher makes.
  IF v_val_proxy IS DISTINCT FROM v_proxy.id OR v_val_gen IS DISTINCT FROM v_proxy.endpoint_generation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'proxy_revalidation_required');
  END IF;

  v_expires := now() + make_interval(secs => v_ttl);
  UPDATE linkedin_proxy_assignments
    SET lease_token = v_token, lease_expires_at = v_expires, lease_job_id = p_job_id
    WHERE account_id = p_account AND tenant_id = p_tenant AND released_at IS NULL;

  -- Decrypted-NOTHING projection: host/port/generation/assignment_id only. Never credentials —
  -- the sender's dispatcher was already built (with creds) by resolveDispatcher; this RPC is
  -- purely the atomic last-instant gate + lease, not a second credential path.
  RETURN jsonb_build_object(
    'ok', true, 'lease_token', v_token, 'assignment_id', p_account,
    'proxy_id', v_proxy.id, 'generation', v_proxy.endpoint_generation,
    'host', v_proxy.host, 'port', v_proxy.port, 'expires_at', v_expires
  );
END;
$$;

-- ── RPC: release a held lease early (token-matched, so a stale/late release can't clobber a
-- newer lease granted after this one lapsed) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION linkedin_release_send_lease(
  p_tenant      UUID,
  p_account     UUID,
  p_lease_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n INTEGER;
BEGIN
  UPDATE linkedin_proxy_assignments
    SET lease_token = NULL, lease_expires_at = NULL, lease_job_id = NULL
    WHERE account_id = p_account AND tenant_id = p_tenant AND lease_token = p_lease_token;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_n > 0);
END;
$$;

-- ── linkedin_burn_proxy v2 (mig 106): advisory-lock + lease-aware ─────────────────
-- Same signature as 106 (CREATE OR REPLACE keeps the existing service_role grant, but the
-- REVOKE/GRANT below re-asserts it defensively, matching mig 107's practice for redefined fns).
CREATE OR REPLACE FUNCTION linkedin_burn_proxy(
  p_tenant  UUID,
  p_proxy   UUID,
  p_reason  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exit          INET;
  v_acct          UUID;
  v_lease_expires TIMESTAMPTZ;
BEGIN
  -- Same key + same relative order (lock, THEN FOR UPDATE) as linkedin_acquire_send_lease, so
  -- the two can never interleave on this proxy (closes P1.4: gate<->network send-lease).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_proxy::text, 42));

  SELECT exit_ip INTO v_exit FROM linkedin_proxies
    WHERE id = p_proxy AND (owner_tenant_id = p_tenant OR owner_tenant_id IS NULL) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'proxy_not_found');
  END IF;

  SELECT account_id, lease_expires_at INTO v_acct, v_lease_expires FROM linkedin_proxy_assignments
    WHERE proxy_id = p_proxy AND released_at IS NULL;

  -- A LIVE send-lease means a sender is (or was, moments ago) mid-flight through this exact IP.
  -- Burning it out from under that request would silently retire the assignment the send still
  -- believes is good. Defer instead of racing it: the lease TTL is short (<=120s, default 45s)
  -- and self-expires, so the caller (operator action / a scheduled retry) just calls again
  -- shortly — this is the "burn conflicts with a held lease" half of the fix.
  IF v_lease_expires IS NOT NULL AND v_lease_expires > now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lease_active', 'account_id', v_acct, 'lease_expires_at', v_lease_expires);
  END IF;

  UPDATE linkedin_proxies
    SET reputation_state = 'burned', endpoint_generation = endpoint_generation + 1, updated_at = now()
    WHERE id = p_proxy;
  UPDATE linkedin_proxy_assignments
    SET released_at = now(), lease_token = NULL, lease_expires_at = NULL, lease_job_id = NULL
    WHERE proxy_id = p_proxy AND released_at IS NULL;
  IF v_exit IS NOT NULL THEN
    INSERT INTO linkedin_burned_exit_ips (exit_ip, reason, source_account_id)
      VALUES (v_exit, p_reason, v_acct)
    ON CONFLICT (exit_ip) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', true, 'burned_exit_ip', v_exit, 'account_id', v_acct);
END;
$$;

-- ── Every OTHER function that reassigns/releases the assignment row must clear the lease ──
-- The lease columns live ON the (account_id-PK) assignment row, which is REUSED across
-- reassignments. Any path that rebinds an account to a different proxy — or releases its
-- assignment — must NULL the lease, or a stale lease_expires_at inherited from the OLD proxy
-- would make the next linkedin_acquire_send_lease on the NEW proxy wrongly return 'lease_held'
-- and block real sends for up to the old TTL (adversarial-review regression of this migration).
-- burn already clears it (above); here we make the two reassign RPCs lease-aware too. These MUST
-- be redefined in THIS migration (not 107/108) because the lease columns don't exist until now.

-- linkedin_import_and_assign_proxy v2 (mig 107): identical body + lease-clear on release/reassign.
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
  v_proxy   linkedin_proxies%ROWTYPE;
  v_prev    linkedin_proxies%ROWTYPE;
  v_bumped  BOOLEAN := FALSE;
  v_holder  UUID;
BEGIN
  PERFORM 1 FROM linkedin_accounts WHERE id = p_account AND tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'account_not_found'); END IF;

  IF p_exit_ip IS NOT NULL AND EXISTS (SELECT 1 FROM linkedin_burned_exit_ips WHERE exit_ip = p_exit_ip) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'burned_ip');
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

-- linkedin_claim_proxy v2 (mig 108): identical body + lease-clear on release/reassign.
CREATE OR REPLACE FUNCTION linkedin_claim_proxy(
  p_tenant  UUID,
  p_account UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_geo      TEXT;
  v_country  TEXT;
  v_proxy    linkedin_proxies%ROWTYPE;
  v_ex_proxy UUID;
  v_ex_gen   INTEGER;
  v_ex_ip    INET;
  v_ex_ctry  TEXT;
BEGIN
  SELECT geo INTO v_geo FROM linkedin_accounts
    WHERE id = p_account AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_not_found');
  END IF;

  SELECT a.proxy_id, p.endpoint_generation, p.exit_ip, p.country
    INTO v_ex_proxy, v_ex_gen, v_ex_ip, v_ex_ctry
    FROM linkedin_proxy_assignments a
    JOIN linkedin_proxies p ON p.id = a.proxy_id
    WHERE a.account_id = p_account AND a.tenant_id = p_tenant AND a.released_at IS NULL;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'proxy_id', v_ex_proxy,
                              'endpoint_generation', v_ex_gen, 'exit_ip', v_ex_ip, 'country', v_ex_ctry);
  END IF;

  v_country := lower(trim(coalesce(v_geo, '')));
  IF v_country !~ '^[a-z]{2}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_no_geo');
  END IF;

  SELECT p.* INTO v_proxy FROM linkedin_proxies p
    WHERE p.reputation_state = 'clean'
      AND p.provider_health = 'healthy'
      AND p.replacement_state = 'none'
      AND p.country = v_country
      AND (p.owner_tenant_id = p_tenant OR p.owner_tenant_id IS NULL)
      AND (p.plan_expires_at IS NULL OR p.plan_expires_at > now())
      AND NOT EXISTS (SELECT 1 FROM linkedin_burned_exit_ips b WHERE b.exit_ip = p.exit_ip)
      AND NOT EXISTS (SELECT 1 FROM linkedin_proxy_assignments a
                        WHERE a.proxy_id = p.id AND a.released_at IS NULL)
    ORDER BY p.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_proxy', 'country', v_country);
  END IF;

  UPDATE linkedin_proxy_assignments SET released_at = now(),
      lease_token = NULL, lease_expires_at = NULL, lease_job_id = NULL
    WHERE account_id = p_account AND released_at IS NULL AND proxy_id <> v_proxy.id;
  INSERT INTO linkedin_proxy_assignments (account_id, proxy_id, tenant_id)
    VALUES (p_account, v_proxy.id, p_tenant)
  ON CONFLICT (account_id) DO UPDATE SET
    proxy_id = EXCLUDED.proxy_id, tenant_id = EXCLUDED.tenant_id,
    assigned_at = now(), released_at = NULL,
    lease_token = NULL, lease_expires_at = NULL, lease_job_id = NULL;

  UPDATE linkedin_accounts
    SET proxy_mode = 'static_required',
        last_validated_proxy_generation = NULL, last_validated_proxy_id = NULL
    WHERE id = p_account AND tenant_id = p_tenant;

  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'proxy_id', v_proxy.id,
                            'endpoint_generation', v_proxy.endpoint_generation,
                            'exit_ip', v_proxy.exit_ip, 'country', v_proxy.country);
END;
$$;

-- ── Grants: service-role only (no anon/authenticated execute) ─────────────────────
REVOKE ALL ON FUNCTION linkedin_import_and_assign_proxy(UUID,UUID,TEXT,TEXT,TEXT,INET,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION linkedin_claim_proxy(UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_import_and_assign_proxy(UUID,UUID,TEXT,TEXT,TEXT,INET,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION linkedin_claim_proxy(UUID,UUID) TO service_role;
REVOKE ALL ON FUNCTION linkedin_acquire_send_lease(UUID,UUID,TEXT,INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION linkedin_release_send_lease(UUID,UUID,UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION linkedin_burn_proxy(UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_acquire_send_lease(UUID,UUID,TEXT,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION linkedin_release_send_lease(UUID,UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION linkedin_burn_proxy(UUID,UUID,TEXT) TO service_role;
