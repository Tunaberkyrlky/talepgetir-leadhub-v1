-- ==========================================
-- Email Replies — match_method column (v2 layered matcher)
-- ==========================================
-- Records WHICH matching layer produced the company/contact link.
-- Used for: confidence display in UI, backfill decisions (only overwrite
-- when a stronger layer matches), debug/audit.
--
-- Allowed values (lower rank = stronger match):
--   contact_email_exact       (rank 1)
--   company_email_exact       (rank 2)
--   website_domain_exact      (rank 3)
--   company_name_exact        (rank 4)
--   plusvibe_website_exact    (rank 5)
--   plusvibe_name_exact       (rank 6)
--   fuzzy_substring           (rank 7) — legacy/optional
--   unmatched                 (rank 99)
--
-- NULL = pre-v2 row (matcher version unknown). Backfill script treats
-- these as fuzzy_substring (rank 7) so any exact-layer match overrides them.

ALTER TABLE email_replies
  ADD COLUMN IF NOT EXISTS match_method TEXT;

COMMENT ON COLUMN email_replies.match_method IS
  'Layered matcher v2 layer name. See migration 036 header for allowed values. '
  'NULL = legacy row (pre-v2 matcher).';

CREATE INDEX IF NOT EXISTS idx_email_replies_tenant_match_method
  ON email_replies(tenant_id, match_method)
  WHERE match_method IS NOT NULL;
