-- ==========================================
-- 108_linkedin_proxy_pool.sql
-- TG-LinkedIn P1 — pool import (no account binding) + claim RPC.
-- Design: Tg-LinkedIn/04_STATIC_PROXY_POOL.md §4b (claim) / §4c (dispatcher) / §7 row P1.
--
-- P0 (mig 106/107) only shipped the one-shot import-AND-assign path. P1 splits the two so an
-- operator can seed the POOL with dedicated IPs without binding them to an account yet, then
-- later bind one to an account atomically via a claim RPC that derives the country from the
-- account's own geo (server-side, fail-closed) and enforces every §3a invariant.
--
--   * linkedin_import_proxy_to_pool  — verified host:port:user:pass → pool row, NO assignment,
--     NO account mutation. Same checks-before-mutation ordering + owner-tenant guard + burned
--     denylist + endpoint_generation bump as the P0 import RPC (mig 107).
--   * linkedin_claim_proxy(tenant, account) — lock the account (tenant-scoped), derive country
--     from account.geo (FAIL CLOSED if absent — never an arbitrary country, codex P1.7), pick a
--     clean+healthy+unassigned proxy in the SAME country that isn't burned/expired, bind it, and
--     force revalidation (proxy_mode='static_required' + validated pointers NULLed). No fallback
--     to the rotating gateway anywhere — a missing proxy returns a structured 'no_proxy'.
--
-- Atomic mutations go through SECURITY DEFINER RPCs (Supabase can't hold BEGIN/COMMIT across
-- calls). Deny-all RLS already on the tables (mig 106); service-role only. Additive + re-runnable.
-- ==========================================

-- ── RPC: import a proxy into the POOL (no account binding) ────────────────────────
-- Country here is the ECHO-OBSERVED egress geo (the route verifies it server-side), NOT a
-- request field. A pool proxy with an unknown/invalid country is refused — it could never be
-- claimed (claim requires an exact ISO-2 country match), so silently storing it is dead stock.
-- Rejects (burned IP / burned reputation / foreign owner / already-assigned) all happen under
-- the row lock BEFORE any mutation (mig 107 P1.6 ordering).
CREATE OR REPLACE FUNCTION linkedin_import_proxy_to_pool(
  p_tenant        UUID,
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
  v_country TEXT := lower(trim(coalesce(p_country, '')));
  v_holder  UUID;
BEGIN
  -- Country must be a real ISO-2 (a country-less pool proxy is never claimable).
  IF v_country !~ '^[a-z]{2}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_country');
  END IF;

  -- Burned physical IP can never re-enter the pool (P1.4).
  IF p_exit_ip IS NOT NULL AND EXISTS (SELECT 1 FROM linkedin_burned_exit_ips WHERE exit_ip = p_exit_ip) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'burned_ip');
  END IF;

  -- Lock the existing provider row (if any); run EVERY reject BEFORE mutating it (P1.6). The
  -- LOOP makes this idempotent under concurrency (codex P2): for a NOT-yet-present (provider,
  -- ext_id) two callers can both miss the FOR UPDATE (no row to lock) and race the unique insert;
  -- the loser catches the unique_violation and loops back to lock+check+update the row the winner
  -- just created, instead of surfacing a raw 23505.
  LOOP
    SELECT * INTO v_prev FROM linkedin_proxies
      WHERE provider = p_provider AND ext_id = p_ext_id FOR UPDATE;
    IF FOUND THEN
      IF v_prev.reputation_state = 'burned' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'proxy_burned');
      END IF;
      IF v_prev.owner_tenant_id IS NOT NULL AND v_prev.owner_tenant_id <> p_tenant THEN
        RETURN jsonb_build_object('ok', false, 'error', 'proxy_foreign_owner');   -- P1.8
      END IF;
      -- A pool import never touches an account, so re-crediting a proxy that is ACTIVELY bound
      -- would silently rotate a live account's IP without clearing its validated pointers.
      -- Refuse it — rebinding goes through claim/replacement, not pool import.
      SELECT account_id INTO v_holder FROM linkedin_proxy_assignments
        WHERE proxy_id = v_prev.id AND released_at IS NULL;
      IF v_holder IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'proxy_in_use');
      END IF;
      -- All clear → now mutate. Bump generation only when the reachable endpoint/cred/IP changed.
      v_bumped := (v_prev.host <> p_host OR v_prev.port <> p_port
                   OR v_prev.username_enc <> p_username_enc OR v_prev.password_enc <> p_password_enc
                   OR v_prev.exit_ip IS DISTINCT FROM p_exit_ip);
      UPDATE linkedin_proxies SET
        owner_tenant_id = COALESCE(owner_tenant_id, p_tenant),
        provider_plan_id = COALESCE(p_plan_id, provider_plan_id),
        proxy_address = p_proxy_address, exit_ip = p_exit_ip, host = p_host, port = p_port,
        username_enc = p_username_enc, password_enc = p_password_enc, country = v_country,
        endpoint_generation = endpoint_generation + (CASE WHEN v_bumped THEN 1 ELSE 0 END),
        provider_health = 'healthy', updated_at = now()
      WHERE id = v_prev.id
      RETURNING * INTO v_proxy;
      EXIT;
    ELSE
      BEGIN
        INSERT INTO linkedin_proxies (
          owner_tenant_id, provider, provider_plan_id, ext_id, proxy_address, exit_ip,
          host, port, username_enc, password_enc, country, provider_health
        ) VALUES (
          p_tenant, p_provider, p_plan_id, p_ext_id, p_proxy_address, p_exit_ip,
          p_host, p_port, p_username_enc, p_password_enc, v_country, 'healthy'
        ) RETURNING * INTO v_proxy;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- A concurrent import created this exact (provider, ext_id) between our miss and insert.
        -- Loop: the next FOR UPDATE will lock it and run the full check+update path on it.
      END;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'proxy_id', v_proxy.id,
                            'endpoint_generation', v_proxy.endpoint_generation,
                            'exit_ip', v_proxy.exit_ip, 'country', v_proxy.country,
                            'reassigned', v_bumped);
