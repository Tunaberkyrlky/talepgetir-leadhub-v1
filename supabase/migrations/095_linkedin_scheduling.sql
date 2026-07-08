-- ==========================================
-- 095_linkedin_scheduling.sql
-- TG-LinkedIn Faz 3 — warmup + working-hours + weekly ceiling + anti-detection locale.
--
-- Adds the per-account state Faz 3 needs and folds a ROLLING-WEEKLY ceiling into the
-- atomic consume (093/094 only enforced a flat daily cap). The daily cap itself is now
-- warmup-derived in code (lib/linkedin/limits.ts) and passed in as p_cap; this migration
-- adds the second, harder ceiling: a 7-day count of LANDED sends (from the append-only
-- linkedin_actions trail), so a run can't sustain daily-max volume every day past the
-- weekly band (§1: invites ~100/week).
--
-- New columns:
--   warmup_started_at  — when the ramp began (backfilled to created_at). CALENDAR-based ramp
--                        (limits.ts); persisted so a UI toggle can never reset progress (083 note).
--   working_hours      — {"days":[1..7 ISO],"start":H,"end":H} local send window (§2).
--   accept_language    — the cookie's real browser Accept-Language, captured at connect and
--                        replayed verbatim (§3 anti-detection; omitting it is itself a signal).
--
-- Consume RPC is REPLACED (signature change → DROP the old 4-arg first): now takes an action
-- type ('invite'|'message'|'visit'), the warmup daily cap, and an optional weekly cap. The
-- daily check + counter bump are atomic under the account row lock; the weekly count is a
-- best-effort backstop (see actions.consumeQuota for the accepted in-flight overshoot bound).
--
-- DEPLOY ORDERING (codex P3): the DROP removes the old 4-arg signature the committed Faz-2
-- worker calls, and the new 5-arg form renames p_type→p_action_type, so a still-running old
-- worker would fail its consume between apply-migration and worker-redeploy. Apply this
-- migration together with (or just before) the Faz-3 worker deploy — not against a live older
-- worker fleet. (Moot on the isolated test DB, which has no separate long-running worker.)
-- ==========================================

-- ── New per-account scheduling / anti-detection state ──────────────────────────
ALTER TABLE linkedin_accounts
  ADD COLUMN IF NOT EXISTS warmup_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS working_hours     JSONB NOT NULL DEFAULT '{"days":[1,2,3,4,5],"start":9,"end":18}'::jsonb,
  ADD COLUMN IF NOT EXISTS accept_language   TEXT;

-- Backfill existing rows so their warmup age is measured from account creation, not "now".
UPDATE linkedin_accounts SET warmup_started_at = created_at WHERE warmup_started_at IS NULL;

-- ── Atomic daily+weekly+ACTIVE consume (replaces 094's 4-arg version) ───────────
-- Drop the prior signature so only the new one resolves (avoids overload ambiguity).
DROP FUNCTION IF EXISTS linkedin_try_consume_quota(UUID, UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION linkedin_try_consume_quota(
  p_tenant      UUID,
  p_account     UUID,
  p_action_type TEXT,      -- 'invite' | 'message' | 'visit' (audit type; counter key = type||'s')
  p_cap         INTEGER,   -- warmup-derived DAILY cap (limits.ts)
  p_weekly_cap  INTEGER    -- rolling 7-day cap of landed sends; NULL = no weekly ceiling
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today      TEXT := to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD');
  v_counter    TEXT;
  v_counters   JSONB;
  v_status     TEXT;
  v_cur        INTEGER;
  v_week       INTEGER;
BEGIN
  IF p_action_type NOT IN ('invite','message','visit') THEN
    RAISE EXCEPTION 'linkedin_try_consume_quota: invalid action type %', p_action_type;
  END IF;
  v_counter := p_action_type || 's';  -- daily_counters key: invite->invites, etc.

  -- Fence: FOR UPDATE serializes concurrent consumes for this account AND freezes status
  -- for the ACTIVE gate. The weekly COUNT below runs inside this critical section, so two
  -- jobs for the same account can't both slip past the weekly ceiling at its boundary.
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

  -- Rolling 7-day ceiling from the audit trail (status='ok' = a send that landed). Evaluated
  -- BEFORE the increment, so it bounds the count PRIOR to this attempt (this is the N+1th).
  IF p_weekly_cap IS NOT NULL THEN
    SELECT count(*) INTO v_week FROM linkedin_actions
     WHERE account_id = p_account AND tenant_id = p_tenant
       AND type = p_action_type AND status = 'ok'
       AND created_at > now() - interval '7 days';
    IF v_week >= p_weekly_cap THEN
      RETURN jsonb_build_object('granted', false, 'reason', 'weekly_cap',
                                'weekly', v_week, 'weekly_cap', p_weekly_cap, 'status', v_status);
    END IF;
  END IF;

  -- Date rollover: a new UTC day starts every counter at zero.
  IF COALESCE(v_counters->>'date', '') <> v_today THEN
    v_counters := jsonb_build_object('date', v_today, 'invites', 0, 'messages', 0, 'visits', 0);
  END IF;

  v_cur := COALESCE((v_counters->>v_counter)::int, 0);
  IF v_cur >= p_cap THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'cap',
                              'current', v_cur, 'cap', p_cap, 'status', v_status);
  END IF;

  v_counters := jsonb_set(v_counters, ARRAY[v_counter], to_jsonb(v_cur + 1));
  UPDATE linkedin_accounts SET daily_counters = v_counters, updated_at = now()
   WHERE id = p_account AND tenant_id = p_tenant;

  RETURN jsonb_build_object('granted', true, 'reason', 'ok',
                            'current', v_cur + 1, 'cap', p_cap, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION linkedin_try_consume_quota(UUID, UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_try_consume_quota(UUID, UUID, TEXT, INTEGER, INTEGER) TO service_role;

-- Note: linkedin_release_quota(UUID,UUID,TEXT) is unchanged from 093 — its p_type is still
-- the daily_counters key ('invites'|'messages'|'visits'), matching the refund call site.
