-- ==========================================
-- 145_linkedin_ai_messages.sql
-- TG-LinkedIn — AI-generated campaign messages.
--
-- Adds a per-step `ai_config` (mode off|sections|full + prompts) so an operator can have the
-- engine generate invite notes / messages at send-time instead of writing a static template.
-- The engine parses this fail-closed (a malformed config degrades to mode 'off' and the plain
-- template is used) — see server/src/lib/linkedin/sequences/aiGenerate.ts.
--
-- Additive + re-runnable. RLS unchanged (deny-all; service-role only).
-- ==========================================

-- ai_config defaults to '{}' → parseAiConfig reads that as { mode: 'off' } (plain template path).
ALTER TABLE linkedin_sequence_steps
  ADD COLUMN IF NOT EXISTS ai_config JSONB NOT NULL DEFAULT '{}';

-- ── F3 (paid-output cache + retry cap) ──────────────────────────────────────────
-- AI generation costs money and takes seconds–minutes, so a retry after a cap/lease/transport
-- skip (or an expired-lease re-claim) must NOT regenerate (double-spend). Each enrollment caches
-- its last successful render keyed by (current_step, config_hash); a matching cache is reused with
-- no LLM call. A run of generation FAILURES increments `attempts`; past a cap the enrollment fails
-- terminally instead of rescheduling forever. Advancing to the next step invalidates the cache via
-- the step check. Shape: { step:int, config_hash:text, rendered:text, parts:jsonb, attempts:int }.
ALTER TABLE linkedin_enrollments
  ADD COLUMN IF NOT EXISTS ai_render_cache JSONB NOT NULL DEFAULT '{}';

-- ── F5 (AI COGS trail) ──────────────────────────────────────────────────────────
-- The sequence engine + the paid preview both spend LLM $ generating message copy. Attribute that
-- spend to the tenant on the SAME append-only audit table used for send COGS, rather than a new
-- table. A new 'ai_generate' action type carries cogs_usd (the $ figure, INTERNAL-only) plus a raw
-- per-provider usage tally in `metadata` (so COGS can be recomputed against real invoices later).
-- account_id/job_id stay nullable — a preview has no sender account and no research job. This does
-- NOT affect send rate-limit/health counting: those filter on type IN ('invite','message',…) and
-- never see 'ai_generate' rows.
ALTER TABLE linkedin_actions
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
-- Re-runnable widen of the type CHECK (drop-then-add makes a second apply a no-op).
ALTER TABLE linkedin_actions
  DROP CONSTRAINT IF EXISTS linkedin_actions_type_check;
ALTER TABLE linkedin_actions
  ADD CONSTRAINT linkedin_actions_type_check
  CHECK (type IN ('capture','validate','invite','message','poll','withdraw','visit','ai_generate'));

-- ── Atomic sequence-step replace — REDEFINED from 101 to also carry ai_config ────
-- Identical to 101 (delete+insert in ONE txn so a concurrent sequence-tick never sees zero steps
-- mid-edit and wrongly completes a live lead) EXCEPT each element now also supplies `ai_config`.
-- Absent/null ai_config → '{}' (the plain-template default). p_steps is a JSONB array of
-- {type, wait_days, template, ai_config}; ordinality gives step_order.
CREATE OR REPLACE FUNCTION linkedin_replace_steps(
  p_tenant   UUID,
  p_campaign UUID,
  p_steps    JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  -- Ownership guard (defense in depth; the route already checked).
  PERFORM 1 FROM linkedin_campaigns WHERE id = p_campaign AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'linkedin_replace_steps: campaign % not found for tenant %', p_campaign, p_tenant;
  END IF;

  DELETE FROM linkedin_sequence_steps WHERE campaign_id = p_campaign;

  INSERT INTO linkedin_sequence_steps (tenant_id, campaign_id, step_order, type, wait_days, template, ai_config)
  SELECT p_tenant, p_campaign, (ord - 1)::int,
         elem->>'type',
         COALESCE((elem->>'wait_days')::numeric, 0),
         NULLIF(elem->>'template', ''),
         COALESCE(elem->'ai_config', '{}'::jsonb)
    FROM jsonb_array_elements(COALESCE(p_steps, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION linkedin_replace_steps(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION linkedin_replace_steps(UUID, UUID, JSONB) TO service_role;

-- ── R4 (durable per-tenant daily preview cap) ────────────────────────────────────
-- The step preview triggers a LIVE, paid LLM call. The daily spend cap that throttles it MUST NOT
-- live in process memory: a restart or a second instance would each grant the full cap. This table
-- is the durable per-tenant/day counter; the RPC below takes one unit ATOMICALLY (fail-closed).
-- Deny-all RLS (service-role only), matching every other linkedin_* table.
CREATE TABLE IF NOT EXISTS linkedin_ai_preview_usage (
  tenant_id UUID    NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day       DATE    NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);
ALTER TABLE linkedin_ai_preview_usage ENABLE ROW LEVEL SECURITY;

-- Atomically take ONE unit of today's preview budget for a tenant. Returns TRUE when the take
-- succeeded (count was below p_cap and got incremented) and FALSE when the cap is already reached.
-- Atomicity: the INSERT … ON CONFLICT DO UPDATE … WHERE count < p_cap acquires the row lock; when
-- the guard is false the UPDATE affects 0 rows and RETURNING yields NO row (v_count stays NULL), so
-- concurrent callers can never over-count or both see "under cap". `day` is computed in UTC to match
-- the previous per-UTC-day reset. Fail-closed: the route treats any RPC error as "cap reached".
CREATE OR REPLACE FUNCTION linkedin_ai_preview_take(
  p_tenant UUID,
  p_cap    INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
  v_day   DATE := (now() AT TIME ZONE 'utc')::date;
BEGIN
  INSERT INTO linkedin_ai_preview_usage (tenant_id, day, count)
  VALUES (p_tenant, v_day, 1)
  ON CONFLICT (tenant_id, day) DO UPDATE
    SET count = linkedin_ai_preview_usage.count + 1
    WHERE linkedin_ai_preview_usage.count < p_cap
  RETURNING count INTO v_count;

  -- v_count NULL ⇒ the ON CONFLICT guard failed (cap already reached) ⇒ nothing was taken.
  RETURN v_count IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION linkedin_ai_preview_take(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION linkedin_ai_preview_take(UUID, INTEGER) TO service_role;
