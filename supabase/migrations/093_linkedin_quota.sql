-- ==========================================
-- 093_linkedin_quota.sql
-- TG-LinkedIn Faz 2 — atomic per-account daily action quota (invite/message).
--
-- These are LinkedIn RATE ceilings (§1), NOT research credits — no money, no
-- research_bill_match coupling. They are a SAFETY backstop so a bug or a smoke can
-- never blast an account past a conservative daily cap. The full warmup ramp +
-- working-hours window + jitter is Faz 3; here we just enforce a hard daily count.
--
-- Storage: linkedin_accounts.daily_counters JSONB {"date","invites","messages","visits"}.
-- Consume is a single FENCED statement (SELECT ... FOR UPDATE serializes concurrent
-- invite/message jobs for the SAME account → no TOCTOU over-send). Date rollover and the
-- increment happen together so a midnight-crossing run can't write a stale period.
--
-- Reserve-before-send + refund-on-not-sent: the handler consumes a slot BEFORE the write
-- and releases it if the write definitively did not land (transport/429/403/999/401/400).
--
-- Service-role only (082 revoke pattern). Additive + idempotent (CREATE OR REPLACE).
-- ==========================================

-- ── Reserve one slot of p_type ('invites'|'messages'|'visits') if under p_cap ──────
CREATE OR REPLACE FUNCTION linkedin_try_consume_quota(
  p_tenant  UUID,
  p_account UUID,
  p_type    TEXT,
  p_cap     INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today    TEXT := to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD');
  v_counters JSONB;
  v_cur      INTEGER;
BEGIN
  IF p_type NOT IN ('invites','messages','visits') THEN
    RAISE EXCEPTION 'linkedin_try_consume_quota: invalid type %', p_type;
  END IF;

  -- Fence: FOR UPDATE serializes concurrent consumes for this account (atomic check+bump).
  SELECT daily_counters INTO v_counters FROM linkedin_accounts
   WHERE id = p_account AND tenant_id = p_tenant
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'linkedin_try_consume_quota: account % not found for tenant %', p_account, p_tenant;
  END IF;

  -- Date rollover: a new UTC day starts every counter at zero.
  IF COALESCE(v_counters->>'date', '') <> v_today THEN
    v_counters := jsonb_build_object('date', v_today, 'invites', 0, 'messages', 0, 'visits', 0);
  END IF;

  v_cur := COALESCE((v_counters->>p_type)::int, 0);
  IF v_cur >= p_cap THEN
    RETURN jsonb_build_object('granted', false, 'current', v_cur, 'cap', p_cap);
  END IF;

  v_counters := jsonb_set(v_counters, ARRAY[p_type], to_jsonb(v_cur + 1));
  UPDATE linkedin_accounts SET daily_counters = v_counters, updated_at = now()
   WHERE id = p_account AND tenant_id = p_tenant;

  RETURN jsonb_build_object('granted', true, 'current', v_cur + 1, 'cap', p_cap);
END;
$$;

-- ── Refund one slot (write did not land). No-op after rollover / at floor 0. ────────
CREATE OR REPLACE FUNCTION linkedin_release_quota(
  p_tenant  UUID,
  p_account UUID,
  p_type    TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today    TEXT := to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD');
  v_counters JSONB;
  v_cur      INTEGER;
BEGIN
  IF p_type NOT IN ('invites','messages','visits') THEN
    RAISE EXCEPTION 'linkedin_release_quota: invalid type %', p_type;
  END IF;

  SELECT daily_counters INTO v_counters FROM linkedin_accounts
   WHERE id = p_account AND tenant_id = p_tenant
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  -- Only refund within the SAME day the reservation was made — after rollover the counter
  -- is already 0, so there is nothing to give back.
  IF COALESCE(v_counters->>'date', '') <> v_today THEN RETURN; END IF;

  v_cur := COALESCE((v_counters->>p_type)::int, 0);
  IF v_cur <= 0 THEN RETURN; END IF;

  v_counters := jsonb_set(v_counters, ARRAY[p_type], to_jsonb(v_cur - 1));
  UPDATE linkedin_accounts SET daily_counters = v_counters, updated_at = now()
   WHERE id = p_account AND tenant_id = p_tenant;
END;
$$;

REVOKE ALL ON FUNCTION linkedin_try_consume_quota(UUID, UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_try_consume_quota(UUID, UUID, TEXT, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION linkedin_release_quota(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_release_quota(UUID, UUID, TEXT) TO service_role;
