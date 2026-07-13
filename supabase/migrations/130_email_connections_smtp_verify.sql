-- Tibexa Core CRM Expansion — email_connections SMTP verify freshness  [130]
-- Persists the RESULT + TIMESTAMP of the last SMTP connection-verify so an
-- SMTP-only sending identity has a freshness signal (today only is_active exists;
-- IMAP-backed boxes carry last_polled_at, SMTP-only boxes carried nothing).
-- ADDITIVE ONLY: no data touch, no constraint on existing rows, no RLS/policy
-- change (§2.3.1 — email_connections is a SHARED table; cold-email / warmup /
-- campaign row data stays untouched; only these three warm/read-side verify
-- columns are added and only the connection-test path writes them).
--
-- last_verified_at  — when the SMTP transporter.verify() last ran for this box.
-- last_verify_ok    — whether that verify succeeded (freshness health signal).
-- last_verify_error — the raw failure detail (server-side only; kept OUT of the
--                     client-facing PUBLIC_COLUMNS as it is an info-oracle).

ALTER TABLE email_connections
  ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_verify_ok BOOLEAN,
  ADD COLUMN IF NOT EXISTS last_verify_error TEXT;

COMMENT ON COLUMN email_connections.last_verified_at IS
  'When the SMTP connection-verify (transporter.verify) last ran for this box. '
  'NULL = never verified (Nango/OAuth boxes, or an SMTP box saved before 130). Freshness signal.';

COMMENT ON COLUMN email_connections.last_verify_ok IS
  'Whether the last SMTP connection-verify succeeded. NULL = never verified. '
  'Warm/read-side health hint; surfaced to the client alongside last_verified_at.';

COMMENT ON COLUMN email_connections.last_verify_error IS
  'Raw failure detail from the last SMTP connection-verify (truncated). '
  'Server-side only — excluded from PUBLIC_COLUMNS (info-oracle avoidance).';
