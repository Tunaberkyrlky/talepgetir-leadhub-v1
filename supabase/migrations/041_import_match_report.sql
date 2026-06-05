-- ==========================================
-- Import Match Report — per-import matching audit
-- ==========================================
-- Adds a structured match report to each import job so users can verify, both
-- on the result screen and later in import history, which contact got linked to
-- which company and whether the company was newly created or matched to an
-- existing record (dedup by website domain).
--
-- Shape (JSONB, written by server/src/lib/importProcessor.ts):
--   {
--     version: 1,
--     summary: {
--       companiesCreated, companiesMatched,
--       contactsCreated, contactsSkippedDuplicate, contactsWithoutName,
--       rowsErrored
--     },
--     entries: [
--       { row, company, website, companyAction: 'created'|'matched', companyId,
--         contact, email, contactAction: 'created'|'skipped_duplicate'|'none' }
--     ],
--     entriesTruncated: boolean   -- entries capped for very large imports
--   }
--
-- Nullable: pre-existing import jobs simply have no report.

ALTER TABLE import_jobs
  ADD COLUMN IF NOT EXISTS match_report JSONB DEFAULT NULL;

COMMENT ON COLUMN import_jobs.match_report IS
  'Per-import matching audit: which contact linked to which company, created vs matched, plus skipped/duplicate counts. Powers the import result audit and history detail.';
