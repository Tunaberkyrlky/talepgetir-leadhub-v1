-- ==========================================
-- Email Reply Outbound Dedup
-- The existing idx_email_replies_dedup is partial: WHERE direction = 'IN'.
-- That intentionally lets multiple OUT rows share (campaign_id, sender_email,
-- replied_at), but it leaves outbound inserts (campaign first-touch / step
-- emails pulled from PlusVibe, webhook thread hydration, assign-time backfill)
-- without any DB-level dedup. Add a unique index keyed on the provider message
-- id so re-importing the same PlusVibe email can never duplicate an OUT row.
--
-- Verified before adding: zero existing collisions on
--   (tenant_id, provider, provider_message_id) WHERE provider_message_id IS NOT NULL.
-- ==========================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_replies_provider_msg_dedup
  ON email_replies (tenant_id, provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
