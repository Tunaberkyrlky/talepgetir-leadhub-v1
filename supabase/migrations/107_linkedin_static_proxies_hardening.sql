-- ==========================================
-- 107_linkedin_static_proxies_hardening.sql
-- Hardening from the codex gpt-5.6-sol high review of 106 (§9 addendum in the plan doc).
--
--   * P1.6  import RPC mutated the existing row BEFORE the holder/burned checks, so a
--           `proxy_in_use`/`proxy_burned` return (no exception) left a live account's row
--           corrupted. Reordered: ALL rejects happen under the row lock BEFORE any mutation.
--   * P1.8  a foreign-owned proxy row could be silently re-credentialled + assigned. Reject
--           when an existing row's owner_tenant_id is set and differs from the caller.
--   * P1.5  1:1 was per proxy_id, not per physical IP → two rows with the same exit_ip could
--           both be active. Partial-unique on exit_ip for non-burned rows enforces one active
--           proxy per physical egress IP.
--   * P1.3  generation was a bare per-proxy int (ABA across replacement). Account now also
--           records last_validated_proxy_id; the send gate compares (proxy_id, generation),
--           and validation is stamped via a CAS RPC that only writes if the SAME active
--           assignment still holds — a stale validate can't open a replaced proxy.
-- Additive + re-runnable.
-- ==========================================

ALTER TABLE linkedin_accounts ADD COLUMN IF NOT EXISTS last_validated_proxy_id UUID;

-- One ACTIVE (non-burned) proxy per physical exit IP (P1.5). Burned rows are exempt so the
-- permanent denylist row can coexist; a new usable row with a burned IP is refused by the RPC.
CREATE UNIQUE INDEX IF NOT EXISTS linkedin_proxies_one_active_exit_ip
  ON linkedin_proxies(exit_ip)
  WHERE exit_ip IS NOT NULL AND reputation_state <> 'burned';

-- ── Import RPC v2: checks-before-mutation, owner-tenant guard, clear validated proxy ──
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

  -- Lock the existing provider row (if any) and run EVERY reject BEFORE mutating it (P1.6).
  SELECT * INTO v_prev FROM linkedin_proxies
    WHERE provider = p_provider AND ext_id = p_ext_id FOR UPDATE;
  IF FOUND THEN
    IF v_prev.reputation_state = 'burned' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'proxy_burned');
    END IF;
    IF v_prev.owner_tenant_id IS NOT NULL AND v_prev.owner_tenant_id <> p_tenant THEN
      RETURN jsonb_build_object('ok', false, 'error', 'proxy_foreign_owner');   -- P1.8
    END IF;
    SELECT account_id INTO v_holder FROM linkedin_proxy_assignments
      WHERE proxy_id = v_prev.id AND released_at IS NULL;
    IF v_holder IS NOT NULL AND v_holder <> p_account THEN
      RETURN jsonb_build_object('ok', false, 'error', 'proxy_in_use');          -- checked BEFORE mutation
    END IF;
    -- All clear → now mutate.
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

  -- (Re)assign to this account; clear its validated pointers so the new IP must revalidate.
  UPDATE linkedin_proxy_assignments SET released_at = now()
    WHERE account_id = p_account AND released_at IS NULL AND proxy_id <> v_proxy.id;
  INSERT INTO linkedin_proxy_assignments (account_id, proxy_id, tenant_id)
    VALUES (p_account, v_proxy.id, p_tenant)
  ON CONFLICT (account_id) DO UPDATE SET
    proxy_id = EXCLUDED.proxy_id, tenant_id = EXCLUDED.tenant_id, assigned_at = now(), released_at = NULL;

  UPDATE linkedin_accounts
    SET proxy_mode = 'static_required',
        last_validated_proxy_generation = NULL, last_validated_proxy_id = NULL
    WHERE id = p_account AND tenant_id = p_tenant;

  RETURN jsonb_build_object('ok', true, 'proxy_id', v_proxy.id,
                            'endpoint_generation', v_proxy.endpoint_generation, 'reassigned', v_bumped);
END;
$$;

-- ── CAS stamp of a validated proxy generation (P1.3) ─────────────────────────────
-- Writes the account's validated pointers ONLY if the exact active assignment (account->proxy)
-- still holds. A validate that resolved a since-replaced proxy therefore no-ops instead of
-- opening the new proxy without validating it. Returns whether it stamped.
CREATE OR REPLACE FUNCTION linkedin_stamp_validated_proxy(
  p_tenant UUID, p_account UUID, p_proxy UUID, p_generation INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_ok BOOLEAN := FALSE;
BEGIN
  PERFORM 1 FROM linkedin_proxy_assignments a
    JOIN linkedin_proxies p ON p.id = a.proxy_id
    WHERE a.account_id = p_account AND a.tenant_id = p_tenant AND a.proxy_id = p_proxy
      AND a.released_at IS NULL AND p.endpoint_generation = p_generation
      AND p.reputation_state = 'clean';
  IF FOUND THEN
    UPDATE linkedin_accounts
      SET last_validated_proxy_id = p_proxy, last_validated_proxy_generation = p_generation
      WHERE id = p_account AND tenant_id = p_tenant;
    v_ok := TRUE;
  END IF;
  RETURN jsonb_build_object('ok', v_ok);
END;
$$;

REVOKE ALL ON FUNCTION linkedin_stamp_validated_proxy(UUID,UUID,UUID,INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_stamp_validated_proxy(UUID,UUID,UUID,INTEGER) TO service_role;
