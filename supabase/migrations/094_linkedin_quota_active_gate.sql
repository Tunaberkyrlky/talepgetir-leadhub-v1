-- ==========================================
-- 094_linkedin_quota_active_gate.sql
-- TG-LinkedIn Faz 2 — codex P1: fold the ACTIVE gate INTO the atomic consume.
--
-- 093's consume reserved a slot regardless of status; the handler pre-checked status='ACTIVE'
-- separately, leaving a TOCTOU window where an operator PAUSE landing between the pre-check
-- and the reservation still let the send proceed. Doing the status check UNDER THE SAME
-- FOR UPDATE lock closes that window: a slot is reserved only if the account is ACTIVE at
-- reservation time. (A PAUSE arriving during the subsequent network send is unavoidable —
-- an in-flight HTTP request can't be recalled — but the post-send health update is separately
-- guarded to never overwrite a PAUSE.)
--
-- Return shape extends 093 additively: adds `reason` ('ok'|'not_active'|'cap') and `status`
-- so the caller can distinguish an over-cap skip from a not-active skip. `granted`/`current`/
-- `cap` keep their meaning. CREATE OR REPLACE — idempotent.
-- ==========================================

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
  v_status   TEXT;
  v_cur      INTEGER;
BEGIN
  IF p_type NOT IN ('invites','messages','visits') THEN
    RAISE EXCEPTION 'linkedin_try_consume_quota: invalid type %', p_type;
  END IF;

  -- Fence: FOR UPDATE serializes concurrent consumes AND freezes status for the check+bump.
  SELECT daily_counters, status INTO v_counters, v_status FROM linkedin_accounts
   WHERE id = p_account AND tenant_id = p_tenant
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'linkedin_try_consume_quota: account % not found for tenant %', p_account, p_tenant;
  END IF;

  -- ACTIVE gate under the lock: never reserve a slot on a paused/restricted/etc. account.
  IF v_status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'not_active', 'status', v_status);
  END IF;

  -- Date rollover: a new UTC day starts every counter at zero.
  IF COALESCE(v_counters->>'date', '') <> v_today THEN
    v_counters := jsonb_build_object('date', v_today, 'invites', 0, 'messages', 0, 'visits', 0);
  END IF;

  v_cur := COALESCE((v_counters->>p_type)::int, 0);
  IF v_cur >= p_cap THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'cap', 'current', v_cur, 'cap', p_cap, 'status', v_status);
  END IF;

  v_counters := jsonb_set(v_counters, ARRAY[p_type], to_jsonb(v_cur + 1));
  UPDATE linkedin_accounts SET daily_counters = v_counters, updated_at = now()
   WHERE id = p_account AND tenant_id = p_tenant;

  RETURN jsonb_build_object('granted', true, 'reason', 'ok', 'current', v_cur + 1, 'cap', p_cap, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION linkedin_try_consume_quota(UUID, UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_try_consume_quota(UUID, UUID, TEXT, INTEGER) TO service_role;