END;
$$;

-- ── RPC: claim a pooled proxy for an account (atomic) ─────────────────────────────
-- §4b. Binds ONE dedicated IP to an account, deriving the country from the account's own geo
-- (never a caller field). Fail-closed at every branch: no geo → no assignment; no matching
-- clean/healthy/unassigned proxy → 'no_proxy' (the caller must NOT fall back to rotating). On
-- success the account is flipped to static_required with its validated pointers cleared, so a
-- revalidate is mandatory before the send-gate (resolveDispatcher) will open on the new IP.
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
  -- Lock the account row, tenant-scoped. A foreign-tenant / missing account is rejected here
  -- (no cross-tenant claim; codex P1.6).
  SELECT geo INTO v_geo FROM linkedin_accounts
    WHERE id = p_account AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_not_found');
  END IF;

  -- Idempotent: an already-active assignment is returned as-is (no re-pick, no re-mutation).
  SELECT a.proxy_id, p.endpoint_generation, p.exit_ip, p.country
    INTO v_ex_proxy, v_ex_gen, v_ex_ip, v_ex_ctry
    FROM linkedin_proxy_assignments a
    JOIN linkedin_proxies p ON p.id = a.proxy_id
    WHERE a.account_id = p_account AND a.tenant_id = p_tenant AND a.released_at IS NULL;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'proxy_id', v_ex_proxy,
                              'endpoint_generation', v_ex_gen, 'exit_ip', v_ex_ip, 'country', v_ex_ctry);
  END IF;

  -- Country is derived ONLY from the account's geo. No geo → FAIL CLOSED (never an arbitrary
  -- country; codex P1.7).
  v_country := lower(trim(coalesce(v_geo, '')));
  IF v_country !~ '^[a-z]{2}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_no_geo');
  END IF;

  -- Pick ONE eligible proxy under the account lock:
  --   clean reputation + healthy transport + no pending replacement + exact ISO-2 country
  --   + owned by this tenant (or the global pool) + not burned + not expired + not already
  --   actively assigned. SKIP LOCKED so concurrent claims don't fight over the same row.
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
    -- Fail-closed: NO fallback to the rotating gateway. Operator/alarm must add stock.
    RETURN jsonb_build_object('ok', false, 'error', 'no_proxy', 'country', v_country);
  END IF;

  -- Bind it. Release any prior (released) row for this account then (re)assign — the account_id
  -- PK means a previously-released assignment row still occupies the PK, so upsert on conflict.
  UPDATE linkedin_proxy_assignments SET released_at = now()
    WHERE account_id = p_account AND released_at IS NULL AND proxy_id <> v_proxy.id;
  INSERT INTO linkedin_proxy_assignments (account_id, proxy_id, tenant_id)
    VALUES (p_account, v_proxy.id, p_tenant)
  ON CONFLICT (account_id) DO UPDATE SET
    proxy_id = EXCLUDED.proxy_id, tenant_id = EXCLUDED.tenant_id,
    assigned_at = now(), released_at = NULL;

  -- Fail-closed + force revalidation of the new IP before any send (P1.10/P1.12).
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
REVOKE ALL ON FUNCTION linkedin_import_proxy_to_pool(UUID,TEXT,TEXT,TEXT,INET,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION linkedin_claim_proxy(UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_import_proxy_to_pool(UUID,TEXT,TEXT,TEXT,INET,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION linkedin_claim_proxy(UUID,UUID) TO service_role;
