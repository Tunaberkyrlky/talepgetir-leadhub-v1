-- ==========================================
-- Daily activity digest support
-- Forward-only timestamp version: numeric 152 would sort behind already-present
-- 20260716 migrations on long-lived TG-Research environments.
--
-- Tenant opt-in lives in tenants.settings JSONB as { "daily_digest_enabled": true }
-- (no schema change needed for the toggle).
--
-- The digest reuses activities.occurred_at as the "scheduled-for" timestamp —
-- the form's DateTimePicker already treats future occurred_at as a planned date,
-- so no second column is needed.
--
-- This migration adds:
--   * idx_activities_tenant_occurred_at — speeds up the "today's items" range scan
--   * daily_digest_log — idempotency: one row per (tenant, user, day) when the mail was sent
-- ==========================================

-- ── 1) Index for the digest range scan ─────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_activities_tenant_occurred_at
  ON activities (tenant_id, occurred_at);


-- ── 2) daily_digest_log ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS daily_digest_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  digest_date   DATE NOT NULL,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_id    TEXT,
  item_count    INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT daily_digest_log_tenant_user_date_key UNIQUE(tenant_id, user_id, digest_date)
);

-- Upgrade safely when an earlier staging environment already created the table
-- from the out-of-sequence source migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'daily_digest_log'::regclass
      AND conname = 'daily_digest_log_tenant_user_date_key'
  ) THEN
    ALTER TABLE daily_digest_log
      ADD CONSTRAINT daily_digest_log_tenant_user_date_key
      UNIQUE (tenant_id, user_id, digest_date);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'daily_digest_log'::regclass
      AND conname = 'daily_digest_log_user_id_digest_date_key'
  ) THEN
    ALTER TABLE daily_digest_log
      DROP CONSTRAINT daily_digest_log_user_id_digest_date_key;
  END IF;
END $$;

-- Service-role only: scheduler writes; no client-side reads needed.
ALTER TABLE daily_digest_log ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE/DELETE policies → only service_role bypass works.

CREATE INDEX IF NOT EXISTS idx_daily_digest_log_tenant_date
  ON daily_digest_log (tenant_id, digest_date);

COMMENT ON TABLE daily_digest_log IS
  'One row per (tenant, user, day) when the daily digest email was sent. Used by the scheduler for idempotency.';
