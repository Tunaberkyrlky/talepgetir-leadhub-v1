-- Add translations JSONB column to companies and contacts.
-- Stores user-triggered translations; original data is never modified.
-- Structure (companies): { "product_services": "...", "description": "...", "translated_at": "ISO8601" }
-- Structure (contacts):  { "title": "...", "notes": { "<note_id>": "..." }, "translated_at": "ISO8601" }

ALTER TABLE companies ADD COLUMN IF NOT EXISTS translations jsonb DEFAULT NULL;
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS translations jsonb DEFAULT NULL;
