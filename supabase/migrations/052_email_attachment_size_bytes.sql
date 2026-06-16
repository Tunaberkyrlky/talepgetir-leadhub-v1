-- ==========================================
-- Actual byte size for uploaded attachments.
--
-- Needed so the send layer can decide per-channel whether a file fits as a real
-- MIME/base64 attachment (e.g. Outlook Graph ~3MB) or must fall back to a link
-- card. URL-only templates leave this NULL.
-- ==========================================

ALTER TABLE email_attachment_templates
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT;
