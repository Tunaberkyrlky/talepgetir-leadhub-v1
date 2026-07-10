-- ==========================================
-- 106_linkedin_static_proxies.sql
-- TG-LinkedIn static residential proxy pool (P0, codex gpt-5.6-sol hardened).
-- Design: Tg-LinkedIn/04_STATIC_PROXY_POOL.md §3/§4/§9.
--
-- Gives each LinkedIn account ONE dedicated static IP that never rotates. Key invariants
-- (all enforced here, not just documented):
--   * ONE authoritative assignment relation (no dual pointers): linkedin_proxy_assignments.
--   * 1 IP <-> 1 account: account_id PK + partial-unique(proxy_id where released_at is null).
--   * Burned physical exit IP is NEVER re-used: permanent linkedin_burned_exit_ips denylist,
--     keyed on the OBSERVED exit_ip (not the mutable provider row).
--   * Fail-closed: accounts carry proxy_mode; a static_required account with no healthy,
--     current assignment must NOT send (dispatcher enforces; no silent DataImpulse fallback).
--   * validate == send same IP: endpoint_generation on the proxy + last_validated_proxy_generation
--     on the account; any host/port/cred/IP change bumps generation and forces revalidation.
--
-- Atomic mutations go through SECURITY DEFINER RPCs (Supabase can't hold BEGIN/COMMIT across
-- calls). Deny-all RLS; service-role only. Additive + re-runnable.
-- ==========================================

-- ── Tables ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS linkedin_proxies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_tenant_id     UUID,                              -- inventory owner (NULL = global pool)
  provider            TEXT NOT NULL DEFAULT 'iproyal',
  provider_plan_id    TEXT,                              -- plan/order id when API-provisioned
  ext_id              TEXT NOT NULL,                     -- provider proxy id (manual: 'manual:host:port')
  proxy_address       TEXT NOT NULL,                     -- provider-reported IP/host
  exit_ip             INET,                              -- OBSERVED egress IP (echo-verified)
  host                TEXT NOT NULL,
  port                INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username_enc        TEXT NOT NULL,                     -- AES-256-GCM (LINKEDIN_PROXY_ENC_KEY)
  password_enc        TEXT NOT NULL,
  country             TEXT,                              -- ISO-2 lower
  endpoint_generation INTEGER NOT NULL DEFAULT 1,        -- ++ on host/port/cred/IP change
  provider_health     TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (provider_health IN ('unknown','healthy','unhealthy')),
  reputation_state    TEXT NOT NULL DEFAULT 'clean'
                        CHECK (reputation_state IN ('clean','quarantined','burned','retired')),
  replacement_state   TEXT NOT NULL DEFAULT 'none'
                        CHECK (replacement_state IN ('none','pending','completed','failed')),
  plan_expires_at     TIMESTAMPTZ,
  last_seen_sync      UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, ext_id)
);

