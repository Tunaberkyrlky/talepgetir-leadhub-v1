-- Allow 'matched' as a valid file_type for import_jobs
-- (used when two files are matched together via DataMatchFlow)

ALTER TABLE import_jobs
  DROP CONSTRAINT import_jobs_file_type_check;

ALTER TABLE import_jobs
  ADD CONSTRAINT import_jobs_file_type_check
    CHECK (file_type IN ('csv', 'xlsx', 'matched'));
