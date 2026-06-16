-- ==========================================
-- Direct file upload for email attachments
--
-- Adds a Supabase Storage bucket for uploaded
-- attachment files + columns so an uploaded
-- file becomes an attachment "template" row
-- (link card, same send path as URL templates).
--
-- One-off uploads (is_library = false) stay out
-- of the reusable library list but the file must
-- persist so the card link in a sent mail keeps
-- working.
-- ==========================================

-- ── Storage bucket (public; unguessable {tenant}/{uuid}.{ext} paths) ──
-- Public so external recipients can open the card link without auth — same
-- exposure model as today's hand-pasted external URLs. Writes go through the
-- service-role client (bypasses RLS); reads are public via /object/public/.
-- allowed_mime_types is intentionally NULL: file types are enforced app-side by
-- extension (route ALLOWED_EXTS + Dropzone accept). A bucket-level MIME list
-- would reject legit files whose browser-sent type is generic (octet-stream) or
-- quirky (docx → application/zip). file_size_limit stays as a hard safety net.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES (
  'email-attachments',
  'email-attachments',
  true,
  10485760 -- 10 MB, matches the app-level Multer limit
)
ON CONFLICT (id) DO NOTHING;

-- ── Columns on email_attachment_templates ──
ALTER TABLE email_attachment_templates
  ADD COLUMN IF NOT EXISTS storage_path      TEXT,    -- bucket object path; NULL for URL-only templates
  ADD COLUMN IF NOT EXISTS original_filename TEXT,    -- uploaded file's original name
  ADD COLUMN IF NOT EXISTS is_library        BOOLEAN NOT NULL DEFAULT true; -- false = one-off (hidden from library list)

-- Library list is filtered by (tenant_id, is_library); keep it fast.
CREATE INDEX IF NOT EXISTS idx_att_templates_library
  ON email_attachment_templates(tenant_id, is_library, sort_order);
