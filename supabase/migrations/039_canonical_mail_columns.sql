-- ==========================================
-- Canonical Mail Data Layer — first-class columns on email_replies
-- ==========================================
-- Part of the canonical mail layer (PlusVibe + Nango + Resend normalization).
-- Today a message's real from/to/our-mailbox lives inconsistently inside
-- raw_payload (different keys per provider/source, sometimes truncated away).
-- These columns make the canonical fields first-class so matching, display,
-- and send all read ONE source of truth.
--
-- All nullable + backfilled separately (see scripts/backfillCanonical.ts).
-- Legacy raw_payload reads remain as a fallback until backfill completes.

ALTER TABLE email_replies
  ADD COLUMN IF NOT EXISTS provider             TEXT,  -- 'plusvibe' | 'gmail' | 'outlook' | 'resend'
  ADD COLUMN IF NOT EXISTS provider_message_id  TEXT,  -- PlusVibe email id / Gmail msg id / Resend id
  ADD COLUMN IF NOT EXISTS provider_thread_id   TEXT,  -- PlusVibe thread_id / Gmail threadId
  ADD COLUMN IF NOT EXISTS rfc_message_id       TEXT,  -- RFC 2822 Message-ID
  ADD COLUMN IF NOT EXISTS in_reply_to          TEXT,  -- RFC 2822 In-Reply-To
  ADD COLUMN IF NOT EXISTS channel              TEXT,  -- outbound intent: 'reply'|'forward'|'campaign'|'system'
  ADD COLUMN IF NOT EXISTS account_email        TEXT,  -- OUR mailbox on this thread (drives send + display "From")
  ADD COLUMN IF NOT EXISTS from_address         TEXT,  -- who sent THIS message (per-message)
  ADD COLUMN IF NOT EXISTS to_address           TEXT,  -- recipient(s), comma-separated
  ADD COLUMN IF NOT EXISTS cc_address           TEXT,  -- cc, comma-separated
  ADD COLUMN IF NOT EXISTS body_html            TEXT;  -- HTML body (reply_body keeps the text role)

COMMENT ON COLUMN email_replies.account_email IS
  'Canonical: OUR mailbox for this thread. For inbound = the connected account the lead corresponded with; for outbound = the account we sent from. Drives reply send "from" and the displayed "Kimden".';
COMMENT ON COLUMN email_replies.from_address IS
  'Canonical per-message sender. Distinct from sender_email, which is the thread/lead grouping key.';
COMMENT ON COLUMN email_replies.provider IS
  'Origin provider of the message: plusvibe | gmail | outlook | resend. Replaces the raw_payload.source heuristic.';

-- Thread lookup by provider's real thread id (future grouping; populated now)
CREATE INDEX IF NOT EXISTS idx_email_replies_provider_thread
  ON email_replies(tenant_id, provider_thread_id)
  WHERE provider_thread_id IS NOT NULL;
