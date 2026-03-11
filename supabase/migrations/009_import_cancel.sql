-- Add cancelled flag to import_jobs for mid-import cancellation support
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS cancelled BOOLEAN DEFAULT FALSE;
