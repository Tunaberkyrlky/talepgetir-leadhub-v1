-- Replace partial unique index with a regular unique index so that
-- Supabase JS upsert (ON CONFLICT) can reference it without a WHERE clause.
-- PostgreSQL treats NULL as distinct in unique indexes, so rows where
-- campaign_id IS NULL are never considered duplicates — same dedup behaviour.
DROP INDEX IF EXISTS idx_email_replies_dedup;

CREATE UNIQUE INDEX idx_email_replies_dedup
  ON email_replies(campaign_id, sender_email, replied_at);