-- ONE account -> at most one active proxy; ONE proxy -> at most one active account.
CREATE TABLE IF NOT EXISTS linkedin_proxy_assignments (
  account_id  UUID PRIMARY KEY,
  proxy_id    UUID NOT NULL REFERENCES linkedin_proxies(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS linkedin_proxy_assignment_one_active
  ON linkedin_proxy_assignments(proxy_id) WHERE released_at IS NULL;

-- Permanent denylist of observed egress IPs that must never be handed to another account.
CREATE TABLE IF NOT EXISTS linkedin_burned_exit_ips (
  exit_ip           INET PRIMARY KEY,
  burned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason            TEXT,
  source_account_id UUID
);

-- Account-side: fail-closed mode + the validated-generation gate. (geo already exists.)
ALTER TABLE linkedin_accounts
  ADD COLUMN IF NOT EXISTS proxy_mode TEXT NOT NULL DEFAULT 'legacy_rotating'
    CHECK (proxy_mode IN ('static_required','legacy_rotating'));
ALTER TABLE linkedin_accounts
  ADD COLUMN IF NOT EXISTS last_validated_proxy_generation INTEGER;

-- ── Deny-all RLS (mirrors the rest of the linkedin_* module) ─────────────────────
ALTER TABLE linkedin_proxies             ENABLE ROW LEVEL SECURITY;
ALTER TABLE linkedin_proxy_assignments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE linkedin_burned_exit_ips     ENABLE ROW LEVEL SECURITY;

-- ── RPC: import a proxy + assign it to one account (atomic) ──────────────────────
-- P0 path: operator hands a verified host:port:user:pass (server-side, after SSRF + echo).
-- Refuses a burned exit IP; upserts the provider row (bumping endpoint_generation on any
-- endpoint/cred/IP change); guarantees the proxy isn't already held by a different account;
-- releases any prior assignment for this account; flips the account to static_required and
-- clears its validated generation so the next validate must confirm the new IP.
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
  -- Account must exist under this tenant.
  PERFORM 1 FROM linkedin_accounts WHERE id = p_account AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_not_found');
  END IF;

  -- Burned physical IP can never come back (P1.4).
  IF p_exit_ip IS NOT NULL AND EXISTS (SELECT 1 FROM linkedin_burned_exit_ips WHERE exit_ip = p_exit_ip) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'burned_ip');
  END IF;

  -- Upsert the provider row; bump generation when the reachable endpoint changed.
  SELECT * INTO v_prev FROM linkedin_proxies
    WHERE provider = p_provider AND ext_id = p_ext_id FOR UPDATE;
  IF FOUND THEN
    v_bumped := (v_prev.host <> p_host OR v_prev.port <> p_port
                 OR v_prev.username_enc <> p_username_enc OR v_prev.password_enc <> p_password_enc
                 OR v_prev.exit_ip IS DISTINCT FROM p_exit_ip);
    UPDATE linkedin_proxies SET
      owner_tenant_id = COALESCE(owner_tenant_id, p_tenant),
      provider_plan_id = COALESCE(p_plan_id, provider_plan_id),
      proxy_address = p_proxy_address, exit_ip = p_exit_ip, host = p_host, port = p_port,
      username_enc = p_username_enc, password_enc = p_password_enc, country = lower(p_country),
      endpoint_generation = endpoint_generation + (CASE WHEN v_bumped THEN 1 ELSE 0 END),
      provider_health = 'healthy', reputation_state =
        (CASE WHEN reputation_state = 'burned' THEN 'burned' ELSE 'clean' END),
      updated_at = now()
    WHERE id = v_prev.id
    RETURNING * INTO v_proxy;
    IF v_proxy.reputation_state = 'burned' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'proxy_burned');
    END IF;
  ELSE
    INSERT INTO linkedin_proxies (
      owner_tenant_id, provider, provider_plan_id, ext_id, proxy_address, exit_ip,
      host, port, username_enc, password_enc, country, provider_health
    ) VALUES (
      p_tenant, p_provider, p_plan_id, p_ext_id, p_proxy_address, p_exit_ip,
      p_host, p_port, p_username_enc, p_password_enc, lower(p_country), 'healthy'
    ) RETURNING * INTO v_proxy;
  END IF;

  -- The proxy must not be actively assigned to a DIFFERENT account (P1.3).
  SELECT account_id INTO v_holder FROM linkedin_proxy_assignments
    WHERE proxy_id = v_proxy.id AND released_at IS NULL;
  IF v_holder IS NOT NULL AND v_holder <> p_account THEN
    RETURN jsonb_build_object('ok', false, 'error', 'proxy_in_use');
  END IF;

  -- Release any prior active assignment for this account, then (re)assign.
  UPDATE linkedin_proxy_assignments SET released_at = now()
    WHERE account_id = p_account AND released_at IS NULL AND proxy_id <> v_proxy.id;
  INSERT INTO linkedin_proxy_assignments (account_id, proxy_id, tenant_id)
    VALUES (p_account, v_proxy.id, p_tenant)
  ON CONFLICT (account_id) DO UPDATE SET
    proxy_id = EXCLUDED.proxy_id, tenant_id = EXCLUDED.tenant_id,
    assigned_at = now(), released_at = NULL;

  -- Fail-closed + force revalidation of the new IP (P1.10/P1.12).
  UPDATE linkedin_accounts
    SET proxy_mode = 'static_required', last_validated_proxy_generation = NULL
    WHERE id = p_account AND tenant_id = p_tenant;

  RETURN jsonb_build_object('ok', true, 'proxy_id', v_proxy.id,
                            'endpoint_generation', v_proxy.endpoint_generation,
                            'reassigned', v_bumped);
END;
$$;

-- ── RPC: burn a proxy (LinkedIn-risk) — permanent, atomic ────────────────────────
-- Retires the binding, denylists the observed exit IP, bumps generation. The account is
-- left WITHOUT a usable assignment (fail-closed) until an operator assigns a fresh IP —
-- deliberately does NOT auto-log-in from a new IP during a restriction (P1.15).
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
  v_exit  INET;
  v_acct  UUID;
BEGIN
  SELECT exit_ip INTO v_exit FROM linkedin_proxies
    WHERE id = p_proxy AND (owner_tenant_id = p_tenant OR owner_tenant_id IS NULL) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'proxy_not_found');
  END IF;

  SELECT account_id INTO v_acct FROM linkedin_proxy_assignments
    WHERE proxy_id = p_proxy AND released_at IS NULL;

  UPDATE linkedin_proxies
    SET reputation_state = 'burned', endpoint_generation = endpoint_generation + 1, updated_at = now()
    WHERE id = p_proxy;
  UPDATE linkedin_proxy_assignments SET released_at = now()
    WHERE proxy_id = p_proxy AND released_at IS NULL;
  IF v_exit IS NOT NULL THEN
    INSERT INTO linkedin_burned_exit_ips (exit_ip, reason, source_account_id)
      VALUES (v_exit, p_reason, v_acct)
    ON CONFLICT (exit_ip) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', true, 'burned_exit_ip', v_exit, 'account_id', v_acct);
END;
$$;

-- ── Grants: service-role only (no anon/authenticated execute) ─────────────────────
REVOKE ALL ON FUNCTION linkedin_import_and_assign_proxy(UUID,UUID,TEXT,TEXT,TEXT,INET,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION linkedin_burn_proxy(UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_import_and_assign_proxy(UUID,UUID,TEXT,TEXT,TEXT,INET,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION linkedin_burn_proxy(UUID,UUID,TEXT) TO service_role;
