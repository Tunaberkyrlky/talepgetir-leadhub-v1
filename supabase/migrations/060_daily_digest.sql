-- ==========================================
-- Twice-weekly activity digest (özet bildirim maili)
--
-- Tenant opt-in lives in tenants.settings JSONB:
--   { "daily_digest_enabled": true, "digest_days": [1, 4] }
-- (0=Pazar … 6=Cumartesi; varsayılan [1,4] = Pazartesi + Perşembe — no schema change needed for the toggle).
--
-- The digest reuses activities.occurred_at as the "scheduled-for" timestamp for
-- the "vadesi gelen" block, and created_at for the "eklenen aktiviteler" block.
-- The activities range index (tenant_id, occurred_at) already exists from 018.
--
-- This migration adds only:
--   * daily_digest_log — idempotency + window tracking: one row per (tenant, day).
-- ==========================================

CREATE TABLE IF NOT EXISTS daily_digest_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  digest_date     DATE NOT NULL,                 -- TR-local send date (idempotency key)
  window_start    TIMESTAMPTZ NOT NULL,          -- retrospective coverage start (prev sent digest's window_end)
  window_end      TIMESTAMPTZ NOT NULL,          -- retrospective coverage end (send moment)
  recipient_count INTEGER NOT NULL DEFAULT 0,
  item_count      INTEGER NOT NULL DEFAULT 0,    -- total content items summarized
  message_ids     TEXT[] NOT NULL DEFAULT '{}',  -- Resend message ids (one per recipient)
  status          TEXT NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('sent', 'skipped_empty', 'failed')),
  meta            JSONB NOT NULL DEFAULT '{}',   -- per-block counts, for debugging
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, digest_date)               -- one digest per tenant per day → race/idempotency guard
);

-- Service-role only: scheduler writes via supabaseAdmin; no client-side reads needed.
ALTER TABLE daily_digest_log ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE/DELETE policies → only service_role bypass works.

CREATE INDEX IF NOT EXISTS idx_daily_digest_log_tenant_date
  ON daily_digest_log (tenant_id, digest_date DESC);

COMMENT ON TABLE daily_digest_log IS
  'One row per (tenant, digest day) when the twice-weekly summary email was sent. Used by the scheduler for idempotency and since-last-digest window tracking.';
