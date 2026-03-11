-- Add progress_count to import_jobs for real-time progress tracking
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS progress_count INTEGER DEFAULT 0;
